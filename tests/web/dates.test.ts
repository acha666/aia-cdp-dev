import { describe, expect, it, vi } from "vitest";
import { createAppI18n } from "@/i18n";
import { formatDate, relativeTime } from "@/utils/dates";

const en = createAppI18n("en").global;
const zh = createAppI18n("zh-CN").global;

const ISO = "2026-01-04T00:05:07Z";
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("absolute dates", () => {
  it("labels each date with its own offset, daylight saving time included", () => {
    vi.stubEnv("TZ", "America/St_Johns");
    expect(formatDate("2026-07-04T00:05:07Z", en)).toBe("Jul 03, 2026 21:35:07 (UTC-2:30)");
    expect(formatDate(ISO, en)).toBe("Jan 03, 2026 20:35:07 (UTC-3:30)");
  });

  it("shows the local time with its offset", () => {
    vi.stubEnv("TZ", "UTC");
    expect(formatDate(ISO, en)).toBe("Jan 04, 2026 00:05:07 (UTC)");
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(formatDate(ISO, en)).toBe("Jan 04, 2026 05:35:07 (UTC+5:30)");
    vi.stubEnv("TZ", "America/St_Johns");
    expect(formatDate(ISO, en, { time: false })).toBe("Jan 03, 2026 (UTC-3:30)");
    expect(formatDate(ISO, en, { time: false, zone: false })).toBe("Jan 03, 2026");
  });

  it("formats in the message locale (zh-CN)", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    expect(formatDate(ISO, zh)).toBe("2026年1月04日 08:05:07 (UTC+8)");
    expect(formatDate(ISO, zh, { time: false })).toBe("2026年1月04日 (UTC+8)");
  });

  it("says N/A without a date and keeps text that is no date", () => {
    expect(formatDate(null, en)).toBe("N/A");
    expect(formatDate(undefined, zh, { time: false })).toBe("无");
    expect(formatDate("", en, { time: false, zone: false })).toBe("N/A");
    expect(formatDate("not a date", en)).toBe("not a date");
  });
});

describe("relative times", () => {
  const at = Date.parse(ISO);
  const inSeconds = (seconds: number, detailed = false) =>
    relativeTime(ISO, at - seconds * 1000, en, detailed);

  it("rounds to minutes, shows at least one and carries 60 minutes into the hour", () => {
    expect(inSeconds(0)).toBe("now");
    expect(inSeconds(29)).toBe("in 1m");
    expect(inSeconds(-29)).toBe("1m ago");
    expect(inSeconds(59 * MINUTE + 29)).toBe("in 59m");
    expect(inSeconds(59 * MINUTE + 30)).toBe("in 1h");
    expect(inSeconds(-(2 * HOUR + 5 * MINUTE))).toBe("2h 5m ago");
    expect(inSeconds(DAY - 1)).toBe("in 24h");
  });

  it("switches to whole days from one day on", () => {
    expect(inSeconds(DAY)).toBe("in 1 day");
    expect(inSeconds(3 * DAY + 13 * HOUR)).toBe("in 4 days");
    expect(inSeconds(-3 * DAY)).toBe("3 days ago");
  });

  it("details days, hours and minutes", () => {
    expect(inSeconds(3 * DAY + 4 * HOUR + 5 * MINUTE, true)).toBe("in 3d 4h 5m");
    expect(inSeconds(-2 * DAY, true)).toBe("2d ago");
    expect(inSeconds(10, true)).toBe("in 1m");
  });

  it("is empty without a valid date", () => {
    expect(relativeTime(null, at, en)).toBe("");
    expect(relativeTime("not a date", at, en, true)).toBe("");
  });

  it("speaks zh-CN", () => {
    expect(relativeTime(ISO, at + (2 * HOUR + 5 * MINUTE) * 1000, zh)).toBe("2小时 5分钟前");
    expect(relativeTime(ISO, at - (DAY + 30 * MINUTE) * 1000, zh, true)).toBe("1天 30分钟后");
  });
});
