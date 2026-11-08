import { assertStoreKey, assertStorePrefix } from "../core/store.ts";
import type { ObjectStore, PutOptions, PutResult } from "../core/store.ts";

interface R2ConditionalLike {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

/** The part of the R2 bucket binding that {@link R2Store} uses. */
export interface R2BucketLike {
  get(key: string): Promise<{ etag: string; arrayBuffer(): Promise<ArrayBuffer> } | null>;
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

/** Stores objects in a Cloudflare R2 bucket, using R2's conditional puts. */
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
    const object = await this.#bucket.put(key, bytes, {
      onlyIf: { etagMatches: opts.ifMatch, etagDoesNotMatch: opts.ifNoneMatch },
    });
    return object ? { ok: true, etag: object.etag } : { ok: false, reason: "precondition-failed" };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertStorePrefix(prefix);
    const out: { key: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
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
