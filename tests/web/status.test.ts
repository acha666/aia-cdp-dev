import { describe, expect, it } from "vitest";
import manifest from "../fixtures/pki/manifest.json";
import { computeCertificateStatus, computeCrlStatus, needsAttention } from "@/utils/status";
import type { CrlStatusState } from "@/utils/status";

const start = "2026-01-01T00:00:00Z";
const end = "2026-01-11T00:00:00Z";
const now = Date.parse("2026-01-05T00:00:00Z");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const adcsFull = manifest.crls.find((crl) => crl.file === "crls/issuing-ca-1/full-adcs.der")!;
const ADCS = { ...adcsFull, nextUpdate: adcsFull.nextUpdate!, nextPublish: adcsFull.nextPublish! };

describe.each([
  ["computeCertificateStatus", computeCertificateStatus],
  ["computeCrlStatus", computeCrlStatus],
])("%s", (_, status) => {
  it("is unknown for an inverted validity window", () => {
    expect(status(end, start, now)).toBe("unknown");
  });

  it("is not yet valid before the start and expired after the end", () => {
    expect(status(start, end, Date.parse(start) - 1)).toBe("not-yet-valid");
    expect(status(start, end, Date.parse(end) + 1500)).toBe("expired");
  });
});

describe("computeCrlStatus", () => {
  it("is unknown without nextUpdate, even with Next CRL Publish, or with an empty window", () => {
    expect(computeCrlStatus(start, null, now, "2026-01-02T00:00:00Z")).toBe("unknown");
    expect(computeCrlStatus(start, start, now)).toBe("unknown");
  });

  it("is expired only after nextUpdate (inclusive bound)", () => {
    expect(computeCrlStatus(start, end, Date.parse(end))).toBe("stale");
    expect(computeCrlStatus(start, end, Date.parse(end) + 1)).toBe("expired");
  });

  it("is stale with less than 20% left without Next CRL Publish", () => {
    const eightDays = Date.parse(start) + 8 * DAY;
    expect(computeCrlStatus(start, end, now)).toBe("current");
    expect(computeCrlStatus(start, end, eightDays)).toBe("current");
    expect(computeCrlStatus(start, end, eightDays + 1)).toBe("stale");
  });

  it("with Next CRL Publish, is stale only more than an hour after it (AD CS)", () => {
    const publish = Date.parse(ADCS.nextPublish);
    const status = (at: number) =>
      computeCrlStatus(ADCS.thisUpdate, ADCS.nextUpdate, at, ADCS.nextPublish);

    const eightyPercent =
      Date.parse(ADCS.thisUpdate) +
      0.8 * (Date.parse(ADCS.nextUpdate) - Date.parse(ADCS.thisUpdate));
    expect(status(eightyPercent + HOUR)).toBe("current");
    expect(status(publish + HOUR)).toBe("current");
    expect(status(publish + HOUR + 1)).toBe("stale");
    expect(status(Date.parse(ADCS.nextUpdate) + 1)).toBe("expired");
  });
});

describe("computeCertificateStatus", () => {
  it("is still valid at notAfter (expiring there) and expired one millisecond later", () => {
    expect(computeCertificateStatus(start, end, Date.parse(end))).toBe("expiring");
    expect(computeCertificateStatus(start, end, Date.parse(end) + 1)).toBe("expired");
  });

  it("is expiring with less than 10% of the validity period left", () => {
    const oneDayLeft = Date.parse(end) - DAY;
    expect(computeCertificateStatus(start, end, oneDayLeft)).toBe("valid");
    expect(computeCertificateStatus(start, end, oneDayLeft + 1)).toBe("expiring");
  });
});

describe("needsAttention", () => {
  it("counts stale, expired and unknown targets", () => {
    const states: CrlStatusState[] = [
      "current",
      "stale",
      "expired",
      "not-yet-valid",
      "unknown",
      "unpublished",
    ];
    expect(states.filter(needsAttention)).toEqual(["stale", "expired", "unknown"]);
  });
});
