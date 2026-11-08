import { createSharedComposable, useIntervalFn, useNow } from "@vueuse/core";

/** The current time, shared by all components and updated every minute. */
export const useClock = createSharedComposable(() =>
  useNow({ scheduler: (update) => useIntervalFn(update, 60_000) })
);
