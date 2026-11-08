// The revoked certificates of a CRL target: every entry of the decoded CRL, which the table pages
// itself at 200 rows, saying which rows of how many a page shows. Entry extensions are DER, as
// parseCRL leaves them.
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { Time } from "pkijs";
import { describe, expect, it, vi } from "vitest";
import type { PlainExtension } from "../../src/core/pki/extensions.ts";
import type { CrlEntry } from "../../src/core/pki/parsers.ts";
import RevokedTable from "@/components/crl/RevokedTable.vue";
import { createAppI18n } from "@/i18n";
import type { AppLocale } from "@/i18n";

function render(entries: CrlEntry[], locale: AppLocale = "en") {
  return mount(RevokedTable, {
    props: { entries },
    attachTo: document.body,
    global: { plugins: [createAppI18n(locale)] },
  });
}

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const ascii = (text: string) =>
  Array.from(text, (char) => char.charCodeAt(0).toString(16)).join("");

function entry(serial: string, revoked: string, extensions: PlainExtension[] = []): CrlEntry {
  return {
    serial: bytes(serial),
    revocationDate: new Time({ type: 0, value: new Date(revoked) }),
    extensions,
  };
}

/** `count` entries with serials 0001, 0002, ... (no entry extensions). */
const entries = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    entry((index + 1).toString(16).padStart(4, "0"), "2026-01-01T00:00:00Z")
  );

const extension = (extnID: string, value: string): PlainExtension => ({
  extnID,
  critical: false,
  value: bytes(value),
});

/** The data cells of each body row; the first cell holds the extensions toggle. */
const rowTexts = (table: VueWrapper) =>
  table.findAll("tbody tr").map((row) =>
    row
      .findAll("td")
      .slice(1)
      .map((cell) => cell.text())
  );

const serials = (table: VueWrapper) => rowTexts(table).map((row) => row[0]);

describe("RevokedTable", () => {
  it("shows an empty state, not an empty table, for a CRL without entries", () => {
    const table = render([], "zh-CN");
    expect(table.find("table").exists()).toBe(false);
    expect(table.get('[data-testid="revoked-empty"]').text()).toBe("没有吊销的证书。");
  });

  it("shows exactly 200 entries on one page, without a pager", () => {
    const table = render(entries(200));
    expect(serials(table)).toHaveLength(200);
    expect(serials(table).at(-1)).toBe("00C8");
    expect(table.find('[data-testid="revoked-range"]').exists()).toBe(false);
    expect(table.find('[data-testid="next-page"]').exists()).toBe(false);
  });

  it("pages 201 entries as 200 + 1", async () => {
    const table = render(entries(201));
    expect(serials(table)).toHaveLength(200);
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("1–200 of 201");
    expect(table.get('[data-testid="previous-page"]').attributes("aria-disabled")).toBe("true");

    await table.get('[data-testid="next-page"]').trigger("click");
    expect(serials(table)).toEqual(["00C9"]);
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("201–201 of 201");
    expect(table.get('[data-testid="next-page"]').attributes("aria-disabled")).toBe("true");

    // Another list (a refetch) starts again on the first page.
    await table.setProps({ entries: entries(250) });
    expect(table.get('[data-testid="revoked-range"]').text()).toBe("1–200 of 250");
  });

  it("fills reason and invalidity date from the entry extensions", () => {
    // Dates show in the browser's time zone (UTC+12 and later is already Jan 02).
    vi.stubEnv("TZ", "UTC");
    // leaf-revoked in crls/issuing-ca-1/full-01: keyCompromise with an invalidity date.
    const revoked = entry("2002", "2026-01-01T12:00:00Z", [
      extension("2.5.29.21", "0a0101"),
      extension("2.5.29.24", `180f${ascii("20251231120000Z")}`),
    ]);
    const cells = rowTexts(render([revoked, ...entries(1)]));

    expect(cells[0]![0]).toBe("2002");
    expect(cells[0]![1]).toBe("Jan 01, 2026 12:00:00 (UTC)");
    expect(cells[0]![2]).toBe("keyCompromise");
    expect(cells[0]![3]).toBe("Dec 31, 2025 12:00:00 (UTC)");
    expect(cells[1]!.slice(2)).toEqual(["—", "—"]);
  });

  it("expands a row with entry extensions into all of them, the hold instruction too", async () => {
    // The certificateHold entry of crls/issuing-ca-2/full-01.
    const hold = entry("3000", "2025-12-20T00:00:00Z", [
      extension("2.5.29.21", "0a0106"),
      extension("2.5.29.23", "06072a8648ce380203"),
    ]);
    const table = render([hold, ...entries(1)]);
    const [held, plain] = table.findAll("tbody tr");
    expect(plain!.find("button").exists()).toBe(false);
    const toggle = held!.get('[data-testid="entry-toggle"]');
    expect(toggle.attributes("aria-label")).toBe("Show entry extensions");
    expect(toggle.attributes("aria-expanded")).toBe("false");

    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    const detail = table.findAll("tbody tr")[1]!;
    expect(detail.findAll("[data-oid]").map((item) => item.attributes("data-oid"))).toEqual([
      "2.5.29.21",
      "2.5.29.23",
    ]);
    await detail.get('[data-oid="2.5.29.23"] button').trigger("click");
    expect(detail.text()).toContain("holdInstructionReject (1.2.840.10040.2.3)");

    await toggle.trigger("click");
    expect(serials(table)).toEqual(["3000", "0001"]);
  });
});
