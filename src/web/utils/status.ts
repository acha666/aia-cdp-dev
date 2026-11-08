// Validity states of certificates and CRL targets, the one rule behind the status badges and the
// overview's "needs attention" count. Bounds are inclusive (valid at notAfter, expired one
// millisecond later). The clock is always passed in (useClock in components), so every badge on a
// page reads the same instant.
import type { CrlTargetListItem } from "@/client/types";

/** `expiring`: valid, with less than 10% of the validity period left. */
export type CertificateStatusState = "valid" | "expiring" | "expired" | "not-yet-valid" | "unknown";

/** `unpublished`: the target has no current CRL. */
export type CrlStatusState =
  "current" | "stale" | "expired" | "not-yet-valid" | "unknown" | "unpublished";

/** The summary fields of a target's current CRL that its status depends on. */
export type CrlTimes = Pick<
  NonNullable<CrlTargetListItem["current"]>["summary"],
  "thisUpdate" | "nextUpdate" | "nextPublish"
>;

/** How long after its Next CRL Publish an AD CS CRL may stay current (publish → helper upload). */
const NEXT_PUBLISH_GRACE_MS = 60 * 60 * 1000;

/**
 * Dates out of order give `unknown`, never `valid` (the catalog's times are always valid ones).
 * Expiring: less than 10% of notBefore → notAfter remains (a 20-year root two years ahead, a
 * 10-year issuing CA one year).
 */
export function computeCertificateStatus(
  notBefore: string,
  notAfter: string,
  nowMs: number
): CertificateStatusState {
  const start = Date.parse(notBefore);
  const end = Date.parse(notAfter);
  if (end < start) {
    return "unknown";
  }
  if (nowMs < start) {
    return "not-yet-valid";
  }
  if (nowMs > end) {
    return "expired";
  }
  // remaining < 10% of the period, in integers (no 0.1 rounding at the boundary).
  return (end - nowMs) * 10 < end - start ? "expiring" : "valid";
}

/**
 * Status of a CRL from its own times. Without nextUpdate (or with dates out of order) it is
 * `unknown`; after nextUpdate `expired`. Before that it is stale when:
 * - it carries an AD CS Next CRL Publish: more than an hour after that time (the CA should have
 *   published its successor by then, and this one is still current);
 * - otherwise (e.g. an offline root's CRL): when less than 20% of thisUpdate → nextUpdate remains.
 */
export function computeCrlStatus(
  thisUpdate: string,
  nextUpdate: string | null,
  nowMs: number,
  nextPublish: string | null = null
): CrlStatusState {
  if (nextUpdate === null) {
    return "unknown";
  }
  const start = Date.parse(thisUpdate);
  const end = Date.parse(nextUpdate);
  if (end <= start) {
    return "unknown";
  }
  if (nowMs < start) {
    return "not-yet-valid";
  }
  if (nowMs > end) {
    return "expired";
  }
  // elapsed > 80% of the period, in integers.
  const stale =
    nextPublish === null
      ? (nowMs - start) * 5 > (end - start) * 4
      : nowMs > Date.parse(nextPublish) + NEXT_PUBLISH_GRACE_MS;
  return stale ? "stale" : "current";
}

/** Status of a target from its current CRL (list item or detail); `unpublished` without one. */
export function computeTargetStatus(
  current: { summary: CrlTimes } | null,
  nowMs: number
): CrlStatusState {
  if (current === null) {
    return "unpublished";
  }
  const { thisUpdate, nextUpdate, nextPublish } = current.summary;
  return computeCrlStatus(thisUpdate, nextUpdate, nowMs, nextPublish);
}

/** The overview's "needs attention" count: stale, expired and unknown targets. */
export function needsAttention(state: CrlStatusState): boolean {
  return state === "stale" || state === "expired" || state === "unknown";
}
