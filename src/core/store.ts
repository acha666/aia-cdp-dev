// ObjectStore port, implemented by src/storage/{memory,fs,r2}.ts.
// ETags are opaque and only ever passed back to the same adapter; they are never used as HTTP
// ETags (those always come from the content SHA-256), and HTTP If-Match values never reach a store.

export interface PutOptions {
  /** Replace: the current ETag must be equal. */
  ifMatch?: string;
  /** Create: the key must not exist. */
  ifNoneMatch?: "*";
}

export type PutResult = { ok: true; etag: string } | { ok: false; reason: "precondition-failed" };

export interface ObjectStore {
  /**
   * `bytes` is backed by an ArrayBuffer, so it goes to WebCrypto and into a Response body as
   * it is; it may be a view into a larger buffer.
   */
  get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null>;
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  /** Admin only. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Admin only. */
  delete(key: string): Promise<void>;
}

/**
 * The bytes at `key`, a blob that catalog.json names: a missing one is a broken store, not a bad
 * request, and throws (the HTTP layer answers its generic 500).
 */
export async function readBlob(store: ObjectStore, key: string): Promise<Uint8Array<ArrayBuffer>> {
  const object = await store.get(key);
  if (object === null) {
    throw new Error(`The store has no blob ${key}`);
  }
  return object.bytes;
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * One segment of a store key. The fs adapter also uses it on directory entries: names that fail
 * it (temporary files, `lost+found`, `a (copy).der`) are never keys.
 */
export function isStoreKeySegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

function isStoreKey(key: string): boolean {
  return key.split("/").every(isStoreKeySegment);
}

/**
 * Every adapter calls this before get / put / delete (it is also the fs adapter's path traversal
 * guard). A key is one or more `/`-separated segments matching
 * `[A-Za-z0-9_-][A-Za-z0-9._-]*`: no empty key or segment, no `.` / `..` or other leading dot, no
 * absolute path, backslash or NUL. Every key the service writes qualifies.
 */
export function assertStoreKey(key: string): void {
  if (!isStoreKey(key)) {
    throw new TypeError(`Invalid store key: ${JSON.stringify(key)}`);
  }
}

/**
 * Every adapter's list() calls this first. A prefix is `""` (everything; tests use it to empty a
 * bucket) or one or more valid key segments followed by `/` (`blobs/`, `history/<targetId>/`).
 */
export function assertStorePrefix(prefix: string): void {
  if (prefix !== "" && !(prefix.endsWith("/") && isStoreKey(prefix.slice(0, -1)))) {
    throw new TypeError(`Invalid store prefix: ${JSON.stringify(prefix)}`);
  }
}
