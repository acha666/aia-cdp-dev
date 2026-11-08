import { describe, expect, it } from "vitest";
import { CATALOG_KEY, certificateBlobKey, readCatalog } from "../../src/core/catalog.ts";
import { importCertificate } from "../../src/core/certificates.ts";
import type { ImportResult } from "../../src/core/certificates.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { cert, fixture, NOW } from "../fixtures/pki.ts";
import { certificateEntry } from "../helpers/catalog.ts";
import { puts, racingStore, recordingStore } from "../helpers/store.ts";
import type { RecordingStore } from "../helpers/store.ts";

function importInto(store: ObjectStore, bytes: Uint8Array, now: Date = NOW) {
  return importCertificate({ store, now: () => now, sleep: async () => undefined }, bytes);
}

async function storedCertificates(store: ObjectStore) {
  return (await readCatalog(store)).catalog.certificates;
}

describe("importCertificate", () => {
  it("imports DER, then answers the same certificate as PEM with unchanged and no write", async () => {
    const base = new MemoryStore();
    const store = recordingStore(base);
    const { id, entry } = await certificateEntry("issuing-ca-1");
    const der = fixture(cert("issuing-ca-1").der);

    expect(await importInto(store, der)).toEqual({ outcome: "created", id, entry });
    expect(entry.key).toBe(`blobs/certificates/${id}.der`);
    expect(puts(store)).toEqual([
      { key: certificateBlobKey(id), opts: { ifNoneMatch: "*" }, ok: true },
      { key: CATALOG_KEY, opts: { ifNoneMatch: "*" }, ok: true },
    ]);
    expect((await base.get(certificateBlobKey(id)))!.bytes).toEqual(der);
    expect(await storedCertificates(base)).toEqual({ [id]: entry });

    store.writes.length = 0;
    const later = new Date(NOW.getTime() + 86_400_000);
    const pem = fixture(cert("issuing-ca-1").pem);
    expect(await importInto(store, pem, later)).toEqual({ outcome: "unchanged", id, entry });
    expect(store.writes).toEqual([]);
  });

  it("ends two concurrent imports of one certificate as created + unchanged", async () => {
    const base = new MemoryStore();
    const der = fixture(cert("root-ca").der);
    let rival: ImportResult | undefined;
    const store: RecordingStore = recordingStore(
      racingStore(base, async () => {
        rival = await importInto(store, der);
      })
    );
    const ours = await importInto(store, der);
    const { id, entry } = await certificateEntry("root-ca");
    expect([ours, rival]).toEqual([
      { outcome: "unchanged", id, entry },
      { outcome: "created", id, entry },
    ]);
    expect(await storedCertificates(base)).toEqual({ [id]: entry });
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [certificateBlobKey(id), true],
      [certificateBlobKey(id), false],
      [CATALOG_KEY, true],
      [CATALOG_KEY, false],
    ]);
  });
});
