// R2 ObjectStore adapter.
//
// The bucket is typed structurally (R2BucketLike) instead of against the Workers global R2Bucket,
// so this file also compiles in the Node program (tests drive it through a fake bucket and through
// wrangler's getPlatformProxy). The Worker program proves the real binding fits:
// `new R2Store(env.STORE)` in src/runtime/worker.ts.
import { assertStoreKey, assertStorePrefix } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

/** R2's precondition object. Values are unquoted ETags or `*`; a quoted value throws TypeError. */
interface R2ConditionalLike {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

/** The subset of the Workers R2Bucket binding this adapter uses. */
export interface R2BucketLike {
  get(key: string): Promise<{ etag: string; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  /** Resolves to null (it does not throw) when `onlyIf` fails. */
  put(
    key: string,
    value: Uint8Array,
    options: { onlyIf?: R2ConditionalLike }
  ): Promise<{ etag: string } | null>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: readonly { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

/**
 * Store ETags are `R2Object.etag`: the unquoted content MD5. `httpEtag` is never read; passed back
 * to `onlyIf` it would throw TypeError instead of failing the precondition.
 */
export class R2Store implements ObjectStore {
  readonly #bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
  }

  async get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null> {
    assertStoreKey(key);
    const object = await this.#bucket.get(key);
    return object ? { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag } : null;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    assertStoreKey(key);
    // An unset field adds no condition; both together never succeed, as in the other adapters.
    const object = await this.#bucket.put(key, bytes, {
      onlyIf: { etagMatches: opts.ifMatch, etagDoesNotMatch: opts.ifNoneMatch },
    });
    // Any other failure (including R2's per-key write rate limit) is thrown, not mapped: the
    // catalog's retry loop only retries precondition failures.
    return object ? { ok: true, etag: object.etag } : { ok: false, reason: "precondition-failed" };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    const out: { key: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      // Pages hold up to 1000 objects in lexicographic key order (= code unit order for the ASCII
      // keys assertStoreKey allows).
      const page = await this.#bucket.list({ prefix, cursor });
      for (const object of page.objects) {
        out.push({ key: object.key, size: object.size });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return out;
  }

  async delete(key: string): Promise<void> {
    assertStoreKey(key);
    await this.#bucket.delete(key);
  }
}
