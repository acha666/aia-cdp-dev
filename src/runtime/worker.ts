import { createApp } from "../http/app.ts";
import type { AppType } from "../http/app.ts";
import { ERROR_MESSAGES, errorBody, NO_STORE } from "../http/errors.ts";
import { R2Store } from "../storage/r2.ts";
import { parseSettings } from "./settings.ts";

const VARIABLES = ["AIA_ADMIN_TOKEN", "AIA_UPLOAD_TOKEN", "AIA_MAX_UPLOAD_BYTES"] as const;

type WorkerEnv = Env & Partial<Record<(typeof VARIABLES)[number], unknown>>;

function settingsInput(env: WorkerEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    VARIABLES.map((name) => {
      const value = env[name];
      if (value === undefined || value === null) {
        return [name, undefined];
      }
      return [name, typeof value === "string" ? value : JSON.stringify(value)];
    })
  );
}

const apps = new WeakMap<Env, AppType>();

function appFor(env: WorkerEnv): { ok: true; app: AppType } | { ok: false; error: string } {
  const cached = apps.get(env);
  if (cached) {
    return { ok: true, app: cached };
  }
  const parsed = parseSettings(settingsInput(env));
  if (!parsed.ok) {
    return parsed;
  }
  const app = createApp({
    store: new R2Store(env.STORE),
    now: () => new Date(),
    settings: parsed.value.app,
    log: (record) => {
      console.log(JSON.stringify(record));
    },
    ui: (req) => env.ASSETS.fetch(req),
  });
  apps.set(env, app);
  return { ok: true, app };
}

export default {
  fetch(request, env, ctx) {
    const result = appFor(env);
    if (!result.ok) {
      console.log(JSON.stringify({ level: "error", msg: "invalid_settings", error: result.error }));
      return Response.json(errorBody("internal", ERROR_MESSAGES.internal), {
        status: 500,
        headers: NO_STORE,
      });
    }
    return result.app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
