import { z } from "zod";
import type { ObjectStore } from "./store.ts";

export const CONFIG_KEY = "config.json";
export const CATALOG_KEY = "catalog.json";

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Expected lowercase hex SHA-256");

const Sha1Hex = z.string().regex(/^[0-9a-f]{40}$/, "Expected lowercase hex SHA-1");

const KeyId = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/, "Expected lowercase hex bytes")
  .nullable();

const SerialNumber = z.string().regex(/^(?:[0-9A-F]{2})+$/, "Expected uppercase hex bytes");

export const Size = z.number().int().positive().describe("DER size in bytes");

export const Timestamp = z.iso.datetime({ precision: 3 });

const Decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/, "Expected a decimal integer");

export const TargetId = z.uuid().regex(/^[0-9a-f-]+$/, "Expected a lowercase UUID");

export const CrlKind = z.enum(["full", "delta"]);
export type CrlKind = z.infer<typeof CrlKind>;

const ConfigCertificate = z.strictObject({ label: z.string() });

const ConfigTarget = z.strictObject({ issuer: Sha256Hex, kind: CrlKind, label: z.string() });

const ConfigPath = z.union(
  [z.strictObject({ certificate: Sha256Hex }), z.strictObject({ target: TargetId })],
  { error: "Expected { certificate: <lowercase hex SHA-256> } or { target: <lowercase UUID> }" }
);

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

export const CertificateSummarySchema = z
  .strictObject({
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
    revokedCount: z.number().int().nonnegative(),
    sha1: Sha1Hex,
    nextPublish: Timestamp.nullable(),
  })
  .meta({ id: "CrlSummary" });

const CurrentCrl = z.strictObject({
  sha256: Sha256Hex,
  key: z.string(),
  size: Size,
  publishedAt: Timestamp,
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

export function emptyConfig(): Config {
  return { version: 1, certificates: {}, targets: {}, paths: {} };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return JSON.parse(text) as unknown;
}

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
  hasConfig: boolean;
  catalog: Catalog;
  catalogEtag: string | null;
}

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

const BACKOFF_MS = [250, 500, 1000];

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CatalogMutation<R> {
  next?: Catalog;
  result: R;
}

export interface CatalogDeps {
  store: ObjectStore;
  sleep?: (ms: number) => Promise<void>;
}

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
