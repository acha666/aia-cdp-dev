import { describe, expect, it } from "vitest";
import { emptyConfig } from "../../src/core/catalog.ts";
import { getHistoryBlob, listHistory } from "../../src/core/history.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { crlEntry, fixture } from "../fixtures/pki.ts";
import { applyOver, publishFile, setupPublish } from "../helpers/publish.ts";

const FILES = ["full-01", "full-02", "full-03"].map((name) => `crls/issuing-ca-1/${name}.der`);

async function published() {
  const store = new MemoryStore();
  const setup = await setupPublish(store, { targets: [{ issuer: "issuing-ca-1", kind: "full" }] });
  for (const file of FILES) {
    expect((await publishFile(store, file)).result).toHaveProperty("outcome");
  }
  return { store, setup, targetId: setup.target("issuing-ca-1", "full") };
}

function entryOf(file: string, current: boolean) {
  const { sha256, crlNumber, thisUpdate } = crlEntry(file);
  return {
    sha256,
    crlNumber,
    thisUpdate: new Date(thisUpdate).toISOString(),
    size: fixture(file).byteLength,
    current,
  };
}

async function removeTargets(store: MemoryStore): Promise<void> {
  expect(await applyOver(store, emptyConfig())).toHaveProperty("config");
}

describe("listHistory", () => {
  it("lists every published version newest first, the current one marked", async () => {
    const { store, targetId } = await published();
    expect(await listHistory({ store }, targetId)).toEqual({
      targetId,
      configured: true,
      entries: [entryOf(FILES[2]!, true), entryOf(FILES[1]!, false), entryOf(FILES[0]!, false)],
    });
  });

  it("leaves out orphan blobs and keys of another shape", async () => {
    const { store, targetId } = await published();
    const orphan = crlEntry("crls/issuing-ca-1/full-04-older-time.der");
    const name = `20251231000000Z-${orphan.crlNumber}-${orphan.sha256}`;
    await store.put(`blobs/crls/${targetId}/${name}.der`, new Uint8Array([0x30, 0]));
    await store.put(`blobs/crls/${targetId}/notes.txt`, new Uint8Array([1]));
    await store.put(`history/${targetId}/notes.json`, new Uint8Array([1]));
    const history = await listHistory({ store }, targetId);
    expect("entries" in history && history.entries.map((entry) => entry.sha256)).toEqual(
      [...FILES].reverse().map((file) => crlEntry(file).sha256)
    );
  });

  it("keeps a removed (retired) target's history, with nothing current", async () => {
    const { store, targetId } = await published();
    await removeTargets(store);
    expect(await listHistory({ store }, targetId)).toEqual({
      targetId,
      configured: false,
      entries: [entryOf(FILES[2]!, false), entryOf(FILES[1]!, false), entryOf(FILES[0]!, false)],
    });
  });

  it("is empty for a configured target that never published, not_found for an unknown one", async () => {
    const store = new MemoryStore();
    const setup = await setupPublish(store, {
      targets: [{ issuer: "issuing-ca-1", kind: "full" }],
    });
    const targetId = setup.target("issuing-ca-1", "full");
    expect(await listHistory({ store }, targetId)).toEqual({
      targetId,
      configured: true,
      entries: [],
    });
    expect(await listHistory({ store }, crypto.randomUUID())).toEqual({ error: "not_found" });
  });
});

describe("getHistoryBlob", () => {
  it("returns the DER of a superseded version, also after the target is removed", async () => {
    const { store, targetId } = await published();
    await removeTargets(store);
    const found = await getHistoryBlob({ store }, targetId, crlEntry(FILES[0]!).sha256);
    expect(found).toEqual({ entry: entryOf(FILES[0]!, false), der: fixture(FILES[0]!) });
  });

  it("is not_found for a digest outside the history", async () => {
    const { store, targetId } = await published();
    const other = crlEntry("crls/issuing-ca-2/full-01.der").sha256;
    expect(await getHistoryBlob({ store }, targetId, other)).toEqual({ error: "not_found" });
  });
});
