import { useStorage } from "@vueuse/core";
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LOCALE_STORAGE_KEY, normalizeLocale } from "@/i18n";
import type { AppLocale } from "@/i18n";

export function useLocale() {
  const { locale } = useI18n({ useScope: "global" });
  const stored = useStorage<string | null>(LOCALE_STORAGE_KEY, null, undefined, {
    onError: () => undefined,
  });

  watch(stored, (value) => {
    const next = value === null ? null : normalizeLocale(value);
    if (next !== null) {
      locale.value = next;
    }
  });

  return computed<AppLocale>({
    get: () => locale.value as AppLocale,
    set: (value) => {
      locale.value = value;
      stored.value = value;
    },
  });
}
