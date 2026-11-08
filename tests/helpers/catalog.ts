// Catalog and config values built from the fixtures: digests, key ids and sizes come from the files
// or manifest.json, never from literals.
import type { Catalog, CatalogCertificate, Config, CurrentCrl } from "../../src/core/catalog.ts";
import {
  CATALOG_KEY,
  certificateBlobKey,
  emptyConfig,
  encodeJson,
} from "../../src/core/catalog.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import { crlBlobKey } from "../../src/core/history.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { buildCertificateSummary, buildCrlSummary } from "../../src/core/summary.ts";
import { cert, crlEntry, fixture, NOW } from "../fixtures/pki.ts";

/**
 * A config.json that serves each certificate fixture at /ca/<name>.crt, with a full CRL target at
 * /crl/<name>.crl.
 */
export function configFor(names: readonly string[]): Config {
  const config = emptyConfig();
  for (const name of names) {
    const id = cert(name).sha256;
    const target = crypto.randomUUID();
    config.certificates[id] = { label: name };
    config.targets[target] = { issuer: id, kind: "full", label: name };
    config.paths[`/ca/${name}.crt`] = { certificate: id };
    config.paths[`/crl/${name}.crl`] = { target };
  }
  return config;
}

/** The catalog entry importCertificate writes for certs/<name>.der at NOW. */
export async function certificateEntry(
  name: string
): Promise<{ id: string; entry: CatalogCertificate }> {
  const { der: path, sha256: id } = cert(name);
  const der = fixture(path);
  return {
    id,
    entry: {
      key: certificateBlobKey(id),
      size: der.byteLength,
      importedAt: NOW.toISOString(),
      summary: await buildCertificateSummary(parseCertificate(der), der),
    },
  };
}

/**
 * The `current` record publishCrl writes for a CRL fixture verified by its issuer, published at
 * NOW: blob key and summary come from crlBlobKey and buildCrlSummary (the blob is not written).
 */
export async function currentCrl(file: string, targetId: string): Promise<CurrentCrl> {
  const entry = crlEntry(file);
  const der = fixture(file);
  const summary = await buildCrlSummary(parseCRL(der), der);
  return {
    sha256: entry.sha256,
    key: crlBlobKey(targetId, summary, entry.sha256),
    size: der.byteLength,
    publishedAt: NOW.toISOString(),
    verifier: cert(entry.issuer).sha256,
    summary,
  };
}

/** Writes catalog.json in the canonical format, unconditionally. */
export async function putCatalog(store: ObjectStore, catalog: Catalog): Promise<void> {
  await store.put(CATALOG_KEY, encodeJson(catalog));
}
