// Certificate import and deletion.
// There is one commit point, the catalog write: no companion objects, no edge cache. Importing does
// not authorize anything: a certificate only becomes an issuer once a config target names it.
import { certificateBlobKey, certificateReferences, readCatalog, updateState } from "./catalog.ts";
import type { CatalogCertificate, CatalogDeps, CertificateSummary, State } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { parseCertificate } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import { buildCertificateSummary } from "./summary.ts";

// Import ------------------------------------------------------------------------------------------

export interface ImportDeps extends CatalogDeps {
  now: () => Date;
}

/** created added the catalog entry; unchanged found the id in the catalog and added none. */
export interface ImportSuccess {
  outcome: "created" | "unchanged";
  /** SHA-256 of the DER. */
  id: string;
  entry: CatalogCertificate;
}

export type ImportResult =
  | ImportSuccess
  | { error: "invalid_certificate"; details: { reason: PkiParseReason } }
  | { error: "concurrent_update"; id: string };

/**
 * Imports one certificate (DER or a single PEM block; the format is recognized from the bytes).
 * The id is the SHA-256 of the DER. Already in the catalog → `unchanged` with the stored entry and
 * no write. Otherwise the blob is written create-only (an existing blob has the same bytes: the
 * key is the digest) and the entry added by updateState, which checks again for the id on every
 * attempt, so two concurrent imports of one certificate end as one `created` and one `unchanged`.
 *
 * Any rejection happens before the first write. If the catalog write is lost (concurrent_update)
 * or the process dies after the blob write, only an unreferenced blob remains; certificates are
 * listed from the catalog, so it stays invisible.
 */
export async function importCertificate(
  deps: ImportDeps,
  bytes: Uint8Array
): Promise<ImportResult> {
  const now = deps.now();
  // Every PkiParseError is a 422. Only an admin imports, so what the certificate itself gets wrong
  // is left to the tool that made it.
  let der: Uint8Array;
  let summary: CertificateSummary;
  try {
    der = toDer(bytes, "certificate");
    const certificate = parseCertificate(der);
    summary = await buildCertificateSummary(certificate, der);
  } catch (error) {
    if (error instanceof PkiParseError) {
      return { error: "invalid_certificate", details: { reason: error.reason } };
    }
    throw error;
  }
  const id = await sha256Hex(der);

  const { catalog } = await readCatalog(deps.store);
  const existing = catalog.certificates[id];
  if (existing !== undefined) {
    return { outcome: "unchanged", id, entry: existing };
  }

  const key = certificateBlobKey(id);
  // precondition-failed: the blob is already there with these very bytes.
  await deps.store.put(key, der, { ifNoneMatch: "*" });

  const entry: CatalogCertificate = {
    key,
    size: der.byteLength,
    importedAt: now.toISOString(),
    summary,
  };
  const update = await updateState<Omit<ImportSuccess, "id">>(deps, ({ catalog: current }) => {
    const raced = current.certificates[id];
    if (raced !== undefined) {
      return { result: { outcome: "unchanged", entry: raced } };
    }
    return {
      next: { ...current, certificates: { ...current.certificates, [id]: entry } },
      result: { outcome: "created", entry },
    };
  });
  if ("error" in update) {
    return { error: update.error, id };
  }
  return { ...update, id };
}

// Deletion ----------------------------------------------------------------------------------------

/** Where a certificate is referenced (`details.references[]` of referenced). */
export interface CertificateReference {
  object: "config.json" | "catalog.json";
  /** Keys from the object's root. */
  path: string[];
}

export type DeleteCertificateResult =
  | { deleted: true }
  | { error: "not_found" }
  | { error: "referenced"; details: { references: CertificateReference[] } }
  | { error: "concurrent_update" };

/**
 * Every reference to certificate `id`: config.json's (certificateReferences, what rule V4 checks),
 * and the verifier of any current CRL in the catalog, also of a target removed from config.json. A
 * target's history is verified by the certificate that verified its current (V9), so that
 * reference protects the history too, unless the target's id was removed and added back with
 * another issuer (checkConfigMigration in ./admin.ts).
 */
function referencesOf(state: State, id: string): CertificateReference[] {
  const references: CertificateReference[] = certificateReferences(state.config)
    .filter((reference) => reference.id === id)
    .map(({ path }) => ({ object: "config.json", path }));
  for (const [targetId, target] of Object.entries(state.catalog.targets)) {
    if (target.current?.verifier === id) {
      references.push({
        object: "catalog.json",
        path: ["targets", targetId, "current", "verifier"],
      });
    }
  }
  return references;
}

/**
 * Removes an unreferenced certificate (`id`, the SHA-256 of its DER) from the catalog, then deletes
 * its blob. The verifier of a target's current CRL stays referenced, also once the target is
 * removed from config.json. The catalog write is conditional and retried (updateState); config.json
 * is not written, and an apply that adds a reference in between is the accepted cross-object window
 * (one operator at a time). A crash between the two writes leaves an unreferenced blob, which a
 * later import of the same certificate writes again.
 */
export async function deleteCertificate(
  deps: CatalogDeps,
  id: string
): Promise<DeleteCertificateResult> {
  const outcome = await updateState<DeleteCertificateResult | { key: string }>(deps, (state) => {
    const entry = state.catalog.certificates[id];
    if (entry === undefined) {
      return { result: { error: "not_found" } };
    }
    const references = referencesOf(state, id);
    if (references.length > 0) {
      return { result: { error: "referenced", details: { references } } };
    }
    const { [id]: _deleted, ...certificates } = state.catalog.certificates;
    return { next: { ...state.catalog, certificates }, result: { key: entry.key } };
  });
  if (!("key" in outcome)) {
    return outcome;
  }
  await deps.store.delete(outcome.key);
  return { deleted: true };
}
