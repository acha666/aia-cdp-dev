// Display order of CRL targets.

/** Display order of targets: by label, then full before delta of the same label, then by id. */
export function compareTargets(
  a: { label: string; kind: "full" | "delta"; targetId: string },
  b: { label: string; kind: "full" | "delta"; targetId: string },
  locale: string
): number {
  return (
    a.label.localeCompare(b.label, locale) ||
    (a.kind === b.kind ? 0 : a.kind === "full" ? -1 : 1) ||
    a.targetId.localeCompare(b.targetId)
  );
}
