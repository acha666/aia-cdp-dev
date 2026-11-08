import { createSharedComposable, useIntervalFn, useNow } from "@vueuse/core";

export const useClock = createSharedComposable(() =>
  useNow({ scheduler: (update) => useIntervalFn(update, 60_000) })
);
