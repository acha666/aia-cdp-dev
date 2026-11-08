import { describe, expect, it } from "vitest";
import { CONFIG_KEY, encodeJson } from "../../src/core/catalog.ts";
import type { Config } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { cert, crlEntry, fixture, fixtureText, NOW } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { certificateEntry } from "../helpers/catalog.ts";
import { errorOf, readService } from "../helpers/reads.ts";
import { flakyStore, opaqueEtagStore } from "../helpers/store.ts";

const TOKEN = "admin-s3cret-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const CERTIFICATES = "/api/v1/admin/certificates";
const CONFIG = "/api/v1/admin/config";
const SOME_TARGET = crypto.randomUUID();

type Body = RequestInit["body"];

function setup(overrides: TestOverrides = {}) {
  const deps = testDeps({
    ...overrides,
    settings: { adminToken: TOKEN, ...overrides.settings },
  });
  return { app: createApp(deps), deps };
}

type App = ReturnType<typeof setup>["app"];

function der(name: string): Uint8Array<ArrayBuffer> {
  return fixture(cert(name).der);
}

function post(app: App, body: Body, contentType?: string) {
  const headers = new Headers(AUTH);
  if (contentType !== undefined) {
    headers.set("Content-Type", contentType);
  }
  return app.request(CERTIFICATES, { method: "POST", body, headers });
}

function put(app: App, body: string, headers: Record<string, string>) {
  return app.request(CONFIG, {
    method: "PUT",
    body,
    headers: { ...AUTH, "Content-Type": "application/json", ...headers },
  });
}

async function etagOf(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return `"${await sha256Hex(data)}"`;
}

function rootConfig(label = "Root CA"): Config {
  const id = cert("root-ca").sha256;
  return {
    version: 1,
    certificates: { [id]: { label } },
    targets: {},
    paths: { "/ca/root-ca.crt": { certificate: id } },
  };
}

describe("admin gate", () => {
  const routes: [method: string, path: string][] = [
    ["POST", CERTIFICATES],
    ["DELETE", `${CERTIFICATES}/${cert("root-ca").sha256}`],
    ["GET", CONFIG],
    ["PUT", CONFIG],
    ["GET", `/api/v1/admin/crls/${SOME_TARGET}/history`],
    ["GET", `/api/v1/admin/crls/${SOME_TARGET}/history/${cert("root-ca").sha256}`],
  ];

  it.each(routes)(
    "%s %s → 503 admin_disabled while no token is configured",
    async (method, path) => {
      const { app } = setup({ settings: { adminToken: undefined } });
      for (const headers of [{}, AUTH]) {
        const res = await app.request(path, { method, headers });
        await errorOf(res, 503, "admin_disabled");
      }
    }
  );

  it.each<[string, Record<string, string>, string]>([
    ["no token", {}, 'Bearer realm=""'],
    ["a wrong token", { Authorization: "Bearer wrong-token" }, 'Bearer error="invalid_token"'],
  ])("answers %s with 401 + WWW-Authenticate", async (_, auth, challenge) => {
    const { app, deps } = setup();
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, headers: auth });
      expect(res.headers.get("WWW-Authenticate")).toBe(challenge);
      expect(await errorOf(res, 401, "unauthorized")).toMatchObject({ message: "Unauthorized" });
    }
    expect(await deps.store.list("")).toEqual([]);
  });
});

describe("POST /api/v1/admin/certificates", () => {
  it("imports DER as 201 created, then the same certificate as PEM as 200 unchanged", async () => {
    const { app } = setup();
    const { id, entry } = await certificateEntry("issuing-ca-1");
    const expected = {
      id,
      size: entry.size,
      importedAt: NOW.toISOString(),
      summary: entry.summary,
    };

    const created = await post(app, der("issuing-ca-1"), "application/pkix-cert");
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    expect(created.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await created.json()).toEqual({ outcome: "created", ...expected });

    const unchanged = await post(
      app,
      fixtureText(cert("issuing-ca-1").pem),
      "application/x-pem-file"
    );
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toEqual({ outcome: "unchanged", ...expected });
  });

  it("answers an empty body with 400", async () => {
    const { app } = setup();
    const res = await post(app, new Uint8Array(0), "application/pkix-cert");
    await errorOf(res, 400, "bad_request");
  });

  it.each([["text/plain"], [undefined]])(
    "answers a body sent as %s with 415",
    async (contentType) => {
      const { app, deps } = setup();
      const res = await post(app, der("root-ca"), contentType);
      expect(await errorOf(res, 415, "unsupported_media_type")).toEqual({
        code: "unsupported_media_type",
        message:
          "Send the certificate as application/pkix-cert, application/x-pem-file or " +
          "application/octet-stream",
        details: {
          received: contentType ?? null,
          accepted: ["application/pkix-cert", "application/x-pem-file", "application/octet-stream"],
        },
      });
      expect(await deps.store.list("")).toEqual([]);
    }
  );

  it("answers garbage with 422 invalid_certificate and its reason", async () => {
    const { app, deps } = setup();
    const res = await post(app, fixture("invalid/garbage.txt"), "application/octet-stream");
    expect(await errorOf(res, 422, "invalid_certificate")).toEqual({
      code: "invalid_certificate",
      message: "Not a valid X.509 certificate",
      details: { reason: "der" },
    });
    expect(await deps.store.list("")).toEqual([]);
  });

  it("answers 409 concurrent_update when every catalog write is lost", async () => {
    const base = new MemoryStore();
    const first = setup({ store: base }).app;
    expect((await post(first, der("root-ca"), "application/pkix-cert")).status).toBe(201);
    const { app } = setup({ store: flakyStore(base, { failIfMatch: 4 }) });
    const res = await post(app, der("issuing-ca-1"), "application/pkix-cert");
    await errorOf(res, 409, "concurrent_update");
  });
});

describe("GET /api/v1/admin/config", () => {
  it("answers 404 while nothing is configured", async () => {
    const { app } = setup();
    const res = await app.request(CONFIG, { headers: AUTH });
    await errorOf(res, 404, "not_found");
  });

  it("returns the stored bytes as they are, even when invalid; its ETag replaces them", async () => {
    const store = new MemoryStore();
    const stored = '{"version":1, "tagrets": {}}';
    await putText(store, CONFIG_KEY, stored);
    const { app } = setup({ store });
    const res = await app.request(CONFIG, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBe(await etagOf(stored));
    expect(await res.text()).toBe(stored);

    const head = await app.request(CONFIG, { method: "HEAD", headers: AUTH });
    expect(head.headers.get("ETag")).toBe(await etagOf(stored));
    expect(await head.text()).toBe("");

    const replaced = await put(app, MINIMAL_CONFIG, { "If-Match": await etagOf(stored) });
    expect(replaced.status).toBe(200);
  });
});

describe("PUT /api/v1/admin/config", () => {
  it("applies the first configuration with If-None-Match: *, then replaces it with If-Match", async () => {
    const { app } = setup({ store: opaqueEtagStore() });
    expect((await post(app, der("root-ca"), "application/pkix-cert")).status).toBe(201);

    const first = await put(app, JSON.stringify(rootConfig()), { "If-None-Match": "*" });
    const firstBytes = encodeJson(rootConfig());
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Content-Type")).toBe("application/json");
    expect(first.headers.get("ETag")).toBe(await etagOf(firstBytes));
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(firstBytes);
    const got = await app.request(CONFIG, { headers: AUTH });
    expect(got.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(firstBytes);

    const second = await put(app, JSON.stringify(rootConfig("Root")), {
      "If-Match": first.headers.get("ETag") ?? "",
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).toBe(await etagOf(encodeJson(rootConfig("Root"))));

    const stale = await put(app, MINIMAL_CONFIG, { "If-Match": first.headers.get("ETag") ?? "" });
    await errorOf(stale, 412, "precondition_failed");
  });

  it.each<[string, Record<string, string>]>([
    ["no precondition", {}],
    ["both preconditions", { "If-Match": '"x"', "If-None-Match": "*" }],
  ])("answers %s with 428 precondition_required", async (_, headers) => {
    const { app, deps } = setup();
    const res = await put(app, MINIMAL_CONFIG, headers);
    await errorOf(res, 428, "precondition_required");
    expect(await deps.store.list("")).toEqual([]);
  });

  it("answers If-Match while nothing is configured, and If-None-Match: * afterwards, with 412", async () => {
    const { app, deps } = setup();
    const invalid = JSON.stringify(rootConfig());
    const early = await put(app, invalid, { "If-Match": await etagOf(MINIMAL_CONFIG) });
    await errorOf(early, 412, "precondition_failed");
    expect(await deps.store.get(CONFIG_KEY)).toBeNull();

    expect((await put(app, MINIMAL_CONFIG, { "If-None-Match": "*" })).status).toBe(200);
    const again = await put(app, invalid, { "If-None-Match": "*" });
    await errorOf(again, 412, "precondition_failed");
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an empty JSON body", ""],
  ])("answers %s with 400 bad_request", async (_, body) => {
    const { app } = setup();
    const res = await put(app, body, { "If-None-Match": "*" });
    await errorOf(res, 400, "bad_request");
  });

  it("answers a body that is not JSON by type with 415", async () => {
    const { app } = setup();
    const res = await put(app, MINIMAL_CONFIG, {
      "If-None-Match": "*",
      "Content-Type": "text/plain",
    });
    await errorOf(res, 415, "unsupported_media_type");
  });

  it("answers a rule violation with 422 config_invalid and its issues", async () => {
    const { app, deps } = setup();
    const config = rootConfig();
    config.paths["/ca/root ca.crt"] = { certificate: cert("root-ca").sha256 };
    const res = await put(app, JSON.stringify(config), { "If-None-Match": "*" });
    const error = await errorOf(res, 422, "config_invalid");
    expect(error.message).toBe("The configuration is invalid");
    expect((error.details as { issues: unknown[] }).issues).not.toHaveLength(0);
    expect(await deps.store.get(CONFIG_KEY)).toBeNull();
  });
});

describe("DELETE /api/v1/admin/certificates/{id}", () => {
  it("answers 204, then 404; a referenced certificate is 409", async () => {
    const { app } = await readService({ overrides: { settings: { adminToken: TOKEN } } });
    await post(app, der("leaf-min"), "application/pkix-cert");
    const leaf = cert("leaf-min").sha256;
    const del = (id: string) =>
      app.request(`${CERTIFICATES}/${id}`, { method: "DELETE", headers: AUTH });

    const deleted = await del(leaf.toUpperCase());
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("Cache-Control")).toBe("no-store");
    expect(await deleted.text()).toBe("");
    await errorOf(await del(leaf), 404, "not_found");

    await errorOf(await del(cert("root-ca").sha256), 409, "referenced");
    await errorOf(await del("not-a-digest"), 400, "bad_request");
  });
});

describe("GET /api/v1/admin/crls/{targetId}/history", () => {
  const FULL_01 = "crls/issuing-ca-1/full-01.der";
  const FULL_02 = "crls/issuing-ca-1/full-02.der";

  async function withHistory() {
    const service = await readService({
      publish: [FULL_01, FULL_02],
      overrides: { settings: { adminToken: TOKEN } },
    });
    return { app: service.app, targetId: service.setup.target("issuing-ca-1", "full") };
  }

  it("lists the versions, and serves one as an attachment", async () => {
    const { app, targetId } = await withHistory();
    const listed = await app.request(`/api/v1/admin/crls/${targetId.toUpperCase()}/history`, {
      headers: AUTH,
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("no-store");
    const body = (await listed.json()) as { targetId: string; entries: { sha256: string }[] };
    expect(body.targetId).toBe(targetId);
    expect(body.entries.map((entry) => entry.sha256)).toEqual(
      [FULL_02, FULL_01].map((file) => crlEntry(file).sha256)
    );

    const sha256 = crlEntry(FULL_01).sha256;
    const res = await app.request(`/api/v1/admin/crls/${targetId}/history/${sha256}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/pkix-crl",
      "content-disposition": `attachment; filename="${sha256}.crl"`,
      "content-length": String(fixture(FULL_01).byteLength),
      "cache-control": "no-store",
    });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixture(FULL_01));
  });

  it("answers an unknown target or version with 404", async () => {
    const { app, targetId } = await withHistory();
    const history = (id: string) => `/api/v1/admin/crls/${id}/history`;
    await errorOf(await app.request(history(SOME_TARGET), { headers: AUTH }), 404, "not_found");
    const unknown = `${history(targetId)}/${"0".repeat(64)}`;
    await errorOf(await app.request(unknown, { headers: AUTH }), 404, "not_found");
  });
});
