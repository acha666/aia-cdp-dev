import { describe, expect, it } from "vitest";
import { CRL_MEDIA_TYPES } from "../../src/http/schemas.ts";
import { cert, crlEntry, fixture, fixtureText } from "../fixtures/pki.ts";
import { currentCrl } from "../helpers/catalog.ts";
import { downloadsOf, versionOf } from "../helpers/publish.ts";
import type { PublishSetup } from "../helpers/publish.ts";
import { errorOf, expectInternal, readService } from "../helpers/reads.ts";
import type { ReadService } from "../helpers/reads.ts";
import { flakyStore } from "../helpers/store.ts";

const CRLS = "/api/v1/crls";
const TOKEN = "upload-s3cret-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ROOT_FULL_01 = "crls/root-ca/full-01.der";
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const FULL_02 = "crls/issuing-ca-1/full-02.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";

type HeaderFields = NonNullable<RequestInit["headers"]>;
type Body = RequestInit["body"];

type App = ReadService["app"];

const served = await readService({ publish: [FULL_02] });

function upload(app: App, body: Body, contentType?: string, headers: HeaderFields = {}) {
  const all = new Headers(headers);
  if (contentType !== undefined) {
    all.set("Content-Type", contentType);
  }
  return app.request(CRLS, { method: "POST", body, headers: all });
}

function uploadFile(app: App, file: string, headers: HeaderFields = {}) {
  return upload(app, fixture(file), "application/pkix-crl", headers);
}

async function publishedBody(file: string, setup: PublishSetup) {
  const entry = crlEntry(file);
  const target = setup.target(entry.issuer, entry.kind);
  const current = await currentCrl(file, target);
  const { crlNumber, baseCrlNumber, thisUpdate, nextUpdate } = current.summary;
  return {
    outcome: "created",
    target,
    kind: entry.kind,
    sha256: entry.sha256,
    crlNumber,
    baseCrlNumber,
    thisUpdate,
    nextUpdate,
    issuer: cert(entry.issuer).sha256,
    downloads: downloadsOf(entry.issuer, entry.kind),
  };
}

describe("POST /api/v1/crls: bodies", () => {
  it("publishes the body as sent; the repeat is 200 unchanged", async () => {
    const { app, base, setup } = await readService();
    const der = fixture(ROOT_FULL_01);
    const expected = await publishedBody(ROOT_FULL_01, setup);
    expect(expected.downloads).toEqual(["/crl/root-ca.crl", "/crl/root-ca.crl.pem"]);

    const created = await upload(app, der, "application/pkix-crl");
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    expect(await created.json()).toEqual(expected);
    const current = await currentCrl(ROOT_FULL_01, expected.target);
    expect((await base.get(current.key))?.bytes).toEqual(der);

    const again = await upload(app, der, "application/pkix-crl");
    expect(again.status).toBe(200);
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(await again.json()).toEqual({ ...expected, outcome: "unchanged" });
  });

  it.each<[string, string, () => Uint8Array<ArrayBuffer> | string]>([
    ["application/x-pem-file", "PEM", () => fixtureText("crls/issuing-ca-1/full-01.pem")],
    ["application/octet-stream", "DER", () => fixture(FULL_01)],
  ])("takes a raw %s body (%s), recognizing the bytes", async (contentType, _, body) => {
    const { app, setup } = await readService();
    const res = await upload(app, body(), contentType);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(await publishedBody(FULL_01, setup));
  });

  it.each<[string, Body]>([
    ["an empty body", new Uint8Array(0)],
    ["no body", null],
  ])("answers a raw upload with %s with 400", async (_, body) => {
    const res = await upload(served.app, body, "application/pkix-crl");
    expect(await errorOf(res, 400, "bad_request")).toEqual({
      code: "bad_request",
      message: "Expected a CRL, but the upload is empty",
    });
  });

  it.each<[string, string | undefined, string | null]>([
    ["text/plain", "text/plain; charset=utf-8", "text/plain"],
    ["multipart/form-data", "multipart/form-data; boundary=xyz", "multipart/form-data"],
    ["no Content-Type", undefined, null],
  ])("answers a body sent as %s with 415 and what it received", async (_, type, received) => {
    const { app, base } = served;
    const before = await base.list("");
    const res = await upload(app, fixture(FULL_01), type);
    expect(await errorOf(res, 415, "unsupported_media_type")).toMatchObject({
      code: "unsupported_media_type",
      details: { received, accepted: [...CRL_MEDIA_TYPES] },
    });
    expect(await base.list("")).toEqual(before);
  });
});

describe("POST /api/v1/crls: token and size", () => {
  it("needs no token while AIA_UPLOAD_TOKEN is unset, and ignores an Authorization header", async () => {
    const { app } = await readService();
    expect((await uploadFile(app, ROOT_FULL_01)).status).toBe(201);
    const res = await uploadFile(app, FULL_01, { Authorization: "Basic eA==" });
    expect(res.status).toBe(201);
  });

  it.each<[string, Record<string, string>, string]>([
    ["no token", {}, 'Bearer realm=""'],
    ["a wrong token", { Authorization: "Bearer wrong-token" }, 'Bearer error="invalid_token"'],
  ])("answers %s with 401 + WWW-Authenticate once a token is set", async (_, auth, challenge) => {
    const { app, base, setup } = await readService({
      overrides: { settings: { uploadToken: TOKEN } },
    });
    const before = await base.list("");
    const res = await uploadFile(app, ROOT_FULL_01, auth);
    expect(res.headers.get("WWW-Authenticate")).toBe(challenge);
    expect(await errorOf(res, 401, "unauthorized")).toMatchObject({ message: "Unauthorized" });
    expect(await base.list("")).toEqual(before);

    const authorized = await uploadFile(app, ROOT_FULL_01, AUTH);
    expect(authorized.status).toBe(201);
    expect(await authorized.json()).toEqual(await publishedBody(ROOT_FULL_01, setup));
  });

  it("checks the token, then the media type, then the size", async () => {
    const settings = { uploadToken: TOKEN, maxUploadBytes: 16 };
    const { app } = await readService({ overrides: { settings } });
    const body = () => new Uint8Array(1024);
    expect((await upload(app, body(), "text/plain")).status).toBe(401);
    expect((await upload(app, body(), "text/plain", AUTH)).status).toBe(415);
    expect((await upload(app, body(), "application/pkix-crl", AUTH)).status).toBe(413);
  });

  it("answers 413 for a streamed body without Content-Length over AIA_MAX_UPLOAD_BYTES", async () => {
    const { app, base } = await readService({ overrides: { settings: { maxUploadBytes: 64 } } });
    const before = await base.list("");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const res = await app.request(CRLS, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/pkix-crl" },
      duplex: "half",
    });
    expect(await errorOf(res, 413, "payload_too_large")).toMatchObject({
      message: "Payload too large",
    });
    expect(await base.list("")).toEqual(before);
  });
});

describe("POST /api/v1/crls: outcomes", () => {
  const CURRENT = { current: versionOf(FULL_02) };

  it.each<[number, string, string, string, unknown]>([
    [409, "stale_crl", FULL_01, "The CRL is older than the target's current CRL", CURRENT],
    [
      409,
      "conflict",
      "crls/issuing-ca-1/full-02-conflict.der",
      "The target's current CRL has other bytes for the same CRL Number and thisUpdate",
      CURRENT,
    ],
    [
      409,
      "non_orderable",
      "crls/issuing-ca-1/full-no-number.der",
      "Only one of the CRL and the target's current CRL has a CRL Number",
      CURRENT,
    ],
    [422, "invalid_crl", "invalid/garbage.txt", "Not a valid X.509 CRL", { reason: "der" }],
    [
      422,
      "issuer_not_found",
      "crls/issuing-ca-1/full-no-aki.der",
      "The CRL has no Authority Key Identifier keyIdentifier",
      { reason: "missing_aki" },
    ],
  ])("answers %i %s for %s", async (status, code, file, message, details) => {
    const res = await uploadFile(served.app, file);
    expect(await errorOf(res, status, code)).toEqual({ code, message, details });
  });

  it("answers 422 target_not_configured with the kind and the matching certificates", async () => {
    const { app } = await readService({
      setup: { targets: [{ issuer: "issuing-ca-1", kind: "full" }] },
    });
    const res = await uploadFile(app, DELTA_01);
    expect(await errorOf(res, 422, "target_not_configured")).toEqual({
      code: "target_not_configured",
      message: "No configured target of the CRL's kind names its issuer",
      details: { kind: "delta", certificates: [cert("issuing-ca-1").sha256] },
    });
  });

  it("answers 409 concurrent_update without details when every catalog write is lost", async () => {
    const { app } = await readService({ wrap: (base) => flakyStore(base, { failIfMatch: 4 }) });
    const res = await uploadFile(app, FULL_01);
    expect(await errorOf(res, 409, "concurrent_update")).toEqual({
      code: "concurrent_update",
      message: "The catalog kept changing concurrently: retry the upload",
    });
  });

  it("answers 500 internal without the exception text when the store fails", async () => {
    const secret = "disk on fire at /var/lib/secret-path";
    const { app } = await readService({
      wrap: (base) => flakyStore(base, { putError: new Error(secret) }),
    });
    await expectInternal(await uploadFile(app, FULL_01), "disk on fire");
  });
});
