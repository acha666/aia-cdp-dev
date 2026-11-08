import { describe, expect, it } from "vitest";
import { certificateBlobKey } from "../../src/core/catalog.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { derToPem } from "../../src/core/pki/pem.ts";
import { createApp } from "../../src/http/app.ts";
import { cert, crlEntry, fixture, NOW } from "../fixtures/pki.ts";
import { patchStore, testDeps } from "../helpers/app.ts";
import { expectInternal, readService } from "../helpers/reads.ts";
import type { ReadServiceOptions } from "../helpers/reads.ts";
import { opaqueEtagStore } from "../helpers/store.ts";

const ROOT = cert("root-ca");
const ISSUING = cert("issuing-ca-1");
const FULL_01 = "crls/issuing-ca-1/full-01.der";
const DELTA_01 = "crls/issuing-ca-1/delta-01.der";
const FULL = crlEntry(FULL_01);
const IMMUTABLE = "public, max-age=31536000, immutable";
const HOUR = 3_600_000;

const P = {
  root: "/ca/root-ca.crt",
  rootAlias: "/ca/root.cer",
  nested: "/ca/sub/root-ca.crt",
  issuing: "/ca/issuing-ca-1.crt",
  full: "/crl/issuing-ca-1.crl",
  delta: "/dcrl/issuing-ca-1.crl",
  unpublished: "/crl/root-ca.crl",
} as const;

const OPTIONS: ReadServiceOptions = {
  setup: {
    configure: (config) => {
      for (const path of [P.root, P.rootAlias, P.nested]) {
        config.paths[path] = { certificate: ROOT.sha256 };
      }
      config.paths[P.issuing] = { certificate: ISSUING.sha256 };
    },
  },
  publish: [FULL_01, DELTA_01],
};

const served = await readService(OPTIONS);

function requester(failGet?: (key: string) => boolean, base: ObjectStore = served.base) {
  const opaque = opaqueEtagStore(base);
  const store = patchStore(
    {
      get: async (key) => {
        if (failGet?.(key)) {
          throw new Error(`private storage details of ${key}`);
        }
        return opaque.get(key);
      },
    },
    opaque
  );
  const app = createApp(
    testDeps({
      store,
      now: () => new Date(NOW.getTime() + HOUR),
      ui: () =>
        new Response("<!doctype html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    })
  );
  return (path: string, init?: RequestInit) => app.request(`http://localhost${path}`, init);
}

const request = requester();

const blobless = requester((key) => key.startsWith("blobs/"));

const DOWNLOAD_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
];

function headersOf(res: Response): Record<string, string> {
  return Object.fromEntries(
    DOWNLOAD_HEADERS.flatMap((name) => {
      const value = res.headers.get(name);
      return value === null ? [] : [[name, value]];
    })
  );
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("bytes", () => {
  it.each([
    [P.root, fixture(ROOT.der)],
    [`${P.root}.pem`, fixture(ROOT.pem)],
    [P.rootAlias, fixture(ROOT.der)],
    [P.nested, fixture(ROOT.der)],
    [P.full, fixture(FULL_01)],
    [`${P.full}.pem`, fixture(FULL_01.replace(/\.der$/, ".pem"))],
    [`${P.delta}.pem`, new TextEncoder().encode(derToPem(fixture(DELTA_01), "crl"))],
  ])("GET %s sends the stored DER or the PEM derived from it", async (path, body) => {
    const res = await request(path);
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(body);
    expect(res.headers.get("Content-Length")).toBe(String(body.byteLength));
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${path.split("/").at(-1) ?? ""}"`
    );
  });
});

describe("headers", () => {
  it("certificate DER, GET: immutable, the digest as ETag, the path's file name", async () => {
    const res = await request(P.root);
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      "cache-control": IMMUTABLE,
      "content-disposition": 'attachment; filename="root-ca.crt"',
      "content-length": String(fixture(ROOT.der).byteLength),
      "content-type": "application/pkix-cert",
      etag: `"${ROOT.sha256}"`,
      "last-modified": NOW.toUTCString(),
    });
  });

  it("certificate PEM, HEAD: every header, no body, the blob not read", async () => {
    const res = await blobless(`${P.root}.pem`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      "cache-control": IMMUTABLE,
      "content-disposition": 'attachment; filename="root-ca.crt.pem"',
      "content-length": String(fixture(ROOT.pem).byteLength),
      "content-type": "application/x-pem-file",
      etag: `"${ROOT.sha256}-pem"`,
      "last-modified": NOW.toUTCString(),
    });
    expect(await res.text()).toBe("");
  });

  it("CRL DER, GET (nextUpdate 4 days after NOW → max-age 3600)", async () => {
    const res = await request(P.full);
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      "cache-control": "public, max-age=3600, must-revalidate",
      "content-disposition": 'attachment; filename="issuing-ca-1.crl"',
      "content-length": String(fixture(FULL_01).byteLength),
      "content-type": "application/pkix-crl",
      etag: `"${FULL.sha256}"`,
      "last-modified": NOW.toUTCString(),
    });
  });
});

describe("If-None-Match", () => {
  const der = `"${ROOT.sha256}"`;
  const pem = `"${ROOT.sha256}-pem"`;

  it.each([
    ["the exact ETag", P.root, der],
    ["a weak ETag", P.root, `W/${der}`],
    ["a list with a weak member", P.root, ` "other" , W/${der} `],
    ["*", P.root, "*"],
    ["* with spaces", P.root, "  * "],
    ["the PEM ETag on the PEM path", `${P.root}.pem`, pem],
    ["the CRL's ETag", P.full, `"${FULL.sha256}"`],
  ])("%s → 304 with ETag and Cache-Control only, the blob not read", async (_, path, header) => {
    for (const method of ["GET", "HEAD"]) {
      const res = await blobless(path, { method, headers: { "If-None-Match": header } });
      expect(res.status, method).toBe(304);
      expect(await res.text(), method).toBe("");
      expect(Object.keys(headersOf(res)), method).toEqual(["cache-control", "etag"]);
    }
  });

  it.each([
    ["another ETag", P.root, `"${ISSUING.sha256}"`],
    ["the PEM ETag on the DER path", P.root, pem],
    ["the DER ETag on the PEM path", `${P.root}.pem`, der],
    ["a lowercase w/", P.root, `w/${der}`],
    ["* in a list", P.root, '"x", *'],
    ["an empty header", P.root, ""],
  ])("%s → 200 with the body", async (_, path, header) => {
    const res = await request(path, { headers: { "If-None-Match": header } });
    expect(res.status).toBe(200);
    expect((await bytesOf(res)).byteLength).toBe(Number(res.headers.get("Content-Length")));
  });
});

describe("text/plain 404 and 405", () => {
  it.each([
    ["an unknown path", "/ca/unknown.crt"],
    ["a second .pem", `${P.root}.pem.pem`],
    ["another case", "/ca/Root-CA.crt"],
    ["an uppercase .PEM", `${P.root}.PEM`],
    [".pem in place of the extension", "/ca/root-ca.pem"],
    ["an encoded slash in a served nested path", "/ca/sub%2Froot-ca.crt"],
    ["an encoded parent segment", "/ca/..%2Fconfig.json"],
    ["a double slash", "/ca//root-ca.crt"],
    ["a trailing slash", `${P.root}/`],
    ["the prefix with a slash", "/ca/"],
    ["/crl alone", "/crl"],
    ["a target that was never published", P.unpublished],
  ])("%s: %s, never the ui, never 304", async (_, path) => {
    for (const method of ["GET", "HEAD"]) {
      for (const headers of [{}, { "If-None-Match": "*" }]) {
        const res = await blobless(path, { method, headers });
        expect(res.status, method).toBe(404);
        expect(res.headers.get("Content-Type"), method).toMatch(/^text\/plain/);
        expect(res.headers.get("Cache-Control"), method).toBe("no-store");
        expect(await res.text(), method).toBe(method === "GET" ? "Not Found" : "");
      }
    }
  });

  it.each(["POST", "PUT", "DELETE"])(
    "%s on a download path → 405 Allow: GET, HEAD, before any read",
    async (method) => {
      const failing = requester(() => true);
      for (const path of [P.root, `${P.root}.pem`, P.full, "/crl/missing.crl", "/ca"]) {
        const res = await failing(path, { method });
        expect(res.status, path).toBe(405);
        expect(res.headers.get("Allow"), path).toBe("GET, HEAD");
        expect(res.headers.get("Content-Type"), path).toMatch(/^text\/plain/);
        expect(res.headers.get("Cache-Control"), path).toBe("no-store");
        expect(await res.text(), path).toBe("Method Not Allowed");
      }
    }
  );
});

describe("500", () => {
  it("blob missing → 500 for GET; HEAD still answers from the catalog", async () => {
    const own = await readService(OPTIONS);
    await own.base.delete(certificateBlobKey(ROOT.sha256));
    const ownRequest = requester(undefined, own.base);
    await expectInternal(await ownRequest(P.root), "blobs/");
    expect((await ownRequest(P.root, { method: "HEAD" })).status).toBe(200);
  });
});
