/**
 * Access to the generated test PKI in `pki/` and its `manifest.json`, which describes each
 * file and the outcome the tests expect. Regenerate it with `pnpm run fixtures`.
 *
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CrlKind } from "../../src/core/catalog.ts";
import manifest from "./pki/manifest.json" with { type: "json" };

export { manifest };

const FIXTURES_DIR = fileURLToPath(new URL("./pki/", import.meta.url));

/** The fixed time the fixtures are valid at. */
export const NOW = new Date(manifest.now);

type ManifestCertificate = (typeof manifest.certificates)[number];
type ManifestCrl = (typeof manifest.crls)[number] & { kind: CrlKind };

export function cert(name: string): ManifestCertificate {
  const found = manifest.certificates.find((c) => c.name === name);
  if (!found) {
    throw new Error(`no manifest certificate ${name}`);
  }
  return found;
}

export function crlEntry(file: string): ManifestCrl {
  const found = manifest.crls.find((c) => c.file === file);
  if (!found) {
    throw new Error(`no manifest CRL ${file}`);
  }
  return found as ManifestCrl;
}

export function fixturePath(path: string): string {
  return `${FIXTURES_DIR}${path}`;
}

export function fixture(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fixturePath(path)));
}

export function fixtureText(path: string): string {
  return readFileSync(fixturePath(path), "utf8");
}
