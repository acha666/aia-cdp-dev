import type { z } from "zod";
import {
  certificateReferences,
  CONFIG_KEY,
  ConfigSchema,
  decodeJson,
  encodeJson,
  readCatalog,
} from "./catalog.ts";
import type { Catalog, Config, CrlKind } from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import type { ObjectStore } from "./store.ts";

export interface ConfigIssue {
  path: (string | number)[];
  rule: "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V9";
  message: string;
}

export type ConfigCheck = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] };

function byRule(issues: ConfigIssue[]): ConfigIssue[] {
  return issues.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

const PATH_SYNTAX = /^\/(?:ca|crl|dcrl)(?:\/[A-Za-z0-9._~-]+)+$/;
const PATH_PREFIX = /^\/(ca|crl|dcrl)\//;

const KIND_BY_PREFIX: Record<string, CrlKind> = { crl: "full", dcrl: "delta" };

const PATH_SYNTAX_MESSAGE =
  "Expected /ca/, /crl/ or /dcrl/ followed by segments of [A-Za-z0-9._~-] " +
  "(no empty segment, trailing /, % or other character)";

function pathSyntaxProblem(path: string): string | undefined {
  if (!PATH_SYNTAX.test(path)) {
    return PATH_SYNTAX_MESSAGE;
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "A path segment must not be . or ..";
  }
  if (path.endsWith(".pem")) {
    return "A path must not end in .pem: <path>.pem is the derived PEM variant";
  }
  return undefined;
}

function staticIssues(config: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [path, entry] of Object.entries(config.paths)) {
    const at = ["paths", path];
    const problem = pathSyntaxProblem(path);
    if (problem !== undefined) {
      issues.push({ path: at, rule: "V2", message: problem });
    }
    const prefix = PATH_PREFIX.exec(path)?.[1];
    if ("certificate" in entry) {
      if (prefix !== undefined && prefix !== "ca") {
        issues.push({
          path: at,
          rule: "V3",
          message: `A /${prefix}/ path serves a CRL: map it to { target }`,
        });
      }
      continue;
    }
    const target = config.targets[entry.target];
    if (target === undefined) {
      issues.push({
        path: [...at, "target"],
        rule: "V4",
        message: `Target ${entry.target} is not in targets`,
      });
    }
    if (prefix === "ca") {
      issues.push({
        path: at,
        rule: "V3",
        message: "A /ca/ path serves a certificate: map it to { certificate }",
      });
    } else if (prefix !== undefined && target !== undefined) {
      const kind = KIND_BY_PREFIX[prefix];
      if (target.kind !== kind) {
        issues.push({
          path: [...at, "target"],
          rule: "V3",
          message: `A /${prefix}/ path serves a ${kind} target; ${entry.target} is ${target.kind}`,
        });
      }
    }
  }
  const seen = new Map<string, string>();
  for (const [id, target] of Object.entries(config.targets)) {
    const slot = `${target.issuer}/${target.kind}`;
    const first = seen.get(slot);
    if (first === undefined) {
      seen.set(slot, id);
    } else {
      issues.push({
        path: ["targets", id],
        rule: "V6",
        message: `Target ${first} already is the ${target.kind} target of issuer ${target.issuer}`,
      });
    }
  }
  return issues;
}

export function schemaIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    rule: "V1",
    message:
      issue.code === "invalid_key"
        ? `Invalid key: ${issue.issues.map((inner) => inner.message).join("; ")}`
        : issue.message,
  }));
}

function checkConfigState(config: Config, catalog: Catalog): ConfigIssue[] {
  const issues: ConfigIssue[] = certificateReferences(config)
    .filter(({ id }) => catalog.certificates[id] === undefined)
    .map(({ id, path }) => ({
      path,
      rule: "V4",
      message: `Certificate ${id} has not been imported`,
    }));
  const bySubjectKey = new Map<string, { id: string; issuer: string }>();
  for (const [id, target] of Object.entries(config.targets)) {
    const at = ["targets", id, "issuer"];
    const issuer = catalog.certificates[target.issuer];
    if (issuer === undefined) {
      continue;
    }
    const subjectKeyId = issuer.summary.subjectKeyId;
    if (subjectKeyId === null) {
      issues.push({
        path: at,
        rule: "V5",
        message: `Certificate ${target.issuer} has no Subject Key Identifier, so no CRL can be matched to it`,
      });
      continue;
    }
    const slot = `${subjectKeyId}/${target.kind}`;
    const first = bySubjectKey.get(slot);
    if (first === undefined) {
      bySubjectKey.set(slot, { id, issuer: target.issuer });
    } else if (first.issuer !== target.issuer) {
      issues.push({
        path: at,
        rule: "V6",
        message:
          `Certificate ${target.issuer} has the same Subject Key Identifier as ${first.issuer}, ` +
          `the issuer of ${target.kind} target ${first.id}`,
      });
    }
  }
  return issues;
}

function checkConfigMigration(config: Config, current: Config | undefined): ConfigIssue[] {
  if (current === undefined) {
    return [];
  }
  const issues: ConfigIssue[] = [];
  for (const [path, entry] of Object.entries(config.paths)) {
    const before = current.paths[path];
    if (
      path.startsWith("/ca/") &&
      "certificate" in entry &&
      before !== undefined &&
      "certificate" in before &&
      before.certificate !== entry.certificate
    ) {
      issues.push({
        path: ["paths", path, "certificate"],
        rule: "V7",
        message:
          `${path} serves certificate ${before.certificate}, which clients cache as immutable ` +
          "for a year: publish another certificate under a new path",
      });
    }
  }
  for (const [id, target] of Object.entries(config.targets)) {
    const before = current.targets[id];
    for (const field of ["issuer", "kind"] as const) {
      if (before !== undefined && before[field] !== target[field]) {
        issues.push({
          path: ["targets", id, field],
          rule: "V9",
          message: `Target ${id} has ${field} ${before[field]}: use a new target id for another ${field}`,
        });
      }
    }
  }
  return issues;
}

export interface ValidationContext {
  catalog: Catalog;
  current?: Config | undefined;
}

export function validateConfig(value: unknown, context?: ValidationContext): ConfigCheck {
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: schemaIssues(parsed.error) };
  }
  const config = parsed.data;
  const issues = byRule([
    ...staticIssues(config),
    ...(context === undefined
      ? []
      : [
          ...checkConfigState(config, context.catalog),
          ...checkConfigMigration(config, context.current),
        ]),
  ]);
  return issues.length === 0 ? { ok: true, config } : { ok: false, issues };
}

export type ConfigPrecondition =
  { ifMatch: string; ifNoneMatch?: never } | { ifNoneMatch: "*"; ifMatch?: never };

export type ApplyConfigResult =
  | { config: Config; sha256: string }
  | { error: "precondition_failed" }
  | { error: "config_invalid"; details: { issues: ConfigIssue[] } };

function parseCurrent(bytes: Uint8Array): Config | undefined {
  try {
    return ConfigSchema.parse(decodeJson(bytes));
  } catch {
    return undefined;
  }
}

export async function applyConfig(
  deps: { store: ObjectStore },
  body: unknown,
  precondition: ConfigPrecondition
): Promise<ApplyConfigResult> {
  const [stored, { catalog }] = await Promise.all([
    deps.store.get(CONFIG_KEY),
    readCatalog(deps.store),
  ]);
  const holds =
    precondition.ifNoneMatch === "*"
      ? stored === null
      : stored !== null && (await sha256Hex(stored.bytes)) === precondition.ifMatch;
  if (!holds) {
    return { error: "precondition_failed" };
  }

  const checked = validateConfig(body, {
    catalog,
    current: stored === null ? undefined : parseCurrent(stored.bytes),
  });
  if (!checked.ok) {
    return { error: "config_invalid", details: { issues: checked.issues } };
  }

  const bytes = encodeJson(checked.config);
  const written = await deps.store.put(
    CONFIG_KEY,
    bytes,
    stored === null ? { ifNoneMatch: "*" } : { ifMatch: stored.etag }
  );
  if (!written.ok) {
    return { error: "precondition_failed" };
  }
  return { config: checked.config, sha256: await sha256Hex(bytes) };
}
