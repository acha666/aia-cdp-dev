import { chmod, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FsStore } from "../../src/storage/fs.ts";
import { describeObjectStore } from "./conformance.ts";

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const isRoot = process.getuid?.() === 0;

let parent: string;

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "aia-cdp-fs-store-"));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

function freshDir(): Promise<string> {
  return mkdtemp(join(parent, "case-"));
}

const bytes = (text: string) => new TextEncoder().encode(text);

describeObjectStore("fs", async () => new FsStore(await freshDir()));

describe("FsStore", () => {
  it("stores key a/b/c as the file <root>/a/b/c and reads it back after a restart", async () => {
    const root = await freshDir();
    const created = await new FsStore(root).put("blobs/crls/t1/x.der", bytes("crl"), {
      ifNoneMatch: "*",
    });
    if (!created.ok) {
      throw new Error("put failed");
    }
    expect(
      new TextDecoder().decode(await readFile(join(root, "blobs", "crls", "t1", "x.der")))
    ).toBe("crl");

    const second = new FsStore(root);
    const got = await second.get("blobs/crls/t1/x.der");
    expect(got?.etag).toBe(created.etag);
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes("crl")));
    expect(
      (await second.put("blobs/crls/t1/x.der", bytes("crl2"), { ifMatch: created.etag })).ok
    ).toBe(true);
  });

  it("keeps the old content and no temporary file when a write fails", async () => {
    const root = await freshDir();
    const store = new FsStore(root);
    expect((await store.put("config.json", bytes("old"))).ok).toBe(true);
    const failure = Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    vi.mocked(rename).mockRejectedValueOnce(failure);

    await expect(store.put("config.json", bytes("new"))).rejects.toBe(failure);
    expect(await readdir(root)).toEqual(["config.json"]);
    expect(new TextDecoder().decode((await store.get("config.json"))!.bytes)).toBe("old");
  });

  it.skipIf(isRoot)("throws on an unreadable root instead of reporting a missing key", async () => {
    const root = await freshDir();
    const store = new FsStore(root);
    expect((await store.put("config.json", bytes("{}"))).ok).toBe(true);
    await chmod(root, 0o000);
    try {
      await expect(store.get("config.json")).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(root, 0o700);
    }
  });
});
