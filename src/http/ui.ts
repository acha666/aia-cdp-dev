import type { Context, NotFoundHandler } from "hono";
import { IMMUTABLE } from "../core/resources.ts";
import { ERROR_MESSAGES, errorBody, NO_STORE } from "./errors.ts";
import type { AppDeps } from "./types.ts";

const API_PREFIX = /^\/api(?:\/|$)/;

const DOWNLOAD_PREFIX = /^\/(?:ca|crl|dcrl)(?:\/|$)/;

const HASHED_ASSETS = "/assets/";

const ASSET_STATUSES = new Set([200, 206, 304]);

export function hasFileExtension(path: string): boolean {
  return /\.[^/]*$/.test(path);
}

export function textNotFound(c: Context): Response {
  return c.text("Not Found", 404, NO_STORE);
}

function isHtml(res: Response): boolean {
  return res.headers.get("Content-Type")?.toLowerCase().startsWith("text/html") ?? false;
}

/**
 * Handles every request no route matched. Unknown API paths get a JSON 404; other GET and
 * HEAD requests go to the web UI, which answers unknown pages with `index.html` for
 * client-side routing.
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
    const res = await deps.ui(c.req.raw);
    const html = isHtml(res);
    if (
      // A missing file must not be answered with the page.
      res.status === 404 ||
      (hasFileExtension(path) && !path.toLowerCase().endsWith(".html") && html)
    ) {
      return textNotFound(c);
    }
    // Files under /assets/ have content hashes in their names.
    const immutable =
      path.startsWith(HASHED_ASSETS) &&
      hasFileExtension(path) &&
      !html &&
      ASSET_STATUSES.has(res.status);
    // Copied, since responses from Worker bindings have immutable headers.
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", immutable ? IMMUTABLE : "no-cache");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** Answers 405 with `Allow`, as plain text on download paths and as JSON elsewhere. */
export function onMethodNotAllowed(c: Context, methods: string[]): Response {
  const headers = { ...NO_STORE, Allow: methods.join(", ") };
  if (DOWNLOAD_PREFIX.test(c.req.path)) {
    return c.text("Method Not Allowed", 405, headers);
  }
  return c.json(errorBody("method_not_allowed", ERROR_MESSAGES.method_not_allowed), 405, headers);
}
