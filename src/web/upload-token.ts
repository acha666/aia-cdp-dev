import { shallowRef } from "vue";

/** The upload token typed into the UI; kept in memory only, for the page's lifetime. */
export const uploadToken = shallowRef("");
