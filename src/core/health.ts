import { z } from "zod";
import { InvalidStoredObjectError, readState } from "./catalog.ts";
import type { ObjectStore } from "./store.ts";

export const Health = z
  .object({
    status: z.enum(["healthy", "degraded", "unhealthy"]),
    checks: z.object({
      store: z.enum(["ok", "error"]),
      configuration: z.enum(["ok", "missing", "invalid", "unknown"]),
    }),
  })
  .meta({ id: "Health" });

export type HealthReport = z.infer<typeof Health>;
type ConfigurationCheck = Exclude<HealthReport["checks"]["configuration"], "unknown">;

const UNHEALTHY: HealthReport = {
  status: "unhealthy",
  checks: { store: "error", configuration: "unknown" },
};

export async function checkHealth(
  store: ObjectStore,
  onStoreError: (error: unknown) => void
): Promise<HealthReport> {
  let configuration: ConfigurationCheck;
  try {
    const { hasConfig } = await readState(store);
    configuration = hasConfig ? "ok" : "missing";
  } catch (error) {
    if (!(error instanceof InvalidStoredObjectError)) {
      onStoreError(error);
      return UNHEALTHY;
    }
    configuration = "invalid";
  }
  return {
    status: configuration === "ok" ? "healthy" : "degraded",
    checks: { store: "ok", configuration },
  };
}
