import type { ObjectStore } from "../core/store.ts";
import type { Logger } from "./log.ts";

/**
 * Runtime settings. Without `adminToken` the admin API is disabled; without `uploadToken`
 * CRL uploads need no token.
 */
export interface AppSettings {
  maxUploadBytes: number;
  adminToken?: string;
  uploadToken?: string;
}

/** What a runtime provides to {@link createApp}. `ui` serves the built web UI, if any. */
export interface AppDeps {
  store: ObjectStore;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  settings: AppSettings;
  log: Logger;
  ui?: (req: Request) => Response | Promise<Response>;
}
