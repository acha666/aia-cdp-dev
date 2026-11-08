import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { testDeps } from "../helpers/app.ts";

describe("GET /api/v1/openapi.json", () => {
  it("is served as public, max-age=300 JSON, byte for byte the same on every request", async () => {
    const app = createApp(testDeps());
    const first = await app.request("/api/v1/openapi.json");
    const second = await app.request("/api/v1/openapi.json");
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=300");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("is the committed docs/openapi.json, with or without an upload token", async () => {
    for (const settings of [{}, { uploadToken: "upload-s3cret-token" }]) {
      const res = await createApp(testDeps({ settings })).request("/api/v1/openapi.json");
      const doc = `${JSON.stringify(await res.json(), null, 2)}\n`;
      await expect(doc).toMatchFileSnapshot("../../docs/openapi.json");
    }
  });
});
