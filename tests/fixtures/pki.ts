import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CrlKind } from "../../src/core/catalog.ts";
import manifest from "./pki/manifest.json" with { type: "json" };

// The committed tree that tests/fixtures/generate-test-data.sh writes (pnpm run fixtures). Digests,
// key ids, sizes and signatures change with every generation: read them from the files or from
// `manifest` (its fields are the contract in docs/implementation/appendix-d-fixture-matrix.md),
// never write them as literals.

export { manifest };

/** Absolute path of tests/fixtures/pki/, with a trailing slash. */
const FIXTURES_DIR = fileURLToPath(new URL("./pki/", import.meta.url));

export const NOW = new Date(manifest.now);

type ManifestCertificate = (typeof manifest.certificates)[number];
type ManifestCrl = (typeof manifest.crls)[number] & { kind: CrlKind };

/** The manifest entry of a certificate fixture (certs/<name>.der). */
export function cert(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest certificate ${name}`);
  }
  return found;
}

/** The manifest entry of a CRL fixture (crls/<issuer>/<case>.der). */
export function crlEntry(file: string): ManifestCrl {
  const found = manifest.crls.find((c) => c.file === file);
  if (!found) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found as ManifestCrl;
}

/** Absolute path of a fixture, given relative to FIXTURES_DIR (e.g. "certs/root-ca.der"). */
export function fixturePath(path: string): string {
  return `${FIXTURES_DIR}${path}`;
}

/** The bytes of a fixture, in a fresh ArrayBuffer (usable with WebCrypto as is). */
export function fixture(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fixturePath(path)));
}

/** The text of a fixture (a PEM file). */
export function fixtureText(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}
