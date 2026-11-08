import { hc } from "hono/client";
import type { AppType } from "../../http/app.ts";
import { apiFetch } from "./errors";

export const api = hc<AppType>("", { init: { cache: "no-store" }, fetch: apiFetch });
