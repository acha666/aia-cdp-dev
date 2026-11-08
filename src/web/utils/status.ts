import type { CrlTargetListItem } from "@/client/types";

export type CertificateStatusState = "valid" | "expiring" | "expired" | "not-yet-valid" | "unknown";

export type CrlStatusState =
  "current" | "stale" | "expired" | "not-yet-valid" | "unknown" | "unpublished";

export type CrlTimes = Pick<
  NonNullable<CrlTargetListItem["current"]>["summary"],
  "thisUpdate" | "nextUpdate" | "nextPublish"
>;

/** How long after its Next CRL Publish time a CRL counts as stale. */
const NEXT_PUBLISH_GRACE_MS = 60 * 60 * 1000;

/** A certificate is `expiring` in the last tenth of its validity. */
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
  return (end - nowMs) * 10 < end - start ? "expiring" : "valid";
}

/**
 * A CRL is `stale` once its Next CRL Publish time has passed by the grace period or, without
 * one, after four fifths of its validity: a newer CRL should exist by then.
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
  const stale =
    nextPublish === null
      ? (nowMs - start) * 5 > (end - start) * 4
      : nowMs > Date.parse(nextPublish) + NEXT_PUBLISH_GRACE_MS;
  return stale ? "stale" : "current";
}

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

/** Whether a CRL state is shown as a problem. */
export function needsAttention(state: CrlStatusState): boolean {
  return state === "stale" || state === "expired" || state === "unknown";
}
