import { useQuery, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { publishedCrl, stubApi, targetItems, testQueryClient } from "./helpers";
import { ApiError } from "@/client/errors";
import { queries, shouldRetry, useUploadCrl } from "@/client/queries";
import type { CrlTargetList } from "@/client/types";

function harness<T>(use: () => T): T {
  let result!: T;
  mount(
    defineComponent({
      setup() {
        result = use();
        return () => h("div");
      },
    }),
    { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } }
  );
  return result;
}

const OLD_LIST = targetItems().map((target) => ({ ...target, current: null }));
const NEW_LIST = targetItems();
const FILE = new File(["-----BEGIN X509 CRL-----"], "crl.pem");

describe("useUploadCrl", () => {
  it.each([
    ["the first load", false],
    ["a refetch", true],
  ])("refreshes after the upload even while %s sent before it is in flight", async (_, loaded) => {
    const stale = Promise.withResolvers<Response>();
    const lists: (RequestInit | undefined)[] = [];
    const api = stubApi({
      "GET /api/v1/crls": (init) => {
        lists.push(init);
        if (lists.length === (loaded ? 2 : 1)) {
          return stale.promise;
        }
        return Response.json(lists.length === 1 ? OLD_LIST : NEW_LIST);
      },
      "POST /api/v1/crls": () => Response.json(publishedCrl("created"), { status: 201 }),
    });
    const { targets, upload } = harness(() => ({
      targets: useQuery(queries.crls()),
      upload: useUploadCrl(),
    }));
    await flushPromises();
    if (loaded) {
      expect(targets.data.value).toEqual(OLD_LIST);
      void targets.refetch();
      await flushPromises();
    }
    expect(targets.isFetching.value).toBe(true);

    await upload.mutateAsync({ file: FILE, token: "" });
    await flushPromises();
    expect(targets.data.value).toEqual(NEW_LIST);

    stale.resolve(Response.json(OLD_LIST satisfies CrlTargetList));
    await flushPromises();
    expect(targets.data.value).toEqual(NEW_LIST);
    expect(targets.isFetching.value).toBe(false);
    expect(api.calls()).toEqual([
      ...(loaded ? ["GET /api/v1/crls"] : []),
      "GET /api/v1/crls",
      "POST /api/v1/crls",
      "GET /api/v1/crls",
    ]);
  });
});

describe("shouldRetry", () => {
  it("retries a 5xx or a failed request once, never a 4xx", () => {
    const serverError = new ApiError(503, "internal", "x");
    expect(shouldRetry(0, serverError)).toBe(true);
    expect(shouldRetry(1, serverError)).toBe(false);
    expect(shouldRetry(0, new ApiError(0, "network", "x"))).toBe(true);
    expect(shouldRetry(0, new ApiError(409, "stale_crl", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(499, "x", "x"))).toBe(false);
  });
});
