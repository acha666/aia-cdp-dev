import type { Catalog, Config } from "./catalog.ts";
import { downloadPaths } from "./resources.ts";

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
}

export function certificateList(config: Config, catalog: Catalog) {
  return sortedEntries(catalog.certificates).map(([id, entry]) => ({
    id,
    label: config.certificates[id]?.label ?? null,
    importedAt: entry.importedAt,
    size: entry.size,
    summary: entry.summary,
    downloads: downloadPaths(config, { certificate: id }),
    targets: sortedEntries(config.targets)
      .filter(([, target]) => target.issuer === id)
      .map(([targetId, { kind, label }]) => ({ targetId, kind, label })),
  }));
}

export function crlTargetList(config: Config, catalog: Catalog) {
  return sortedEntries(config.targets).map(([targetId, target]) => {
    const issuer = catalog.certificates[target.issuer];
    if (issuer === undefined) {
      throw new Error(
        `Target ${targetId} names issuer ${target.issuer}, which is not in the catalog`
      );
    }
    const current = catalog.targets[targetId]?.current ?? null;
    return {
      targetId,
      kind: target.kind,
      label: target.label,
      issuer: {
        id: target.issuer,
        label: config.certificates[target.issuer]?.label ?? null,
        subjectCN: issuer.summary.subjectCN,
      },
      downloads: downloadPaths(config, { target: targetId }),
      current:
        current === null
          ? null
          : {
              sha256: current.sha256,
              size: current.size,
              publishedAt: current.publishedAt,
              verifier: current.verifier,
              summary: current.summary,
            },
    };
  });
}

export function findBlob(
  config: Config,
  catalog: Catalog,
  sha256: string
): { key: string; kind: "certificate" | "crl" } | undefined {
  const certificate = catalog.certificates[sha256];
  if (certificate !== undefined) {
    return { key: certificate.key, kind: "certificate" };
  }
  for (const targetId of Object.keys(config.targets)) {
    const current = catalog.targets[targetId]?.current;
    if (current?.sha256 === sha256) {
      return { key: current.key, kind: "crl" };
    }
  }
  return undefined;
}
