import { flushPromises } from "@vue/test-utils";
import type { DOMWrapper, VueWrapper } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  certificateBlob,
  certificateItem,
  crlBlob,
  currentOf,
  definitions,
  envelope,
  mountApp,
  NOW,
  stubApi,
  TARGET_IDS,
  targetItems,
} from "./helpers";
import type { Handler } from "./helpers";
import type { CertificateList, CrlTargetList } from "@/client/types";

beforeAll(() => import("../../src/core/pki/parsers.ts"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
});

afterEach(() => vi.useRealTimers());

async function open(path: string, routes: Record<string, Handler>) {
  const api = stubApi(routes);
  return { ...(await mountApp(path)), api };
}

const ROOT = certificateItem("root-ca", {
  label: "Root CA",
  targets: [{ targetId: TARGET_IDS.rootFull, kind: "full", label: "Root CA" }],
});

const CERTIFICATES = [
  ROOT,
  certificateItem("issuing-ca-1"),
  certificateItem("issuing-ca-2", {
    summary: { ...certificateItem("issuing-ca-2").summary, subjectCN: null },
    downloads: [],
  }),
] satisfies CertificateList;

const OVERVIEW = {
  "GET /api/v1/certificates": () => Response.json(CERTIFICATES),
  "GET /api/v1/crls": () => Response.json(targetItems()),
};

function rows(page: VueWrapper, table: string): DOMWrapper<Element>[] {
  return page.get(`[data-testid="${table}"]`).findAll("tbody tr");
}

function stat(page: VueWrapper, key: string): string {
  return page.get(`[data-stat="${key}"] [data-testid="stat-value"]`).text();
}

async function selectTab(page: VueWrapper, label: RegExp) {
  const trigger = page.findAll('[role="tab"]').find((tab) => label.test(tab.text()));
  if (trigger === undefined) {
    throw new Error(`No tab ${String(label)}`);
  }
  await trigger.trigger("mousedown", { button: 0 });
  await flushPromises();
}

describe("OverviewPage", () => {
  it("shows the counts, the certificates and the targets", async () => {
    const { wrapper } = await open("/", OVERVIEW);

    expect(stat(wrapper, "certificates")).toBe("3");
    expect(stat(wrapper, "targets")).toBe("3");
    expect(wrapper.get('[data-stat="targets"]').text()).toContain("2 full · 1 delta");
    expect(stat(wrapper, "published")).toBe("2");
    expect(stat(wrapper, "revocations")).toBe("2");
    expect(stat(wrapper, "attention")).toBe("0");

    const certificates = rows(wrapper, "certificate-table");
    expect(certificates.map((row) => row.get("a").text())).toEqual([
      "Example Issuing CA 01 (RSA)",
      "Root CA",
      "Unknown Certificate",
    ]);
    expect(certificates[1]!.get("a").attributes("href")).toBe(
      `/certificates/${CERTIFICATES[0]!.id}`
    );
    expect(certificates[1]!.text()).toContain("Example Root CA (ECC P-384)");
    expect(certificates[0]!.get('[data-state="valid"]').text()).toBe("Valid");
    expect(certificates[0]!.get('[data-testid="remaining"]').text()).toBe("in 3,284 days");

    const targets = rows(wrapper, "crl-target-table");
    expect(targets.map((row) => row.attributes("data-id"))).toEqual([
      TARGET_IDS.issuingFull,
      TARGET_IDS.issuingDelta,
      TARGET_IDS.rootFull,
    ]);
    expect(targets.map((row) => row.get("[data-kind]").attributes("data-kind"))).toEqual([
      "full",
      "delta",
      "full",
    ]);
    expect(targets[1]!.get("[data-kind]").text()).toBe("Delta CRL");
    expect(targets[0]!.get('[data-testid="crl-number"]').text()).toBe("#19");
    expect(targets[0]!.get('[data-testid="revoked-count"]').text()).toBe("2");
    expect(targets[0]!.find('[data-state="current"]').exists()).toBe(true);
    expect(targets[0]!.get('[data-testid="remaining"]').text()).toBe("in 7 days");
    expect(targets[1]!.get('[data-testid="crl-number"]').text()).toBe("—");
    expect(targets[1]!.get('[data-testid="revoked-count"]').text()).toBe("—");
    expect(targets[1]!.get('[data-state="unpublished"]').text()).toBe("Not published");
    expect(targets[1]!.find('[data-testid="remaining"]').exists()).toBe(false);
    expect(targets[1]!.find("a[download]").exists()).toBe(false);
    expect(targets[0]!.findAll("a[download]")).toHaveLength(2);
  });

  it("counts stale, expired and unknown targets as needing attention, with the badges' clock", async () => {
    vi.setSystemTime(new Date("2026-01-10T13:30:00Z"));
    const { wrapper } = await open("/", OVERVIEW);

    expect(stat(wrapper, "attention")).toBe("1");
    const stale = rows(wrapper, "crl-target-table")[0]!;
    expect(stale.find('[data-state="stale"]').exists()).toBe(true);
    expect(stale.find('[data-testid="remaining"]').exists()).toBe(false);
  });

  it("shows unknown revocations when no full CRL is published", async () => {
    const { wrapper } = await open("/", {
      ...OVERVIEW,
      "GET /api/v1/crls": () =>
        Response.json(targetItems().map((target) => ({ ...target, current: null }))),
    });

    expect(stat(wrapper, "revocations")).toBe("Unknown");
  });

  it("shows skeletons only before the first answer, then keeps the list while refetching", async () => {
    const first = Promise.withResolvers<Response>();
    const again = Promise.withResolvers<Response>();
    let requests = 0;
    const { wrapper, queryClient } = await open("/", {
      ...OVERVIEW,
      "GET /api/v1/certificates": () => {
        requests += 1;
        return requests === 1 ? first.promise : again.promise;
      },
    });
    expect(rows(wrapper, "certificate-table").map((row) => row.attributes("data-testid"))).toEqual([
      "skeleton-row",
      "skeleton-row",
      "skeleton-row",
    ]);

    first.resolve(Response.json(CERTIFICATES));
    await flushPromises();
    expect(rows(wrapper, "certificate-table")).toHaveLength(3);

    void queryClient.invalidateQueries({ queryKey: ["certificates"] });
    await flushPromises();
    expect(requests).toBe(2);
    expect(wrapper.find('[data-testid="skeleton-row"]').exists()).toBe(false);
    expect(rows(wrapper, "certificate-table")).toHaveLength(3);

    again.resolve(Response.json(CERTIFICATES.slice(0, 1)));
    await flushPromises();
    expect(rows(wrapper, "certificate-table")).toHaveLength(1);
  });

  it("reports a failed list with its error text and retries on request", async () => {
    let fail = true;
    const { wrapper } = await open("/", {
      ...OVERVIEW,
      "GET /api/v1/crls": () => (fail ? envelope(500, "internal") : Response.json(targetItems())),
    });

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(true);
    });
    const [counts, alert] = wrapper.findAll('[data-testid="query-error"]');
    expect(counts!.text()).toContain("Could not load the statistics");
    expect(alert!.text()).toContain("Could not load the CRL targets");
    expect(alert!.text()).toContain("The server failed. Try again later.");

    fail = false;
    await alert!.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(false);
    expect(rows(wrapper, "crl-target-table")).toHaveLength(3);
  });
});

describe("CertificatePage", () => {
  const path = `/certificates/${ROOT.id}`;
  const routes = {
    ...OVERVIEW,
    ...certificateBlob("root-ca"),
    "GET /ca/root-ca.crt.pem": () =>
      new Response("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"),
  };

  it("shows the header and the overview with algorithms, signature, fingerprints and targets", async () => {
    const { wrapper, api } = await open(path, routes);

    expect(api.calls()).toEqual(["GET /api/v1/certificates", `GET /api/v1/blobs/${ROOT.id}`]);
    expect(wrapper.get("h1").text()).toBe("Root CA");
    expect(document.title).toBe("Root CA · Test PKI");
    expect(wrapper.get("header [data-kind]").attributes("data-kind")).toBe("certificate");
    expect(wrapper.find('header [data-state="valid"]').exists()).toBe(true);

    const text = wrapper.text();
    expect(text).toContain("CN=Example Root CA (ECC P-384),O=Example PKI,C=US");
    expect(wrapper.get('[data-testid="signature"]').text()).toContain("ecdsa-with-SHA384");
    expect(wrapper.get('[data-testid="public-key"]').text()).toContain("ecPublicKey (P-384)");
    expect(definitions(wrapper.get('[data-testid="signature"]'))[1]![0]).toBe("Signature Value");
    expect(text).not.toContain("Unknown");
    expect(text).toContain(ROOT.id.slice(0, 2).toUpperCase());
    expect(wrapper.get('[data-testid="status-detail"]').text()).toBe("(in 6937d)");
    const target = wrapper.get('[data-testid="crl-targets"] a');
    expect(target.text()).toBe("Root CA");
    expect(target.attributes("href")).toBe(`/crls/${TARGET_IDS.rootFull}`);
  });

  it("lists the extensions and fetches the PEM text only for its tab", async () => {
    const { wrapper, api } = await open(path, routes);

    await selectTab(wrapper, /Extensions/);
    expect(wrapper.get('[data-oid="2.5.29.19"]').text()).toContain("Basic Constraints");

    expect(api.calls()).not.toContain("GET /ca/root-ca.crt.pem");
    await selectTab(wrapper, /PEM/);
    expect(api.calls()).toContain("GET /ca/root-ca.crt.pem");
    expect(wrapper.get('[data-testid="pem-text"]').text()).toContain("BEGIN CERTIFICATE");
  });

  it("has no PEM tab without a .pem download", async () => {
    const { wrapper } = await open(path, {
      ...routes,
      "GET /api/v1/certificates": () =>
        Response.json([{ ...ROOT, downloads: ["/ca/root-ca.crt"] }]),
    });

    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      "Overview",
      expect.stringMatching(/^Extensions \(\d+\)$/),
    ]);
  });

  it("reports DER that does not decode as an invalid certificate, without retrying", async () => {
    const { wrapper, api } = await open(path, {
      ...OVERVIEW,
      [`GET /api/v1/blobs/${ROOT.id}`]: () => new Response(new Uint8Array([0x30, 0x00])),
    });

    expect(wrapper.get('[data-testid="query-error"]').text()).toContain(
      "This is not a valid X.509 certificate."
    );
    expect(api.calls().filter((call) => call.includes("blobs"))).toHaveLength(1);
  });
});

describe("CrlTargetPage", () => {
  const path = `/crls/${TARGET_IDS.issuingFull}`;
  const PSS = "crls/issuing-ca-1/full-pss.der";
  const DELTA = "crls/issuing-ca-1/delta-adcs.der";

  function withCurrent(targetId: string, file: string | null): Record<string, Handler> {
    const list: CrlTargetList = targetItems().map((target) =>
      target.targetId === targetId
        ? { ...target, current: file === null ? null : currentOf(file) }
        : target
    );
    return { "GET /api/v1/crls": () => Response.json(list) };
  }

  const pssRoutes = { ...withCurrent(TARGET_IDS.issuingFull, PSS), ...crlBlob(PSS) };

  it("shows the current CRL with its numbers, times and signature algorithm parameters", async () => {
    const { wrapper } = await open(path, pssRoutes);

    expect(wrapper.get("h1").text()).toBe("Issuing CA 01");
    expect(document.title).toBe("Issuing CA 01 · Test PKI");
    expect(wrapper.get("header [data-kind]").attributes("data-kind")).toBe("full");
    const issuer = wrapper.get('[data-testid="issuer-link"]');
    expect(issuer.text()).toBe("Example Issuing CA 01 (RSA)");
    expect(issuer.attributes("href")).toBe(`/certificates/${certificateItem("issuing-ca-1").id}`);

    const overview = wrapper.get('[data-testid="crl-overview"]').text();
    expect(overview).toContain("CRL Number16");
    expect(overview).toContain("Versionv2");
    expect(overview).toContain(`RSASSA-PSS (SHA-256, MGF1/SHA-256, salt 32)`);
    expect(overview).toContain("CN=Example Issuing CA 01 (RSA),O=Example PKI,C=US");
    expect(overview).not.toContain("Base CRL Number");

    await selectTab(wrapper, /Revoked/);
    expect(wrapper.findAll('[data-testid="revoked-table"] tbody tr')).toHaveLength(2);
    await selectTab(wrapper, /Extensions/);
    expect(wrapper.find('[data-oid="2.5.29.20"]').exists()).toBe(true);
  });

  it("shows a delta CRL's numbers, its three times and its Next CRL Publish", async () => {
    vi.stubEnv("TZ", "UTC");
    const { wrapper } = await open(`/crls/${TARGET_IDS.issuingDelta}`, {
      ...withCurrent(TARGET_IDS.issuingDelta, DELTA),
      ...crlBlob(DELTA),
    });

    expect(wrapper.get("header [data-kind]").attributes("data-kind")).toBe("delta");
    expect(wrapper.find('header [data-state="current"]').exists()).toBe(true);
    expect(definitions(wrapper.get('[data-testid="crl-overview"]'))).toEqual(
      expect.arrayContaining([
        ["CRL Number", "20"],
        ["Base CRL Number", "19"],
        ["This Update", "Jan 03, 2026 17:50:00 (UTC)"],
        ["Next Update", "Jan 05, 2026 06:10:00 (UTC)"],
        ["Next CRL Publish", "Jan 04, 2026 18:00:00 (UTC)"],
      ])
    );
    expect(wrapper.get('[data-testid="status-detail"]').text()).toBe("(in 1d 6h 10m)");
  });

  it("measures a CRL that is not yet valid to its thisUpdate", async () => {
    vi.setSystemTime(new Date("2026-01-03T11:58:00Z"));
    const { wrapper } = await open(path, pssRoutes);

    expect(wrapper.find('header [data-state="not-yet-valid"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="status-detail"]').text()).toBe("(in 2m)");
  });

  it("shows an unpublished target as not published, without a revoked list or a blob", async () => {
    const { wrapper, api } = await open(path, withCurrent(TARGET_IDS.issuingFull, null));

    expect(api.calls()).toEqual(["GET /api/v1/crls"]);
    expect(wrapper.get("h1").text()).toBe("Issuing CA 01");
    expect(wrapper.get('[data-testid="issuer-link"]').attributes("href")).toBe(
      `/certificates/${certificateItem("issuing-ca-1").id}`
    );
    expect(wrapper.get('[data-testid="unpublished"]').text()).toContain("Not published");
    expect(wrapper.find('header [data-state="unpublished"]').exists()).toBe(true);
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="revoked-table"]').exists()).toBe(false);
    expect(wrapper.find("main header a[download]").exists()).toBe(false);
  });

  it("shows other failures with their error text", async () => {
    const { wrapper } = await open(path, {
      ...pssRoutes,
      [`GET /api/v1/blobs/${currentOf(PSS).sha256}`]: () => envelope(400, "bad_request"),
    });

    expect(wrapper.find('[data-testid="missing"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="query-error"]').text()).toContain(
      "The request was malformed."
    );
  });
});

describe("CertificatePage and CrlTargetPage", () => {
  it.each([
    ["Certificate not found", `/certificates/${ROOT.id}`],
    ["CRL target not found", `/crls/${TARGET_IDS.issuingFull}`],
  ])("say %s for an id its list does not have", async (title, path) => {
    const { wrapper } = await open(path, {
      "GET /api/v1/certificates": () => Response.json([]),
      "GET /api/v1/crls": () => Response.json([]),
    });

    expect(wrapper.get('[data-testid="missing"]').text()).toContain(title);
    expect(document.title).toBe(`${title} · Test PKI`);
  });
});
