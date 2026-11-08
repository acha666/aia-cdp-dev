import { applyConfig } from "../../src/core/admin.ts";
import type { ApplyConfigResult, ConfigPrecondition } from "../../src/core/admin.ts";
import { CONFIG_KEY, emptyConfig } from "../../src/core/catalog.ts";
import type { Config, CrlKind } from "../../src/core/catalog.ts";
import { importCertificate } from "../../src/core/certificates.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { publishCrl } from "../../src/core/publish.ts";
import type { CurrentVersion, PublishLogRecord, PublishResult } from "../../src/core/publish.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { cert, crlEntry, fixture, manifest, NOW } from "../fixtures/pki.ts";

export interface TargetSpec {
  issuer: string;
  kind: CrlKind;
}

export const IMPORTED: readonly string[] = manifest.certificates
  .filter((certificate) => certificate.import)
  .map((certificate) => certificate.name);

export const DEFAULT_TARGETS: readonly TargetSpec[] = [
  { issuer: "issuing-ca-1", kind: "full" },
  { issuer: "issuing-ca-1", kind: "delta" },
  { issuer: "issuing-ca-2", kind: "full" },
  { issuer: "issuing-ca-2", kind: "delta" },
  { issuer: "root-ca", kind: "full" },
  { issuer: "ed25519-ca", kind: "full" },
  { issuer: "ed448-ca", kind: "full" },
];

const ISSUING_FULL_ALIAS = "/crl/issuing-ca-1-alias.crl";

function targetPath({ issuer, kind }: TargetSpec): string {
  return `/${kind === "full" ? "crl" : "dcrl"}/${issuer}.crl`;
}

export function downloadsOf(issuer: string, kind: CrlKind): string[] {
  const path = targetPath({ issuer, kind });
  const paths = issuer === "issuing-ca-1" && kind === "full" ? [ISSUING_FULL_ALIAS, path] : [path];
  return paths.flatMap((each) => [each, `${each}.pem`]);
}

export interface PublishSetup {
  config: Config;
  target(issuer: string, kind: CrlKind): string;
}

export interface SetupOptions {
  certificates?: readonly string[];
  targets?: readonly TargetSpec[];
  configure?: (config: Config) => void;
}

export async function importOrThrow(store: ObjectStore, bytes: Uint8Array): Promise<string> {
  const imported = await importCertificate({ store, now: () => NOW }, bytes);
  if (!("outcome" in imported)) {
    throw new Error(`import: ${imported.error}`);
  }
  return imported.id;
}

export async function applyOver(store: ObjectStore, config: unknown): Promise<ApplyConfigResult> {
  const stored = await store.get(CONFIG_KEY);
  const precondition: ConfigPrecondition =
    stored === null ? { ifNoneMatch: "*" } : { ifMatch: await sha256Hex(stored.bytes) };
  return applyConfig({ store }, config, precondition);
}

export function versionOf(file: string): CurrentVersion {
  const { sha256, crlNumber, thisUpdate } = crlEntry(file);
  return { sha256, crlNumber, thisUpdate: new Date(thisUpdate).toISOString() };
}

export async function setupPublish(
  store: ObjectStore,
  { certificates = IMPORTED, targets = DEFAULT_TARGETS, configure }: SetupOptions = {}
): Promise<PublishSetup> {
  for (const name of certificates) {
    await importOrThrow(store, fixture(cert(name).der));
  }
  const ids = new Map<string, string>();
  const config = emptyConfig();
  for (const spec of targets) {
    const id = crypto.randomUUID();
    ids.set(`${spec.issuer}/${spec.kind}`, id);
    config.targets[id] = {
      issuer: cert(spec.issuer).sha256,
      kind: spec.kind,
      label: `${spec.issuer} ${spec.kind}`,
    };
    config.paths[targetPath(spec)] = { target: id };
    if (spec.issuer === "issuing-ca-1" && spec.kind === "full") {
      config.paths[ISSUING_FULL_ALIAS] = { target: id };
    }
  }
  configure?.(config);
  const applied = await applyOver(store, config);
  if ("error" in applied) {
    throw new Error(`applyConfig: ${JSON.stringify(applied)}`);
  }
  return {
    config: applied.config,
    target(issuer, kind) {
      const id = ids.get(`${issuer}/${kind}`);
      if (id === undefined) {
        throw new Error(`no ${kind} target of ${issuer} in this setup`);
      }
      return id;
    },
  };
}

export interface PublishRun {
  result: PublishResult;
  record: PublishLogRecord;
  sleeps: number[];
}

export async function publish(store: ObjectStore, bytes: Uint8Array): Promise<PublishRun> {
  const records: PublishLogRecord[] = [];
  const sleeps: number[] = [];
  const result = await publishCrl(
    {
      store,
      now: () => new Date(NOW),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (record) => {
        records.push(record);
      },
    },
    bytes
  );
  const [record, ...more] = records;
  if (record === undefined || more.length > 0) {
    throw new Error(`publishCrl logged ${records.length} records instead of one`);
  }
  return { result, record, sleeps };
}

export function publishFile(store: ObjectStore, file: string): Promise<PublishRun> {
  return publish(store, fixture(file));
}
