/**
 * Importing and deleting CA certificates. An imported certificate can be used as a CRL issuer
 * and served under `/ca/` paths.
 *
 * @packageDocumentation
 */

import { certificateBlobKey, certificateReferences, readCatalog, updateState } from "./catalog.ts";
import type { CatalogCertificate, CatalogDeps, CertificateSummary, State } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { parseCertificate } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import { buildCertificateSummary } from "./summary.ts";

export interface ImportDeps extends CatalogDeps {
  now: () => Date;
}

export interface ImportSuccess {
  outcome: "created" | "unchanged";
  id: string;
  entry: CatalogCertificate;
}

export type ImportResult =
  | ImportSuccess
  | { error: "invalid_certificate"; details: { reason: PkiParseReason } }
  | { error: "concurrent_update"; id: string };

/** Imports a certificate (DER or PEM); importing it again is `unchanged`. */
export async function importCertificate(
  deps: ImportDeps,
  bytes: Uint8Array
): Promise<ImportResult> {
  const now = deps.now();
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

/** Where a certificate that cannot be deleted is still used. */
export interface CertificateReference {
  object: "config.json" | "catalog.json";
  path: string[];
}

export type DeleteCertificateResult =
  | { deleted: true }
  | { error: "not_found" }
  | { error: "referenced"; details: { references: CertificateReference[] } }
  | { error: "concurrent_update" };

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
 * Deletes a certificate that nothing references: no config entry and no current CRL it
 * verified.
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
  // The blob goes only after the catalog no longer points at it.
  await deps.store.delete(outcome.key);
  return { deleted: true };
}
