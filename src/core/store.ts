/**
 * The object storage contract shared by the R2, disk and in-memory backends.
 *
 * @packageDocumentation
 */

/** Conditional-write preconditions, evaluated against the stored object's ETag. */
export interface PutOptions {
  ifMatch?: string;
  ifNoneMatch?: "*";
}

/** A failed precondition is a result, not an error, so callers can retry or report it. */
export type PutResult = { ok: true; etag: string } | { ok: false; reason: "precondition-failed" };

/**
 * A flat key-value blob store with ETags and conditional writes.
 *
 * Keys are `/`-separated segments that satisfy {@link isStoreKeySegment}.
 */
export interface ObjectStore {
  get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null>;
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  /** Lists every object under `prefix`, which is `""` or ends in `/`. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Deletes `key`; deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * Reads an object that the catalog says exists.
 *
 * @throws Error if the object is missing, which means the store is inconsistent.
 */
export async function readBlob(store: ObjectStore, key: string): Promise<Uint8Array<ArrayBuffer>> {
  const object = await store.get(key);
  if (object === null) {
    throw new Error(`The store has no blob ${key}`);
  }
  return object.bytes;
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Whether `segment` is a valid key segment: no leading dot, so no `.`, `..` or hidden files. */
export function isStoreKeySegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

function isStoreKey(key: string): boolean {
  return key.split("/").every(isStoreKeySegment);
}

/** @throws TypeError if `key` is not a valid store key. */
export function assertStoreKey(key: string): void {
  if (!isStoreKey(key)) {
    throw new TypeError(`Invalid store key: ${JSON.stringify(key)}`);
  }
}

/** @throws TypeError if `prefix` is neither `""` nor a valid key followed by `/`. */
export function assertStorePrefix(prefix: string): void {
  if (prefix !== "" && !(prefix.endsWith("/") && isStoreKey(prefix.slice(0, -1)))) {
    throw new TypeError(`Invalid store prefix: ${JSON.stringify(prefix)}`);
  }
}
