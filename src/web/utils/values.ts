import type { I18nText } from "@/i18n";

export type Value =
  string | { hex: string } | { lines: readonly string[] } | { tags: readonly string[] };

export interface Row {
  label: string;
  value: Value | null | undefined;
  title?: string;
}

export const rows = (...list: (Row | false)[]): Row[] => list.filter((row) => row !== false);

export const rowOf =
  <K extends string>(i18n: Pick<I18nText, "t">, group: string) =>
  (key: K, value: Row["value"]): Row => ({ label: i18n.t(`${group}.${key}`), value });
