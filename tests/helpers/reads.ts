import { expect } from "vitest";
import type { ObjectStore } from "../../src/core/store.ts";
import { createApp } from "../../src/http/app.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { testDeps } from "./app.ts";
import type { TestDeps, TestOverrides } from "./app.ts";
import { publishFile, setupPublish } from "./publish.ts";
import type { PublishSetup, SetupOptions } from "./publish.ts";

export interface ReadServiceOptions {
  setup?: SetupOptions;
  publish?: readonly string[];
  wrap?: (base: ObjectStore) => ObjectStore;
  overrides?: TestOverrides;
}

export interface ReadService {
  app: ReturnType<typeof createApp>;
  deps: TestDeps;
  base: MemoryStore;
  setup: PublishSetup;
}

export async function readService(options: ReadServiceOptions = {}): Promise<ReadService> {
  const base = new MemoryStore();
  const setup = await setupPublish(base, options.setup);
  for (const file of options.publish ?? []) {
    const { result } = await publishFile(base, file);
    if (!("outcome" in result) || result.outcome === "unchanged") {
      throw new Error(`publish ${file}: ${JSON.stringify(result)}`);
    }
  }
  const store = options.wrap?.(base) ?? base;
  const deps = testDeps({ ...options.overrides, store });
  return { app: createApp(deps), deps, base, setup };
}

export async function okJson<T = unknown>(
  res: Response,
  schema?: { parse(value: unknown): T }
): Promise<T> {
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body: unknown = await res.json();
  if (schema === undefined) {
    return body as T;
  }
  const parsed = schema.parse(body);
  expect(parsed).toEqual(body);
  return parsed;
}

export async function errorOf(
  res: Response,
  status: number,
  code: string
): Promise<{ code: string; message: string; details?: unknown }> {
  expect(res.status).toBe(status);
  expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error).sort()).toEqual(
    "details" in body.error ? ["code", "details", "message"] : ["code", "message"]
  );
  expect(body.error.code).toBe(code);
  return body.error;
}

export async function expectInternal(res: Response, ...secrets: string[]): Promise<void> {
  const text = await res.clone().text();
  expect(await errorOf(res, 500, "internal")).toEqual({
    code: "internal",
    message: "Internal server error",
  });
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}
