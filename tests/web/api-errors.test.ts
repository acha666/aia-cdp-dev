import { describe, expect, it } from "vitest";
import { stubApi, targetItems } from "./helpers";
import { api } from "@/client/api";
import { unwrap } from "@/client/errors";

describe("unwrap", () => {
  it("returns the body of a 2xx response", async () => {
    stubApi({ "GET /api/v1/crls": () => Response.json(targetItems()) });
    expect(await unwrap(await api.api.v1.crls.$get())).toEqual(targetItems());
  });

  it("throws the envelope's code, message and details with the HTTP status", async () => {
    await expect(
      unwrap(
        Response.json(
          { error: { code: "not_found", message: "No CRL target with this id is configured" } },
          { status: 404 }
        )
      )
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      status: 404,
      message: "No CRL target with this id is configured",
      details: undefined,
    });

    await expect(
      unwrap(
        Response.json(
          { error: { code: "invalid_crl", message: "Not a CRL", details: { reason: "der" } } },
          { status: 422 }
        )
      )
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_crl",
      status: 422,
      details: { reason: "der" },
    });

    await expect(
      unwrap(Response.json({ error: { code: "brand_new", message: "Newer" } }, { status: 409 }))
    ).rejects.toMatchObject({ name: "ApiError", code: "brand_new", status: 409 });
  });

  it.each([
    ["an HTML page", new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["JSON that is not the envelope", Response.json({ status: "unhealthy" }, { status: 503 })],
    ["an envelope without a message", Response.json({ error: { code: "x" } }, { status: 400 })],
    ["HTML with 200", new Response("<!doctype html><title>UI</title>", { status: 200 })],
    ["an empty body with 200", new Response(null, { status: 200 })],
  ])("throws invalid_response for %s", async (_name, response) => {
    await expect(unwrap(response)).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_response",
      status: response.status,
    });
  });

  it("throws network with the cause when the body cannot be read", async () => {
    const failure = new TypeError("terminated");
    await expect(
      unwrap({ ok: true, status: 200, text: () => Promise.reject(failure) })
    ).rejects.toMatchObject({ name: "ApiError", code: "network", status: 0, cause: failure });
  });
});

describe("api (hc<AppType>)", () => {
  it("rejects with ApiError network when fetch fails", async () => {
    const failure = new TypeError("Failed to fetch");
    stubApi({
      "GET /api/v1/certificates": () => {
        throw failure;
      },
    });
    await expect(api.api.v1.certificates.$get()).rejects.toMatchObject({
      name: "ApiError",
      code: "network",
      status: 0,
      cause: failure,
    });
  });
});
