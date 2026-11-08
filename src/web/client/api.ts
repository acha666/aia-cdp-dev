import { hc } from "hono/client";
import type { AppType } from "../../http/app.ts";
import { apiFetch } from "./errors";

/** The typed client for the public API; responses are never served from the HTTP cache. */
export const api = hc<AppType>("", { init: { cache: "no-store" }, fetch: apiFetch });
