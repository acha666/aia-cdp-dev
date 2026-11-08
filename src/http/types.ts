import type { ObjectStore } from "../core/store.ts";
import type { Logger } from "./log.ts";

export interface AppSettings {
  maxUploadBytes: number;
  adminToken?: string;
  uploadToken?: string;
}

export interface AppDeps {
  store: ObjectStore;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  settings: AppSettings;
  log: Logger;
  ui?: (req: Request) => Response | Promise<Response>;
}
