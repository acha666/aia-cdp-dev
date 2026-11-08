import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { sha256Hex } from "../core/digest.ts";
import { assertStoreKey, assertStorePrefix, isStoreKeySegment } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

/** Serializes writes to the same file within this process. */
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

/**
 * Stores each key as a file under `root`. The ETag is the SHA-256 of the content; writes
 * go through a temporary file and a rename, so readers never see a partial object.
 *
 * Conditional writes are atomic only within one process, so a data directory must not be
 * shared by several servers.
 */
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
      const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, copy, { flag: "wx", flush: true });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      await fsyncDirectory(dir);
      return { ok: true, etag };
    });
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    const base = prefix === "" ? this.#root : this.#path(prefix.slice(0, -1));
    // Temporary files and anything else that is not a valid key are skipped.
    const names = await orMissing(readdir(base, { recursive: true }), []);
    const objects = await Promise.all(
      names.sort().map(async (name) => {
        const segments = name.split(sep);
        if (!segments.every(isStoreKeySegment)) {
          return null;
        }
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
