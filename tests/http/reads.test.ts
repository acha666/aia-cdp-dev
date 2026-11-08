import { describe, expect, it } from "vitest";
import { CONFIG_KEY, readState } from "../../src/core/catalog.ts";
import { CertificateListItem, CrlTargetListItem } from "../../src/http/schemas.ts";
import { cert, crlEntry, fixture, NOW } from "../fixtures/pki.ts";
import { logRecords, patchStore } from "../helpers/app.ts";
import { DEFAULT_TARGETS, downloadsOf, IMPORTED } from "../helpers/publish.ts";
import type { SetupOptions } from "../helpers/publish.ts";
import { errorOf, expectInternal, okJson, readService } from "../helpers/reads.ts";
import type { ReadService } from "../helpers/reads.ts";

const CERTIFICATES = "/api/v1/certificates";
const CRLS = "/api/v1/crls";
const BLOBS = "/api/v1/blobs";
const ROOT = "root-ca";
const ISSUING = "issuing-ca-1";
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const FULL_ADCS = "crls/issuing-ca-1/full-adcs.der";
const ROOT_LABEL = "Example Root CA";

const certificateList = async (app: ReadService["app"]) =>
  okJson(await app.request(CERTIFICATES), CertificateListItem.array());
const targetList = async (app: ReadService["app"]) =>
  okJson(await app.request(CRLS), CrlTargetListItem.array());

const SERVED: SetupOptions = {
  configure: (config) => {
    const root = cert(ROOT).sha256;
    config.certificates[root] = { label: ROOT_LABEL };
    config.paths["/ca/root-ca.crt"] = { certificate: root };
    config.paths["/ca/root-ca-alias.crt"] = { certificate: root };
  },
};
const served = await readService({ setup: SERVED });

const ADCS_PUBLISHED = [FULL_ADCS, "crls/issuing-ca-1/delta-adcs.der", "crls/root-ca/full-01.der"];
const adcs = await readService({ publish: ADCS_PUBLISHED });

const replaced = await readService({ publish: [FULL_01, FULL_02] });

describe("GET /api/v1/certificates", () => {
  it("lists every imported certificate in id order with label, summary, downloads and targets", async () => {
    const { catalog } = await readState(served.base);
    const items = await certificateList(served.app);
    expect(items.map((item) => item.id)).toEqual(IMPORTED.map((name) => cert(name).sha256).sort());

    const root = cert(ROOT);
    expect(items.find((item) => item.id === root.sha256)).toEqual({
      id: root.sha256,
      label: ROOT_LABEL,
      importedAt: NOW.toISOString(),
      size: fixture(root.der).byteLength,
      summary: catalog.certificates[root.sha256]?.summary,
      downloads: [
        "/ca/root-ca-alias.crt",
        "/ca/root-ca-alias.crt.pem",
        "/ca/root-ca.crt",
        "/ca/root-ca.crt.pem",
      ],
      targets: [
        { targetId: served.setup.target(ROOT, "full"), kind: "full", label: `${ROOT} full` },
      ],
    });
    const issuing = items.find((item) => item.id === cert(ISSUING).sha256);
    expect(issuing).toMatchObject({ label: null, downloads: [] });
    const targets = [
      { targetId: served.setup.target(ISSUING, "full"), kind: "full", label: `${ISSUING} full` },
      {
        targetId: served.setup.target(ISSUING, "delta"),
        kind: "delta",
        label: `${ISSUING} delta`,
      },
    ].sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
    expect(issuing?.targets).toEqual(targets);
  });
});

describe("GET /api/v1/crls", () => {
  const targetOf = (file: string) => {
    const entry = crlEntry(file);
    return adcs.setup.target(entry.issuer, entry.kind);
  };

  it("lists every configured target in targetId order, unpublished ones with current: null", async () => {
    const items = await targetList(adcs.app);
    const ids = DEFAULT_TARGETS.map((spec) => adcs.setup.target(spec.issuer, spec.kind));
    expect(items.map((item) => item.targetId)).toEqual(ids.sort());
    const publishedIds = new Set(ADCS_PUBLISHED.map((file) => targetOf(file)));
    for (const item of items) {
      expect(item.current === null, item.targetId).toBe(!publishedIds.has(item.targetId));
    }
  });

  it("carries kind, label, issuer, downloads and the current CRL without its key", async () => {
    const { catalog } = await readState(adcs.base);
    const targetId = targetOf(FULL_ADCS);
    const issuer = cert(ISSUING).sha256;
    const item = (await targetList(adcs.app)).find((each) => each.targetId === targetId);
    expect(item).toEqual({
      targetId,
      kind: "full",
      label: `${ISSUING} full`,
      issuer: {
        id: issuer,
        label: null,
        subjectCN: catalog.certificates[issuer]?.summary.subjectCN,
      },
      downloads: downloadsOf(ISSUING, "full"),
      current: {
        sha256: crlEntry(FULL_ADCS).sha256,
        size: fixture(FULL_ADCS).byteLength,
        publishedAt: NOW.toISOString(),
        verifier: issuer,
        summary: catalog.targets[targetId]?.current?.summary,
      },
    });
    expect(item?.current?.summary.nextPublish).toBe(
      new Date(crlEntry(FULL_ADCS).nextPublish!).toISOString()
    );
  });
});

describe("the lists without config.json", () => {
  const PUBLISHED = [
    FULL_01,
    "crls/issuing-ca-1/delta-01.der",
    FULL_02,
    "crls/issuing-ca-1/delta-02.der",
    "crls/issuing-ca-1/full-03.der",
    "crls/root-ca/full-01.der",
  ];

  it("list the catalog alone, and no targets", async () => {
    const service = await readService({ publish: PUBLISHED });
    await service.base.delete(CONFIG_KEY);
    const certificates = await certificateList(service.app);
    expect(certificates.map((item) => item.id)).toEqual(
      IMPORTED.map((name) => cert(name).sha256).sort()
    );
    for (const item of certificates) {
      expect(item).toMatchObject({ label: null, downloads: [], targets: [] });
    }
    expect(await targetList(service.app)).toEqual([]);
  });
});

describe("GET /api/v1/blobs/{sha256}", () => {
  async function expectDer(res: Response, contentType: string, der: Uint8Array) {
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(contentType);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(der);
  }

  it("serves an imported certificate as application/pkix-cert, its id in either case", async () => {
    const root = cert(ROOT);
    for (const id of [root.sha256, root.sha256.toUpperCase()]) {
      await expectDer(
        await replaced.app.request(`${BLOBS}/${id}`),
        "application/pkix-cert",
        fixture(root.der)
      );
    }
  });

  it("serves a current CRL as application/pkix-crl, but not the version it replaced", async () => {
    await expectDer(
      await replaced.app.request(`${BLOBS}/${crlEntry(FULL_02).sha256}`),
      "application/pkix-crl",
      fixture(FULL_02)
    );
    const old = crlEntry(FULL_01).sha256;
    await errorOf(await replaced.app.request(`${BLOBS}/${old}`), 404, "not_found");
  });

  it.each([
    ["not hex", "z".repeat(64)],
    ["63 digits", "a".repeat(63)],
    ["the DER file name", `${"a".repeat(64)}.der`],
    ["a malformed escape", "%ZZ"],
  ])("rejects %s with 400 bad_request", async (_case, sha256) => {
    const res = await replaced.app.request(`${BLOBS}/${sha256}`);
    const error = await errorOf(res, 400, "bad_request");
    expect(error.details).toMatchObject({ target: "param" });
  });

  it("answers 404 for a certificate that was never imported", async () => {
    const id = cert("leaf-min").sha256;
    await errorOf(await replaced.app.request(`${BLOBS}/${id}`), 404, "not_found");
  });

  it("answers 500 for a current CRL whose blob is gone, without leaking the key", async () => {
    const own = await readService({ publish: [FULL_01] });
    const target = own.setup.target(ISSUING, "full");
    const key = (await readState(own.base)).catalog.targets[target]?.current?.key ?? "";
    await own.base.delete(key);
    await expectInternal(await own.app.request(`${BLOBS}/${crlEntry(FULL_01).sha256}`), key);
  });
});

describe("a failing store", () => {
  const PATHS = [CERTIFICATES, CRLS, `${BLOBS}/${cert(ROOT).sha256}`];

  it("is a 500 envelope on every read, never 200 [] or the exception text", async () => {
    const secret = "private storage details";
    const service = await readService({
      wrap: (base) => patchStore({ get: () => Promise.reject(new Error(secret)) }, base),
    });
    for (const path of PATHS) {
      await expectInternal(await service.app.request(path), secret);
      expect(logRecords(service.deps).at(-2), path).toMatchObject({
        level: "error",
        msg: "unhandled_error",
        path,
      });
    }
  });
});
