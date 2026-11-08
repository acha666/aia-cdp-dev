import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlatformProxy } from "wrangler";
import { R2Store } from "../../src/storage/r2.ts";
import type { R2BucketLike } from "../../src/storage/r2.ts";
import { describeObjectStore } from "./conformance.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe.runIf(process.env.AIA_TEST_R2 === "1")("R2Store via getPlatformProxy", () => {
  let proxy: PlatformProxy<{ STORE: R2BucketLike }> | undefined;
  let store: R2Store;

  beforeAll(async () => {
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.WRANGLER_HIDE_BANNER = "true";
    const { getPlatformProxy } = await import("wrangler");
    proxy = await getPlatformProxy<{ STORE: R2BucketLike }>({
      configPath: "wrangler.jsonc",
      persist: false,
    });
    store = new R2Store(proxy.env.STORE);
  }, 60_000);

  afterAll(async () => {
    await proxy?.dispose();
  });

  beforeEach(async () => {
    for (const object of await store.list("")) {
      await store.delete(object.key);
    }
  });

  describeObjectStore("r2 (getPlatformProxy)", () => store);

  it("follows list cursors across 1001 keys", { timeout: 60_000 }, async () => {
    const keys = Array.from(
      { length: 1001 },
      (_, index) => `blobs/certificates/${String(index).padStart(4, "0")}.der`
    );
    for (let start = 0; start < keys.length; start += 50) {
      const batch = keys.slice(start, start + 50);
      const results = await Promise.all(batch.map((key) => store.put(key, bytes(key))));
      expect(results.every((result) => result.ok)).toBe(true);
    }
    const listed = await store.list("blobs/");
    expect(listed.map((object) => object.key)).toEqual(keys);
    expect(listed.every((object) => object.size === 27)).toBe(true);

    for (let start = 0; start < keys.length; start += 50) {
      await Promise.all(keys.slice(start, start + 50).map((key) => store.delete(key)));
    }
  });
});
