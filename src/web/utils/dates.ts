import type { I18nText } from "@/i18n";

const DAY_S = 24 * 60 * 60;
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
  year: "numeric",
};
const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

function formatTimezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return "UTC";
  }
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60));
  const minutes = absMinutes % 60;
  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Formats a timestamp in the local time zone, naming its UTC offset. */
export function formatDate(
  iso: string | null | undefined,
  i18n: Pick<I18nText, "locale" | "t">,
  { time = true, zone = true } = {}
): string {
  if (!iso) {
    return i18n.t("common.notAvailable");
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return [
    new Intl.DateTimeFormat(i18n.locale.value, DATE_OPTIONS).format(date),
    time ? new Intl.DateTimeFormat(i18n.locale.value, TIME_OPTIONS).format(date) : "",
    zone ? `(${formatTimezoneOffset(date)})` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Describes a timestamp relative to `nowMs`: in whole days beyond a day, otherwise in
 * hours and minutes. `detailed` always uses days, hours and minutes.
 */
export function relativeTime(
  iso: string | null | undefined,
  nowMs: number,
  i18n: Pick<I18nText, "locale" | "t">,
  detailed = false
): string {
  const seconds = Math.floor((Date.parse(iso ?? "") - nowMs) / 1000);
  if (Number.isNaN(seconds)) {
    return "";
  }
  const abs = Math.abs(seconds);
  if (!detailed && abs >= DAY_S) {
    const days = Math.sign(seconds) * Math.round(abs / DAY_S);
    return new Intl.RelativeTimeFormat(i18n.locale.value).format(days, "day");
  }
  if (!detailed && seconds === 0) {
    return i18n.t("dates.now");
  }
  const total = Math.max(1, Math.round(abs / 60));
  const days = detailed ? Math.floor(total / (24 * 60)) : 0;
  const units = [
    [days, "day"],
    [Math.floor((total - days * 24 * 60) / 60), "hour"],
    [total % 60, "minute"],
  ] as const;
  const value = units
    .filter(([count]) => count > 0)
    .map(([count, unit]) => `${String(count)}${i18n.t(`dates.short.${unit}`)}`)
    .join(" ");
  return i18n.t(seconds >= 0 ? "dates.in" : "dates.ago", { value });
}
