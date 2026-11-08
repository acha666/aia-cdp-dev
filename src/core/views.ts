// The read model of the public API: the certificate and CRL target lists, built from config.json
// and catalog.json (one `get` each per request, through readState in ./catalog.ts), and the blob a
// SHA-256 names. Their shapes are the response schemas of src/http/schemas.ts, against which the
// routes type-check every view. Ids and kinds come from the catalog and config, never from a store
// key, and a store key never appears in a view. Nothing here decodes a certificate or a CRL: the UI
// decodes the blob itself.
//
// Lists are complete arrays (no pagination), certificates in id order and targets in targetId
// order (code units; the UI sorts for display).
//
// What the catalog and config name but the store cannot back throws, and the HTTP layer answers
// its generic 500: never a 404, an empty list or a partial 200.
import type { Catalog, Config } from "./catalog.ts";
import { downloadPaths } from "./resources.ts";

// Helpers -----------------------------------------------------------------------------------------

/** The entries of a record in key order (code units; keys are unique). */
function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
}

// Certificates ------------------------------------------------------------------------------------

/** GET /api/v1/certificates: one item per catalog certificate, in id order. */
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

// CRL targets -------------------------------------------------------------------------------------

/**
 * GET /api/v1/crls: one item per configured target, in targetId order. A catalog current whose
 * target config.json no longer defines is not listed (no kind, no paths).
 */
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

// Blobs -------------------------------------------------------------------------------------------

/**
 * GET /api/v1/blobs/{sha256}: the store key and kind of the catalog certificate with this id, or of
 * the current CRL of a configured target with this SHA-256; undefined for anything else (a history
 * version, a current whose target config.json no longer defines).
 */
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
