import { useTitle } from "@vueuse/core";
import { toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";
import { siteName } from "@/site";

export function usePageTitle(page: MaybeRefOrGetter<string>): void {
  useTitle(() => `${toValue(page)} · ${siteName}`);
}
