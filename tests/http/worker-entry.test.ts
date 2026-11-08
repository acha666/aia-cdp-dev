import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectInternal } from "../helpers/reads.ts";

interface WorkerEntry {
  fetch(request: Request, env: object, ctx: object): Response | Promise<Response>;
}

const ENTRY = fileURLToPath(new URL("../../src/runtime/worker.ts", import.meta.url));
const worker = ((await import(ENTRY)) as { default: WorkerEntry }).default;

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

function health(vars: Record<string, unknown>): Promise<Response> {
  const env = {
    STORE: { get: () => Promise.resolve(null) },
    ASSETS: { fetch: () => new Response("<!doctype html>") },
    ...vars,
  };
  return Promise.resolve(worker.fetch(new Request("https://pki.example/api/v1/health"), env, CTX));
}

function records(): Record<string, unknown>[] {
  return vi
    .mocked(console.log)
    .mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe("src/runtime/worker.ts", () => {
  it("accepts a wrangler var written as a JSON number", async () => {
    const res = await health({ AIA_MAX_UPLOAD_BYTES: 1048576 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "degraded" });
    expect(records()).toEqual([expect.objectContaining({ msg: "request", status: 200 })]);
  });

  it("answers 500 and logs the variable when AIA_ADMIN_TOKEN is no string, never the value", async () => {
    const res = await health({ AIA_ADMIN_TOKEN: { secret: "s3cret" } });
    await expectInternal(res, "s3cret");
    expect(records()).toEqual([
      {
        level: "error",
        msg: "invalid_settings",
        error:
          "Invalid settings:\n  AIA_ADMIN_TOKEN: must be a bearer token: letters, digits and " +
          "- . _ ~ + /, optionally ending in =",
      },
    ]);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("s3cret");
  });
});
