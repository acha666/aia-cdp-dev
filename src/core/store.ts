export interface PutOptions {
  ifMatch?: string;
  ifNoneMatch?: "*";
}

export type PutResult = { ok: true; etag: string } | { ok: false; reason: "precondition-failed" };

export interface ObjectStore {
  get(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string } | null>;
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  delete(key: string): Promise<void>;
}

export async function readBlob(store: ObjectStore, key: string): Promise<Uint8Array<ArrayBuffer>> {
  const object = await store.get(key);
  if (object === null) {
    throw new Error(`The store has no blob ${key}`);
  }
  return object.bytes;
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function isStoreKeySegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

function isStoreKey(key: string): boolean {
  return key.split("/").every(isStoreKeySegment);
}

export function assertStoreKey(key: string): void {
  if (!isStoreKey(key)) {
    throw new TypeError(`Invalid store key: ${JSON.stringify(key)}`);
  }
}

export function assertStorePrefix(prefix: string): void {
  if (prefix !== "" && !(prefix.endsWith("/") && isStoreKey(prefix.slice(0, -1)))) {
    throw new TypeError(`Invalid store prefix: ${JSON.stringify(prefix)}`);
  }
}
