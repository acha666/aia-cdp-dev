import { describe, expect, it } from "vitest";
import { compareFreshness } from "../../src/core/publish.ts";

const crl = (crlNumber: string | null, thisUpdate: string) => ({ crlNumber, thisUpdate });

const DAY_1 = "2026-01-01T00:00:00.000Z";
const DAY_2 = "2026-01-02T00:00:00.000Z";
const LARGE = 2n ** 100n + 123n;

describe("compareFreshness", () => {
  it("is non_orderable when exactly one side has a CRL Number, in both directions", () => {
    expect(compareFreshness(crl("3", DAY_1), crl(null, DAY_2))).toBe("non_orderable");
    expect(compareFreshness(crl(null, DAY_1), crl("3", DAY_2))).toBe("non_orderable");
  });

  it("orders numbered CRLs by number, over thisUpdate, as numbers beyond 2^53", () => {
    expect(compareFreshness(crl("5", DAY_2), crl("6", DAY_1))).toBe("updated");
    expect(compareFreshness(crl("6", DAY_1), crl("5", DAY_2))).toBe("stale_crl");
    expect(compareFreshness(crl("9", DAY_1), crl("10", DAY_1))).toBe("updated");
    const low = LARGE.toString();
    const high = (LARGE + 1n).toString();
    expect(compareFreshness(crl(low, DAY_1), crl(high, DAY_1))).toBe("updated");
    expect(compareFreshness(crl(high, DAY_1), crl(low, DAY_1))).toBe("stale_crl");
  });

  describe.each([
    ["equal numbers", "7"],
    ["no numbers on either side", null],
  ])("with %s, by thisUpdate", (_case, number) => {
    it("a later thisUpdate is updated, an earlier one stale_crl", () => {
      expect(compareFreshness(crl(number, DAY_1), crl(number, DAY_2))).toBe("updated");
      expect(compareFreshness(crl(number, DAY_2), crl(number, DAY_1))).toBe("stale_crl");
    });

    it("compares instants, not strings: with and without milliseconds", () => {
      const withMs = crl(number, "2026-01-02T00:00:00.000Z");
      expect(compareFreshness(withMs, crl(number, "2026-01-02T00:00:00Z"))).toBe("conflict");
      expect(compareFreshness(withMs, crl(number, "2026-01-02T00:00:01Z"))).toBe("updated");
    });
  });
});
