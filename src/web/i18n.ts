import { watch } from "vue";
import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NAMES: Record<AppLocale, string> = { en: "English", "zh-CN": "简体中文" };

export const LOCALE_STORAGE_KEY = "locale-preference";

type MessageSchema = typeof en;

/** The part of vue-i18n that the formatting helpers need, so they can be tested without it. */
export interface I18nText {
  readonly locale: { readonly value: string };
  readonly t: (key: string, named?: Record<string, unknown>) => string;
  readonly te: (key: string) => boolean;
}

/** Maps a language tag to a supported locale by its primary language. */
export function normalizeLocale(tag: string): AppLocale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return primary === "zh" ? "zh-CN" : primary === "en" ? "en" : null;
}

/** Uses the stored choice, then the browser languages, then English. */
function detectLocale(): AppLocale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable, e.g. when blocked by privacy settings.
  }
  const locales = [stored ?? "", ...navigator.languages].map(normalizeLocale);
  return locales.find((locale) => locale !== null) ?? "en";
}

export function createAppI18n(locale: AppLocale = detectLocale()) {
  const i18n = createI18n<[MessageSchema], AppLocale, false>({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages: { en, "zh-CN": zhCN },
  });
  watch(
    i18n.global.locale,
    (value) => {
      document.documentElement.lang = value;
    },
    { immediate: true }
  );
  return i18n;
}
