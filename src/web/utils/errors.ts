import { ApiError } from "@/client/errors";
import type { I18nText } from "@/i18n";

/** The localized message for an error code, or a generic one that names the code. */
export function errorMessage(error: unknown, { t, te }: Pick<I18nText, "t" | "te">): string {
  const code =
    error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown";
  const key = `errors.${code}`;
  return t(te(key) ? key : "errors.unknown", { code });
}

/** The localized `details.reason` of an API error, if it has one. */
export function errorReason(error: unknown, { t, te }: Pick<I18nText, "t" | "te">): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const reason = (error.details as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== "string") {
    return null;
  }
  const key = `upload.reasons.${reason}`;
  return te(key) ? t(key) : reason;
}
