import { VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { stubApi, testQueryClient } from "./helpers";
import HealthBadge from "@/components/HealthBadge.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

function mountBadge(locale: AppLocale) {
  return mount(HealthBadge, {
    global: {
      plugins: [createAppI18n(locale), [VueQueryPlugin, { queryClient: testQueryClient() }]],
    },
  });
}

describe("HealthBadge", () => {
  it("shows degraded in zh-CN", async () => {
    stubApi({
      "GET /api/v1/health": () =>
        Response.json({ status: "degraded", checks: { store: "ok", configuration: "missing" } }),
    });
    const badge = mountBadge("zh-CN");

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe("loading");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("检查中…");

    await flushPromises();

    const root = badge.get('[data-slot="badge"]');
    expect(root.attributes("role")).toBe("status");
    expect(root.attributes("data-state")).toBe("degraded");
    expect(badge.get('[data-testid="health-state"]').text()).toBe("降级");
    expect(root.text()).toContain("服务状态：");
    expect(root.attributes("title")).toBe("存储正常，但尚未应用配置。");
  });

  it.each([
    [
      "healthy for a 200 healthy response",
      () => Response.json({ status: "healthy", checks: { store: "ok", configuration: "ok" } }),
      "healthy",
      "Healthy",
    ],
    [
      "unhealthy for a 503 response",
      () =>
        Response.json(
          { status: "unhealthy", checks: { store: "error", configuration: "unknown" } },
          { status: 503 }
        ),
      "unhealthy",
      "Unhealthy",
    ],
    [
      "unknown for a status the API never sends",
      () => new Response("Bad Gateway", { status: 502 }),
      "unknown",
      "Unknown",
    ],
  ])("shows %s", async (_, answer, state, label) => {
    stubApi({ "GET /api/v1/health": answer });
    const badge = mountBadge("en");
    await flushPromises();

    expect(badge.get('[data-slot="badge"]').attributes("data-state")).toBe(state);
    expect(badge.get('[data-testid="health-state"]').text()).toBe(label);
  });
});
