import { createSharedComposable, useIntervalFn, useNow } from "@vueuse/core";

/**
 * The one clock of the page: status badges, relative times and the overview's "needs
 * attention" count read the same Date, ticking once a minute. Shared while any component uses it.
 */
export const useClock = createSharedComposable(() =>
  useNow({ scheduler: (update) => useIntervalFn(update, 60_000) })
);
