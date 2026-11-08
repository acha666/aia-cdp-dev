import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it, vi } from "vitest";
import { CATALOG_KEY, decodeJson, readCatalog } from "../../src/core/catalog.ts";
import type { CurrentCrl } from "../../src/core/catalog.ts";
import { crlHistoryKey, crlVersionName } from "../../src/core/history.ts";
import { SIGNATURE_ALG_NAMES } from "../../src/core/pki/constants.ts";
import { MAX_CRL_NUMBER_OCTETS } from "../../src/core/pki/extensions.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import type { PublishErrorCode } from "../../src/core/publish.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { buildCertificateSummary } from "../../src/core/summary.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { cert, crlEntry, fixture, manifest } from "../fixtures/pki.ts";
import { currentCrl } from "../helpers/catalog.ts";
import { generateCa, setupGeneratedCa, signCrl } from "../helpers/generated-ca.ts";
import { nullWithContents, padOid, pkiError, withOuterAlgorithm } from "../helpers/pki.ts";
import { downloadsOf, publish, publishFile, setupPublish, versionOf } from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import { flakyStore, puts, racingStore, recordingStore } from "../helpers/store.ts";

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

const engine = pkijs.getCrypto(true);

const entryOf = (file: string) => crlEntry(file.replace(/(?:\.crlf)?\.pem$/, ".der"));

const iso = (time: string) => new Date(time).toISOString();

async function fresh(options?: SetupOptions) {
  const base = new MemoryStore();
  const setup = await setupPublish(base, options);
  return { base, setup };
}

async function json(store: ObjectStore, key: string): Promise<unknown> {
  const object = await store.get(key);
  if (object === null) {
    throw new Error(`no ${key}`);
  }
  return decodeJson(object.bytes);
}

async function currentOf(store: ObjectStore, targetId: string): Promise<CurrentCrl | null> {
  return (await readCatalog(store)).catalog.targets[targetId]?.current ?? null;
}

async function keys(store: ObjectStore, prefix: string): Promise<string[]> {
  return (await store.list(prefix)).map((object) => object.key);
}

describe("publishCrl: the freshness rules on the manifest scenarios", () => {
  it.each(
    manifest.scenarios.map(
      (scenario) =>
        [scenario.current ?? "nothing", scenario.upload, scenario.outcome, scenario] as const
    )
  )("current %s, upload %s → %s", async (_current, upload, outcome, scenario) => {
    const { base, setup } = await fresh();
    const entry = entryOf(upload);
    const targetId = setup.target(entry.issuer, entry.kind);
    let before: CurrentCrl | null = null;
    if (scenario.current !== null) {
      expect((await publishFile(base, scenario.current)).result).toMatchObject({
        outcome: "created",
        targetId,
      });
      before = await currentOf(base, targetId);
    }
    const catalogBefore = await base.get(CATALOG_KEY);
    const store = recordingStore(base);
    const { result } = await publishFile(store, upload);

    if (outcome === "created" || outcome === "updated") {
      const current = await currentCrl(entry.file, targetId);
      expect(result).toMatchObject({ outcome, targetId, current });
      expect(await currentOf(base, targetId)).toEqual(current);
      if (before !== null) {
        expect(await json(base, crlHistoryKey(targetId, before.summary, before.sha256))).toEqual(
          before
        );
      }
      return;
    }
    expect(result).toEqual(
      outcome === "unchanged"
        ? {
            outcome,
            targetId,
            kind: entry.kind,
            issuer: cert(entry.issuer).sha256,
            current: before,
            downloads: downloadsOf(entry.issuer, entry.kind),
          }
        : { error: outcome, details: { current: versionOf(scenario.current!) } }
    );
    expect(store.writes).toEqual([]);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(catalogBefore!.bytes);
  });
});

const rogueCa = fixture(cert("rogue-ca").der);
const rogueKeyId = (await buildCertificateSummary(parseCertificate(rogueCa), rogueCa)).subjectKeyId;

describe("publishCrl: rejections", () => {
  const future = "crls/issuing-ca-1/full-future.der";

  it.each<[string, PublishErrorCode, object]>([
    ["invalid/garbage.txt", "invalid_crl", { reason: "der" }],
    [future, "not_yet_valid", { thisUpdate: iso(crlEntry(future).thisUpdate) }],
    ["crls/issuing-ca-1/full-idp-scoped.der", "scoped_crl_unsupported", { oid: "2.5.29.28" }],
    ["crls/issuing-ca-1/full-no-aki.der", "issuer_not_found", { reason: "missing_aki" }],
    ["crls/rogue-ca/full-01.der", "issuer_not_found", { authorityKeyId: rogueKeyId }],
    [
      "crls/issuing-ca-1/full-forged-aki.der",
      "invalid_signature",
      { algorithm: "sha256WithRSAEncryption" },
    ],
    ["crls/ed25519-ca/full-01.der", "unsupported_algorithm", { algorithm: "Ed25519" }],
  ])("answers %s with %s without writing", async (file, error, details) => {
    const { base } = await fresh();
    const store = recordingStore(base);
    expect((await publishFile(store, file)).result).toEqual({ error, details });
    expect(store.writes).toEqual([]);
  });

  it.each([
    [FULL_01, "an OID padded with 0x80", padOid],
    [ROOT_FULL_01, "an added NULL with contents", nullWithContents],
  ])("rejects %s with %s as invalid_crl, then takes the genuine file", async (file, _, rewrite) => {
    const { base } = await fresh();
    const store = recordingStore(base);
    expect((await publish(store, withOuterAlgorithm(fixture(file), rewrite))).result).toEqual({
      error: "invalid_crl",
      details: { reason: "signature_algorithm_mismatch" },
    });
    expect(store.writes).toEqual([]);
    expect((await publishFile(store, file)).result).toMatchObject({ outcome: "created" });
  });

  it("answers invalid_signature, not invalid_crl, for a revoked list of 50 000 NULLs", async () => {
    const { base } = await fresh();
    const crl = pkijs.CertificateRevocationList.fromBER(fixture(FULL_01));
    const schema = crl.toSchema(true) as asn1.Sequence;
    const fields = (schema.valueBlock.value[0] as asn1.Sequence).valueBlock.value;
    const revoked = fields.findIndex(
      (field, index) => field instanceof asn1.Sequence && fields[index - 1] instanceof asn1.UTCTime
    );
    fields[revoked] = new asn1.Sequence({
      value: Array.from({ length: 50_000 }, () => new asn1.Null()),
    });
    const junk = new Uint8Array(schema.toBER(false));
    expect(() => parseCRL(junk)).toThrow(pkiError("crl", "structure"));
    const store = recordingStore(base);
    expect((await publish(store, junk)).result).toEqual({
      error: "invalid_signature",
      details: { algorithm: SIGNATURE_ALG_NAMES[crl.signatureAlgorithm.algorithmId] },
    });
    expect(store.writes).toEqual([]);
  });

  it("answers invalid_crl for an outer signatureAlgorithm OID of 20 000 arcs", async () => {
    const { base } = await fresh();
    const oid = new asn1.ObjectIdentifier({ value: `1.2.${Array(20_000).fill(1).join(".")}` });
    const algorithm = new Uint8Array(new asn1.Sequence({ value: [oid] }).toBER(false));
    const store = recordingStore(base);
    const junk = withOuterAlgorithm(fixture(FULL_01), () => algorithm);
    expect((await publish(store, junk)).result).toEqual({
      error: "invalid_crl",
      details: { reason: "structure" },
    });
    expect(store.writes).toEqual([]);
  });
});

describe("publishCrl: issuer and target", () => {
  it("answers target_not_configured for a delta when the issuer only has a full target", async () => {
    const { base } = await fresh({ targets: [{ issuer: "issuing-ca-1", kind: "full" }] });
    const store = recordingStore(base);
    expect((await publishFile(store, DELTA_01)).result).toEqual({
      error: "target_not_configured",
      details: { kind: "delta", certificates: [cert("issuing-ca-1").sha256] },
    });
    expect(store.writes).toEqual([]);
  });

  it("verifies with the certificate each target names when a same-key renewal is imported", async () => {
    const { base, setup } = await fresh({
      certificates: ["root-ca", "issuing-ca-1", "issuing-ca-1-renewed"],
      targets: [
        { issuer: "issuing-ca-1", kind: "full" },
        { issuer: "issuing-ca-1-renewed", kind: "delta" },
      ],
    });
    const renewed = cert("issuing-ca-1-renewed").sha256;
    expect((await publishFile(base, DELTA_01)).result).toMatchObject({
      outcome: "created",
      targetId: setup.target("issuing-ca-1-renewed", "delta"),
      issuer: renewed,
      current: { verifier: renewed },
    });
    expect((await publishFile(base, FULL_01)).result).toMatchObject({
      outcome: "created",
      issuer: cert("issuing-ca-1").sha256,
      current: { verifier: cert("issuing-ca-1").sha256 },
    });
  });
});

describe("publishCrl: what an upload writes", () => {
  it("writes the blob create-only, then the catalog; current carries key, verifier and now", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    const store = recordingStore(base);
    const current = await currentCrl(FULL_01, targetId);

    const { result } = await publishFile(store, FULL_01);
    expect(puts(store)).toEqual([
      { key: current.key, opts: { ifNoneMatch: "*" }, ok: true },
      { key: CATALOG_KEY, opts: { ifMatch: expect.any(String) as unknown }, ok: true },
    ]);
    expect((await base.get(current.key))!.bytes).toEqual(fixture(FULL_01));
    expect(await currentOf(base, targetId)).toEqual(current);
    expect(result).toEqual({
      outcome: "created",
      targetId,
      kind: "full",
      issuer: cert("issuing-ca-1").sha256,
      current,
      downloads: downloadsOf("issuing-ca-1", "full"),
    });
  });

  it("records the superseded current as a history marker", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    await publishFile(base, FULL_01);
    const store = recordingStore(base);
    const { result } = await publishFile(store, FULL_02);
    const first = await currentCrl(FULL_01, targetId);
    const second = await currentCrl(FULL_02, targetId);
    const marker = crlHistoryKey(targetId, first.summary, first.sha256);
    expect(result).toMatchObject({ outcome: "updated", current: second });
    expect(puts(store)).toEqual([
      { key: second.key, opts: { ifNoneMatch: "*" }, ok: true },
      { key: marker, opts: { ifNoneMatch: "*" }, ok: true },
      { key: CATALOG_KEY, opts: { ifMatch: expect.any(String) as unknown }, ok: true },
    ]);
    expect(await keys(base, `blobs/crls/${targetId}/`)).toEqual([first.key, second.key]);
  });

  it("answers the bytes of the current CRL again with unchanged, before any parsing", async () => {
    const { base, setup } = await fresh();
    await publishFile(base, DELTA_01);
    const store = recordingStore(base);
    const verify = vi.spyOn(engine, "verifyWithPublicKey");
    const { result, record } = await publishFile(store, DELTA_01);
    expect(result).toMatchObject({
      outcome: "unchanged",
      current: await currentCrl(DELTA_01, setup.target("issuing-ca-1", "delta")),
    });
    expect(verify).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(record).toMatchObject({
      level: "info",
      outcome: "unchanged",
      kind: "delta",
      crlNumber: crlEntry(DELTA_01).crlNumber,
      attempts: 1,
    });
  });
});

describe("publishCrl: concurrent writers", () => {
  it("re-reads after a rival published between its state read and its catalog write", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    const store = recordingStore(racingStore(base, () => publishFile(base, FULL_01)));
    const run = await publishFile(store, FULL_02);
    const ours = await currentCrl(FULL_02, targetId);
    const rival = await currentCrl(FULL_01, targetId);
    const marker = crlHistoryKey(targetId, rival.summary, rival.sha256);

    expect(run.result).toMatchObject({ outcome: "updated", current: ours });
    expect(run.sleeps).toEqual([250]);
    expect(run.record.attempts).toBe(2);
    expect(await currentOf(base, targetId)).toEqual(ours);
    expect(await keys(base, "history/")).toEqual([marker]);
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [ours.key, true],
      [CATALOG_KEY, false],
      [marker, true],
      [CATALOG_KEY, true],
    ]);
  });

  it("gives up after 4 lost catalog writes with concurrent_update", async () => {
    const { base, setup } = await fresh();
    const targetId = setup.target("issuing-ca-1", "full");
    await publishFile(base, FULL_01);
    const before = await base.get(CATALOG_KEY);
    const store = recordingStore(flakyStore(base, { failIfMatch: 4 }));
    const run = await publishFile(store, FULL_02);
    expect(run.result).toEqual({ error: "concurrent_update" });
    expect(run.sleeps).toEqual([250, 500, 1000]);
    expect(run.record).toMatchObject({ level: "warn", reason: "concurrent_update", attempts: 4 });

    const first = await currentCrl(FULL_01, targetId);
    const second = await currentCrl(FULL_02, targetId);
    const marker = crlHistoryKey(targetId, first.summary, first.sha256);
    expect(puts(store).map((put) => [put.key, put.ok])).toEqual([
      [second.key, true],
      [marker, true],
      ...Array.from({ length: 4 }, () => [CATALOG_KEY, false]),
    ]);
    expect((await base.get(CATALOG_KEY))!.bytes).toEqual(before!.bytes);
    expect(await currentOf(base, targetId)).toEqual(first);
    expect(await json(base, marker)).toEqual(first);
  });
});

describe("publishCrl: the publish log line", () => {
  it("logs one line per call with what the call knew", async () => {
    const { base, setup } = await fresh();
    const entry = crlEntry(FULL_01);
    expect((await publishFile(base, FULL_01)).record).toEqual({
      level: "info",
      msg: "publish",
      targetId: setup.target("issuing-ca-1", "full"),
      kind: "full",
      outcome: "created",
      sha256: entry.sha256,
      crlNumber: entry.crlNumber,
      thisUpdate: iso(entry.thisUpdate),
      expired: false,
      attempts: 1,
      ms: expect.any(Number) as unknown,
    });
    const rejected = crlEntry("crls/issuing-ca-1/full-idp-scoped.der");
    expect((await publishFile(base, rejected.file)).record).toEqual({
      level: "warn",
      msg: "publish",
      kind: "full",
      reason: "scoped_crl_unsupported",
      sha256: rejected.sha256,
      crlNumber: rejected.crlNumber,
      thisUpdate: iso(rejected.thisUpdate),
      attempts: 1,
      ms: expect.any(Number) as unknown,
      detail: expect.stringContaining("Issuing Distribution Point") as unknown,
    });
  });
});

describe("publishCrl: CRLs of a generated CA", () => {
  const ca = generateCa();

  it("publishes a CRL with 3000 revoked entries, each with a reasonCode", async () => {
    const base = new MemoryStore();
    const targetId = await setupGeneratedCa(base, await ca);
    const der = await signCrl(await ca, { revoked: 3000 });
    expect((await publish(base, der)).result).toMatchObject({
      outcome: "created",
      targetId,
      current: { size: der.byteLength, summary: { revokedCount: 3000 } },
    });
  });

  it("publishes a CRL Number of MAX_CRL_NUMBER_OCTETS octets and refuses one more", async () => {
    const base = new MemoryStore();
    const targetId = await setupGeneratedCa(base, await ca);
    const largest = 2n ** BigInt(8 * MAX_CRL_NUMBER_OCTETS - 1) - 1n;
    const store = recordingStore(base);
    const refused = await publish(store, await signCrl(await ca, { crlNumber: largest + 1n }));
    expect(refused.result).toEqual({
      error: "invalid_crl",
      details: { reason: "extension_value" },
    });
    expect(refused.record.detail).toMatch(/Invalid CRL Number/);
    expect(store.writes).toEqual([]);

    const { result } = await publish(base, await signCrl(await ca, { crlNumber: largest }));
    expect(result).toMatchObject({
      outcome: "created",
      targetId,
      current: { summary: { crlNumber: largest.toString() } },
    });
    const { current } = result as { current: CurrentCrl };
    const name = crlVersionName(current.summary, current.sha256);
    expect(`.${name}.json.${crypto.randomUUID()}.tmp`.length).toBeLessThanOrEqual(255);
  });
});
