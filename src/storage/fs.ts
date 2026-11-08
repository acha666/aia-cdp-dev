// Filesystem ObjectStore adapter for the Node runtime. One data directory belongs to one process:
// conditional writes are serialized by an in-process per-key mutex.
//
// Layout: key `a/b/c` is the file `<root>/a/b/c`. assertStoreKey is the path traversal guard (no
// empty, `.`/`..` or dot-leading segment, no `\` or NUL), so every path stays below the root and no
// key can name a temporary file. A key cannot also be the directory of other keys here; the keys
// the service writes never are. Anything else in the directory (an operator's `a (copy).der`, an
// editor's `x.der~`, `lost+found` at the root of a volume) is not a key: list() skips it. list()
// reads every directory below its prefix, so one it cannot read fails it.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { sha256Hex } from "../core/digest.ts";
import { assertStoreKey, assertStorePrefix, isStoreKeySegment } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

// Keyed by absolute file path, so two FsStore instances on one directory share the lock.
const locks = new Map<string, Promise<void>>();

async function exclusive<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(path);
  const { promise, resolve: release } = Promise.withResolvers<void>();
  locks.set(path, promise);
  try {
    await previous;
    return await task();
  } finally {
    release();
    if (locks.get(path) === promise) {
      locks.delete(path);
    }
  }
}

/** `task`'s value, or `fallback` when the file or directory does not exist (ENOENT). */
async function orMissing<T, F>(task: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await task;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** ETag = content SHA-256 (lowercase hex). */
export class FsStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    return join(this.#root, ...key.split("/"));
  }

  async #read(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const buffer = await orMissing(readFile(path), null);
    return buffer && new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> {
    assertStoreKey(key);
    const bytes = await this.#read(this.#path(key));
    return bytes ? { bytes, etag: await sha256Hex(bytes) } : null;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    assertStoreKey(key);
    // Copy before the first await so later changes to the caller's buffer cannot leak in.
    const copy = bytes.slice();
    const etag = await sha256Hex(copy);
    const path = this.#path(key);
    return exclusive(path, async (): Promise<PutResult> => {
      if (opts.ifMatch !== undefined || opts.ifNoneMatch === "*") {
        const current = await this.#read(path);
        const currentEtag = current ? await sha256Hex(current) : undefined;
        if (opts.ifNoneMatch === "*" && currentEtag !== undefined) {
          return { ok: false, reason: "precondition-failed" };
        }
        if (opts.ifMatch !== undefined && currentEtag !== opts.ifMatch) {
          return { ok: false, reason: "precondition-failed" };
        }
      }

      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      // The dot-leading name keeps the temporary file out of list() and out of the key space.
      const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        // flush: the data is synced to disk before the file is renamed into place.
        await writeFile(temp, copy, { flag: "wx", flush: true });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      // The renamed entry must be durable before ok.
      await fsyncDirectory(dir);
      return { ok: true, etag };
    });
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    // A valid prefix is whole segments plus `/`, so its keys all live below one directory.
    const base = prefix === "" ? this.#root : this.#path(prefix.slice(0, -1));
    const names = await orMissing(readdir(base, { recursive: true }), []);
    // With sep "/", the names sort as their keys do.
    const objects = await Promise.all(
      names.sort().map(async (name) => {
        const segments = name.split(sep);
        // Only paths made of key segments: no temporary file (dot-leading), no stray file and
        // nothing below a directory whose name is not a key segment.
        if (!segments.every(isStoreKeySegment)) {
          return null;
        }
        // stat follows a symbolic link to a file, as get() does; a directory is not a key. null:
        // deleted between readdir and stat (or a dangling link).
        const info = await orMissing(stat(join(base, name)), null);
        return info?.isFile() ? { key: prefix + segments.join("/"), size: info.size } : null;
      })
    );
    return objects.filter((object) => object !== null);
  }

  async delete(key: string): Promise<void> {
    assertStoreKey(key);
    const path = this.#path(key);
    await exclusive(path, () => rm(path, { force: true }));
  }
}
