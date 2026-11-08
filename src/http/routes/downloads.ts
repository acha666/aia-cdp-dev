import { Hono } from "hono";
import type { Context } from "hono";
import { readState } from "../../core/catalog.ts";
import { derToPem } from "../../core/pki/pem.ts";
import { downloadHeaders, ifNoneMatchHit, pemKind, resolveDownload } from "../../core/resources.ts";
import { readBlob } from "../../core/store.ts";
import type { AppDeps } from "../types.ts";
import { textNotFound } from "../ui.ts";

const DOWNLOAD_ROUTES = ["/ca/*", "/crl/*", "/dcrl/*"] as const;

async function serveDownload(c: Context, deps: AppDeps): Promise<Response> {
  const path = c.req.path;
  const { config, catalog } = await readState(deps.store);
  const resolution = resolveDownload(config, catalog, path);
  if (resolution.status === "not_found") {
    return textNotFound(c);
  }
  if (resolution.status === "inconsistent") {
    throw new Error(`The store cannot back the path entry ${JSON.stringify(resolution.reference)}`);
  }

  const headers = downloadHeaders(resolution, deps.now());
  if (ifNoneMatchHit(c.req.header("If-None-Match"), headers.ETag)) {
    return c.body(null, 304, { ETag: headers.ETag, "Cache-Control": headers["Cache-Control"] });
  }
  if (c.req.method === "HEAD") {
    return c.body(null, 200, { ...headers });
  }

  const der = await readBlob(deps.store, resolution.key);
  let body = der;
  if (resolution.format === "pem") {
    const pem = derToPem(der, pemKind(resolution.kind));
    body = new TextEncoder().encode(pem) as Uint8Array<ArrayBuffer>;
  }
  return c.body(body, 200, { ...headers, "Content-Length": String(body.byteLength) });
}

export function downloadRoutes(deps: AppDeps) {
  const downloads = new Hono();
  for (const path of DOWNLOAD_ROUTES) {
    downloads.get(path, (c) => serveDownload(c, deps));
  }
  return downloads;
}
