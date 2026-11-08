// config.json and catalog.json. A value not in its canonical form (uppercase hex, a time without
// milliseconds, a misspelled key) is invalid, never normalized, so readers can compare strings.
import { z } from "zod";
import type { ObjectStore } from "./store.ts";

export const CONFIG_KEY = "config.json";
export const CATALOG_KEY = "catalog.json";

// Field formats ---------------------------------------------------------------------------------

/** Certificate id (SHA-256 of the DER) and CRL content digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Expected lowercase hex SHA-256");

const Sha1Hex = z.string().regex(/^[0-9a-f]{40}$/, "Expected lowercase hex SHA-1");

/** Subject / Authority Key Identifier; null without the extension or the AKI's keyIdentifier. */
const KeyId = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/, "Expected lowercase hex bytes")
  .nullable();

/** Hex of the INTEGER content bytes, leading 00 kept. */
const SerialNumber = z.string().regex(/^(?:[0-9A-F]{2})+$/, "Expected uppercase hex bytes");

export const Size = z.number().int().positive().describe("DER size in bytes");

/** Date.toISOString(): UTC with milliseconds, e.g. 2026-01-01T00:00:00.000Z. */
export const Timestamp = z.iso.datetime({ precision: 3 });

/** CRL Number / Delta CRL base, compared as BigInt. */
const Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/, "Expected a decimal integer");

/** z.uuid() also checks the RFC 9562 version and variant. */
export const TargetId = z.uuid().regex(/^[0-9a-f-]+$/, "Expected a lowercase UUID");

export const CrlKind = z.enum(["full", "delta"]);
export type CrlKind = z.infer<typeof CrlKind>;

// config.json (operator) --------------------------------------------------------------------------

const ConfigCertificate = z.strictObject({ label: z.string() });

const ConfigTarget = z.strictObject({ issuer: Sha256Hex, kind: CrlKind, label: z.string() });

// The path rules are V2 / V3 in src/core/admin.ts, so that they are reported with their rule id.
const ConfigPath = z.union(
  [z.strictObject({ certificate: Sha256Hex }), z.strictObject({ target: TargetId })],
  { error: "Expected { certificate: <lowercase hex SHA-256> } or { target: <lowercase UUID> }" }
);

/** The three maps are required and may be empty (see emptyConfig). */
export const ConfigSchema = z
  .strictObject({
    version: z.literal(1),
    certificates: z.record(Sha256Hex, ConfigCertificate),
    targets: z.record(TargetId, ConfigTarget),
    paths: z.record(z.string(), ConfigPath),
  })
  .meta({ id: "Config" });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigTarget = z.infer<typeof ConfigTarget>;
export type ConfigPath = z.infer<typeof ConfigPath>;

/**
 * Every certificate reference in config.json with its key path, in order: certificates keys, path
 * certificates, target issuers. Rule V4 and deleteCertificate check these.
 */
export function certificateReferences(config: Config): { id: string; path: string[] }[] {
  return [
    ...Object.keys(config.certificates).map((id) => ({ id, path: ["certificates", id] })),
    ...Object.entries(config.paths).flatMap(([path, entry]) =>
      "certificate" in entry
        ? [{ id: entry.certificate, path: ["paths", path, "certificate"] }]
        : []
    ),
    ...Object.entries(config.targets).map(([id, target]) => ({
      id: target.issuer,
      path: ["targets", id, "issuer"],
    })),
  ];
}

// catalog.json (service) --------------------------------------------------------------------------

export const CertificateSummarySchema = z
  .strictObject({
    /** The first string-valued CN in RDN order, as the detail page shows Common Name. */
    subjectCN: z.string().nullable(),
    issuerCN: z.string().nullable(),
    serialNumber: SerialNumber,
    notBefore: Timestamp,
    notAfter: Timestamp,
    subjectKeyId: KeyId,
    authorityKeyId: KeyId,
    sha1: Sha1Hex,
  })
  .meta({ id: "CertificateSummary" });

const CatalogCertificate = z.strictObject({
  /** certificateBlobKey(id). */
  key: z.string(),
  size: Size,
  importedAt: Timestamp,
  summary: CertificateSummarySchema,
});

export const CrlSummarySchema = z
  .strictObject({
    crlNumber: Decimal.nullable(),
    baseCrlNumber: Decimal.nullable(),
    thisUpdate: Timestamp,
    nextUpdate: Timestamp.nullable(),
    /** Entries of revokedCertificates; 0, not unknown, when the list is absent. */
    revokedCount: z.number().int().nonnegative(),
    sha1: Sha1Hex,
    /** AD CS Next CRL Publish (1.3.6.1.4.1.311.21.4), null without the extension. */
    nextPublish: Timestamp.nullable(),
  })
  .meta({ id: "CrlSummary" });

const CurrentCrl = z.strictObject({
  sha256: Sha256Hex,
  key: z.string(),
  size: Size,
  publishedAt: Timestamp,
  /** Id of the certificate that verified the signature. */
  verifier: Sha256Hex,
  summary: CrlSummarySchema,
});

const CatalogTarget = z.strictObject({ current: CurrentCrl.nullable() });

export const CatalogSchema = z
  .strictObject({
    version: z.literal(1),
    certificates: z.record(Sha256Hex, CatalogCertificate),
    targets: z.record(TargetId, CatalogTarget),
  })
  .meta({ id: "Catalog" });

export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogCertificate = z.infer<typeof CatalogCertificate>;
export type CertificateSummary = z.infer<typeof CertificateSummarySchema>;
export type CrlSummary = z.infer<typeof CrlSummarySchema>;
export type CurrentCrl = z.infer<typeof CurrentCrl>;

export function certificateBlobKey(id: string): string {
  return `blobs/certificates/${id}.der`;
}

export function emptyCatalog(): Catalog {
  return { version: 1, certificates: {}, targets: {} };
}

/** The smallest valid config.json; also stands for a missing one. */
export function emptyConfig(): Config {
  return { version: 1, certificates: {}, targets: {}, paths: {} };
}

// Encoding --------------------------------------------------------------------------------------

/** The canonical bytes of config.json / catalog.json: two-space indent, trailing newline. */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** UTF-8 JSON, a leading BOM skipped. Throws on bytes that are not UTF-8 or not JSON. */
export function decodeJson(bytes: Uint8Array): unknown {
  // Both options spelled out: the Workers types declare them as required.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return JSON.parse(text) as unknown;
}

/**
 * config.json or catalog.json in the store is not JSON or does not match its schema. Only an
 * out-of-band write causes this; the service never overwrites such an object on its own (the
 * request fails with 500).
 */
export class InvalidStoredObjectError extends Error {
  override name = "InvalidStoredObjectError";
  readonly key: string;

  constructor(key: string, options?: ErrorOptions) {
    super(`${key} in the store is invalid`, options);
    this.key = key;
  }
}

function parseStored<T>(key: string, bytes: Uint8Array, schema: z.ZodType<T>): T {
  try {
    return schema.parse(decodeJson(bytes));
  } catch (error) {
    throw new InvalidStoredObjectError(key, { cause: error });
  }
}

// Reading ---------------------------------------------------------------------------------------

/** catalog.json and its store ETag; a missing catalog is empty with etag null. */
export async function readCatalog(
  store: ObjectStore
): Promise<{ catalog: Catalog; etag: string | null }> {
  const object = await store.get(CATALOG_KEY);
  if (object === null) {
    return { catalog: emptyCatalog(), etag: null };
  }
  return { catalog: parseStored(CATALOG_KEY, object.bytes, CatalogSchema), etag: object.etag };
}

export interface State {
  config: Config;
  /** Whether config.json exists: only the health check tells a missing one from an empty one. */
  hasConfig: boolean;
  catalog: Catalog;
  catalogEtag: string | null;
}

/**
 * Throws InvalidStoredObjectError when config.json or catalog.json is present but invalid; store
 * errors propagate. The catalog ETag is the store's, opaque.
 */
export async function readState(store: ObjectStore): Promise<State> {
  const [configObject, { catalog, etag: catalogEtag }] = await Promise.all([
    store.get(CONFIG_KEY),
    readCatalog(store),
  ]);
  const config =
    configObject === null
      ? emptyConfig()
      : parseStored(CONFIG_KEY, configObject.bytes, ConfigSchema);
  return { config, hasConfig: configObject !== null, catalog, catalogEtag };
}

// Conditional catalog write ---------------------------------------------------------------------

/** Waits before each retry of a lost catalog write. */
const BACKOFF_MS = [250, 500, 1000];

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Without `next`, updateState returns `result` and writes nothing. */
export interface CatalogMutation<R> {
  next?: Catalog;
  result: R;
}

export interface CatalogDeps {
  store: ObjectStore;
  /** A timer when omitted; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read-modify-write of catalog.json, conditional on the ETag of each attempt's own read. `mutate`
 * must derive `next` from the state it gets: after a lost race it runs again on a fresh read, so
 * the other writer's changes are kept. Its writes to other objects must be create-only, as they
 * stay when the catalog write is lost. After 1 + 3 lost attempts → concurrent_update.
 *
 * A throwing `put` is not retried: it may have taken effect, and R2's per-key write rate limit is
 * not a lost race. An invalid `next` throws instead of being written; an invalid stored object
 * throws InvalidStoredObjectError.
 */
export async function updateState<R>(
  { store, sleep = realSleep }: CatalogDeps,
  mutate: (state: State) => CatalogMutation<R> | Promise<CatalogMutation<R>>
): Promise<R | { error: "concurrent_update" }> {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const wait = BACKOFF_MS[attempt - 1];
    if (wait !== undefined) {
      await sleep(wait);
    }
    const state = await readState(store);
    const mutation = await mutate(state);
    if (mutation.next === undefined) {
      return mutation.result;
    }
    const next = CatalogSchema.parse(mutation.next);
    const written = await store.put(
      CATALOG_KEY,
      encodeJson(next),
      state.catalogEtag === null ? { ifNoneMatch: "*" } : { ifMatch: state.catalogEtag }
    );
    if (written.ok) {
      return mutation.result;
    }
  }
  return { error: "concurrent_update" };
}
