// Reserved prefixes and the UI fallback. Both runtimes share these rules: the Workers SPA asset
// layer and the Node static handler are only reached through deps.ui, so /api and download-prefix
// misses never become 200 HTML.
import type { Context, NotFoundHandler } from "hono";
import { IMMUTABLE } from "../core/resources.ts";
import { ERROR_MESSAGES, errorBody, NO_STORE } from "./errors.ts";
import type { AppDeps } from "./types.ts";

/** API paths: a miss is the JSON 404 envelope. */
const API_PREFIX = /^\/api(?:\/|$)/;

/**
 * Download paths (CryptoAPI / OpenSSL clients), as Hono matches the download routes' `/ca/*`:
 * another method there is a text/plain 405 (their misses are the download routes' own text 404).
 * The bare prefix counts, but a `/` or the end must follow it: /crls/ and /certificates/ are UI
 * routes.
 */
const DOWNLOAD_PREFIX = /^\/(?:ca|crl|dcrl)(?:\/|$)/;

/** Content-hashed Vite output. */
const HASHED_ASSETS = "/assets/";

/** Statuses of a stored asset (full, range, revalidated): the only ones cached as immutable. */
const ASSET_STATUSES = new Set([200, 206, 304]);

/** The last path segment has a file extension (`/assets/x.js`, `/favicon.ico`, `/.env`). */
export function hasFileExtension(path: string): boolean {
  return /\.[^/]*$/.test(path);
}

/** `text/plain` 404 `Not Found`, as served to download clients. */
export function textNotFound(c: Context): Response {
  return c.text("Not Found", 404, NO_STORE);
}

function isHtml(res: Response): boolean {
  return res.headers.get("Content-Type")?.toLowerCase().startsWith("text/html") ?? false;
}

/**
 * app.notFound: every request no route answered.
 *
 * - `/api`, `/api/*` → JSON envelope 404 `not_found`, no-store.
 * - other GET / HEAD → `deps.ui(req)`, copied (binding responses have immutable headers); a ui
 *   404, or text/html for a path whose last segment has a non-.html extension (the SPA fallback
 *   for a missing file), → text 404. Cache-Control: immutable only for a file under /assets/
 *   (last segment with an extension) answered 200 / 206 / 304 and not as text/html; everything
 *   else no-cache, error statuses included (their status is kept).
 * - other methods, or no ui → text 404.
 *
 * A 404 on a registered path with another method becomes 405 in methodNotAllowed afterwards
 * (onMethodNotAllowed).
 */
export function uiFallback(deps: Pick<AppDeps, "ui">): NotFoundHandler {
  return async (c) => {
    const path = c.req.path;
    if (API_PREFIX.test(path)) {
      return c.json(errorBody("not_found", ERROR_MESSAGES.not_found), 404, NO_STORE);
    }
    const method = c.req.method;
    if (deps.ui === undefined || (method !== "GET" && method !== "HEAD")) {
      return textNotFound(c);
    }
    // HEAD is passed through as HEAD.
    const res = await deps.ui(c.req.raw);
    const html = isHtml(res);
    if (
      res.status === 404 ||
      (hasFileExtension(path) && !path.toLowerCase().endsWith(".html") && html)
    ) {
      return textNotFound(c);
    }
    // Not for /assets/ or /assets/x (the SPA's index.html) or an error: a year is too long.
    const immutable =
      path.startsWith(HASHED_ASSETS) &&
      hasFileExtension(path) &&
      !html &&
      ASSET_STATUSES.has(res.status);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", immutable ? IMMUTABLE : "no-cache");
    // A 304 passes through with the rewritten headers.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * hono/method-not-allowed callback, no-store with `Allow` (GET routes include HEAD, so a download
 * path gets `GET, HEAD`): text/plain `Method Not Allowed` on the download routes (CryptoAPI and
 * OpenSSL clients), the envelope everywhere else.
 */
export function onMethodNotAllowed(c: Context, methods: string[]): Response {
  const headers = { ...NO_STORE, Allow: methods.join(", ") };
  if (DOWNLOAD_PREFIX.test(c.req.path)) {
    return c.text("Method Not Allowed", 405, headers);
  }
  return c.json(errorBody("method_not_allowed", ERROR_MESSAGES.method_not_allowed), 405, headers);
}
