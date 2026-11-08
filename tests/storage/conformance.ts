// ObjectStore conformance suite. Every adapter runs the same cases; the factory hands
// each case an empty store.
import { beforeEach, describe, expect, it } from "vitest";
import type { ObjectStore } from "../../src/core/store.ts";

/** Keys every adapter rejects with TypeError. */
const INVALID_KEYS: readonly string[] = [
  "",
  "/a",
  "a//b",
  "../a",
  "a/./b",
  ".a",
  "a\\b",
  "a\0b",
  "a/",
  "a/../b",
  "blobs/.tmp",
  "C:\\x",
];

/** Prefixes every adapter's list() rejects with TypeError. */
const INVALID_PREFIXES: readonly string[] = [
  "blobs",
  "/a/",
  "a//",
  "../",
  "./",
  "a\\b/",
  "a\0/",
  "/",
  "a/b",
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

async function text(store: ObjectStore, key: string): Promise<string | null> {
  const object = await store.get(key);
  return object ? decoder.decode(object.bytes) : null;
}

async function etagOf(store: ObjectStore, key: string, value: string): Promise<string> {
  const result = await store.put(key, bytesOf(value));
  if (!result.ok) {
    throw new Error(`put ${key} failed`);
  }
  return result.etag;
}

const REFUSED = { ok: false, reason: "precondition-failed" };

export function describeObjectStore(
  name: string,
  factory: () => ObjectStore | Promise<ObjectStore>
): void {
  describe(`ObjectStore conformance: ${name}`, () => {
    let store: ObjectStore;

    beforeEach(async () => {
      store = await factory();
    });

    it("returns null for a missing key and deletes it without error", async () => {
      expect(await store.get("config.json")).toBeNull();
      await expect(store.delete("blobs/certificates/missing.der")).resolves.toBeUndefined();
      expect(await store.list("")).toEqual([]);
    });

    it("stores bytes unconditionally, reports the same ETag on get, and replaces", async () => {
      const result = await store.put("blobs/certificates/a.der", new Uint8Array([0, 1, 254, 255]));
      if (!result.ok) {
        throw new Error("unconditional put failed");
      }
      const got = await store.get("blobs/certificates/a.der");
      expect(Array.from(got!.bytes)).toEqual([0, 1, 254, 255]);
      expect(got!.etag).toBe(result.etag);

      expect((await store.put("blobs/certificates/a.der", bytesOf("replaced"))).ok).toBe(true);
      expect(await text(store, "blobs/certificates/a.der")).toBe("replaced");
    });

    it('creates with ifNoneMatch: "*" only when the key is missing', async () => {
      const options = { ifNoneMatch: "*" } as const;
      expect((await store.put("blobs/crls/t1/x.der", bytesOf("first"), options)).ok).toBe(true);
      expect(await store.put("blobs/crls/t1/x.der", bytesOf("second"), options)).toEqual(REFUSED);
      expect(await text(store, "blobs/crls/t1/x.der")).toBe("first");
    });

    it("replaces with ifMatch on the current ETag only, and changes the ETag", async () => {
      const first = await etagOf(store, "catalog.json", "v1");
      const second = await store.put("catalog.json", bytesOf("v2"), { ifMatch: first });
      if (!second.ok) {
        throw new Error("ifMatch with the ETag returned by put failed");
      }
      expect(second.etag).not.toBe(first);
      const fromGet = (await store.get("catalog.json"))!.etag;
      expect(fromGet).toBe(second.etag);
      expect((await store.put("catalog.json", bytesOf("v3"), { ifMatch: fromGet })).ok).toBe(true);

      expect(await store.put("catalog.json", bytesOf("v4"), { ifMatch: first })).toEqual(REFUSED);
      expect(await text(store, "catalog.json")).toBe("v3");
    });

    it("refuses ifMatch on a missing key", async () => {
      const elsewhere = await etagOf(store, "config.json", "v1");
      for (const ifMatch of [elsewhere, ""]) {
        expect(await store.put("catalog.json", bytesOf("v1"), { ifMatch })).toEqual(REFUSED);
      }
      expect(await store.get("catalog.json")).toBeNull();
    });

    it("lets exactly one of five concurrent puts with the same ifMatch win", async () => {
      const base = await etagOf(store, "catalog.json", "base");
      // Distinct payloads: an adapter whose ETag follows the content would let identical writes
      // all succeed against the unchanged ETag.
      const payloads = ["w0", "w1", "w2", "w3", "w4"];
      const results = await Promise.all(
        payloads.map((payload) => store.put("catalog.json", bytesOf(payload), { ifMatch: base }))
      );
      const winners = results.flatMap((result, index) => (result.ok ? [index] : []));
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual(
        Array.from({ length: 4 }, () => REFUSED)
      );
      const got = (await store.get("catalog.json"))!;
      expect(decoder.decode(got.bytes)).toBe(payloads[winners[0]!]);
      expect(got.etag).toBe((results[winners[0]!] as { etag: string }).etag);
    });

    it("lists a prefix recursively, with sizes, sorted by key; deleted keys are gone", async () => {
      const objects: Record<string, string> = {
        "history/t1/20260104000000Z-3-ab.json": "{}",
        "blobs/crls/t1/20260104000000Z-3-ab.der": "crl-3",
        "blobsX/stray.der": "x",
        "config.json": '{"version":1}',
        "blobs/certificates/ff.der": "cert-ff",
        "blobs/certificates/0a.der": "c0a",
      };
      for (const [key, value] of Object.entries(objects)) {
        expect((await store.put(key, bytesOf(value))).ok).toBe(true);
      }
      const expected = (prefix: string) =>
        Object.keys(objects)
          .filter((key) => key.startsWith(prefix))
          .sort()
          .map((key) => ({ key, size: encoder.encode(objects[key]).byteLength }));
      for (const prefix of ["", "blobs/", "blobs/crls/t1/", "history/", "nothing/"]) {
        expect(await store.list(prefix), prefix).toEqual(expected(prefix));
      }

      await store.delete("blobs/certificates/0a.der");
      delete objects["blobs/certificates/0a.der"];
      expect(await store.get("blobs/certificates/0a.der")).toBeNull();
      expect(await store.list("blobs/")).toEqual(expected("blobs/"));
      const recreated = await store.put("blobs/certificates/0a.der", bytesOf("again"), {
        ifNoneMatch: "*",
      });
      expect(recreated.ok).toBe(true);
    });

    it("rejects invalid keys and prefixes with TypeError and leaves the store unchanged", async () => {
      expect((await store.put("config.json", bytesOf("keep"))).ok).toBe(true);
      for (const key of INVALID_KEYS) {
        const label = JSON.stringify(key);
        await expect(store.get(key), `get(${label})`).rejects.toThrow(TypeError);
        await expect(store.put(key, bytesOf("x")), `put(${label})`).rejects.toThrow(TypeError);
        await expect(store.delete(key), `delete(${label})`).rejects.toThrow(TypeError);
      }
      for (const prefix of INVALID_PREFIXES) {
        const label = JSON.stringify(prefix);
        await expect(store.list(prefix), `list(${label})`).rejects.toThrow(TypeError);
      }
      expect(await store.list("")).toEqual([{ key: "config.json", size: 4 }]);
    });
  });
}
