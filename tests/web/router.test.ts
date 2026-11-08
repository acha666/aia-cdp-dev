import { beforeEach, describe, expect, it } from "vitest";
import { mountApp, stubApi } from "./helpers";
import CertificatePage from "@/pages/CertificatePage.vue";
import CrlTargetPage from "@/pages/CrlTargetPage.vue";
import NotFoundPage from "@/pages/NotFoundPage.vue";
import OverviewPage from "@/pages/OverviewPage.vue";

const TARGET_ID = "0b7c5f2e-6d1a-4c3b-9e8f-1a2b3c4d5e6f";
const CERTIFICATE_ID = "3f1c".repeat(16);

let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  api = stubApi({});
});

describe("createAppRouter", () => {
  it("renders the overview at / with the site name in the header", async () => {
    const { router, wrapper } = await mountApp("/");

    expect(router.currentRoute.value.name).toBe("overview");
    expect(wrapper.findComponent(OverviewPage).exists()).toBe(true);
    expect(wrapper.get('[data-testid="site-name"]').text()).toBe("Test PKI");
    expect(document.title).toBe("Overview · Test PKI");
    expect(document.documentElement.lang).toBe("en");
  });

  it("lazy-loads CrlTargetPage for /crls/:targetId and passes the param as a prop", async () => {
    const { router, wrapper } = await mountApp(`/crls/${TARGET_ID}`);

    expect(router.currentRoute.value.name).toBe("crl");
    const page = wrapper.findComponent(CrlTargetPage);
    expect(page.exists()).toBe(true);
    expect(page.props("targetId")).toBe(TARGET_ID);
    expect(api.calls()).toEqual(["GET /api/v1/crls"]);
  });

  it("lazy-loads CertificatePage for /certificates/:id", async () => {
    const { router, wrapper } = await mountApp(`/certificates/${CERTIFICATE_ID}`);

    expect(router.currentRoute.value.name).toBe("certificate");
    const page = wrapper.findComponent(CertificatePage);
    expect(page.exists()).toBe(true);
    expect(page.props("id")).toBe(CERTIFICATE_ID);
    expect(api.calls()).toEqual([
      "GET /api/v1/certificates",
      `GET /api/v1/blobs/${CERTIFICATE_ID}`,
    ]);
  });

  it.each([
    ["an uppercase certificate id", `/certificates/${CERTIFICATE_ID.toUpperCase()}`],
    ["a short certificate id", `/certificates/${CERTIFICATE_ID.slice(1)}`],
    ["a path in the id", "/certificates/..%2Fcrls"],
    ["a target id that is no UUID", "/crls/not-a-uuid"],
    ["a target id one digit short", `/crls/${TARGET_ID.slice(0, -1)}`],
    ["an uppercase target id", `/crls/${TARGET_ID.toUpperCase()}`],
    ["a nested target path", `/crls/${TARGET_ID}/extra`],
  ])("renders NotFoundPage for %s without a request", async (_, path) => {
    const { router, wrapper } = await mountApp(path);

    expect(router.currentRoute.value.name).toBe("not-found");
    expect(wrapper.findComponent(NotFoundPage).exists()).toBe(true);
    expect(api.calls()).toEqual([]);
  });

  it("renders NotFoundPage for an unknown path", async () => {
    const { router, wrapper } = await mountApp("/nope");

    expect(router.currentRoute.value.name).toBe("not-found");
    expect(wrapper.findComponent(NotFoundPage).exists()).toBe(true);
    expect(wrapper.text()).toContain("/nope");
    expect(document.title).toBe("Page not found · Test PKI");
  });
});
