// Configuration rules and apply. The rules V1–V9 come in three layers:
// - static (V1–V3, V4 / V6 static parts): the document alone. validateConfig without a context
//   runs only this layer, as the CLI's offline `config validate` does.
// - state (V4 / V6 catalog parts, V5): against catalog.json, at apply time only.
// - migration (V7, V9): against the current config.json, at apply time only.
// There is no V8: removing a target from config.json retires it (see checkConfigMigration).
// There is no rebind ledger either: V7 compares with the current config only, so a `/ca/` path
// removed by one apply and re-added for another certificate by a later one is not detected.
// Certificate downloads are cached immutable for a year, so a new CA certificate needs a new path;
// that is the operator's responsibility.
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

/** One configuration violation (`details.issues[]` of config_invalid). */
export interface ConfigIssue {
  /** Keys from the document root; [] for the whole document. */
  path: (string | number)[];
  rule: "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V9";
  message: string;
}

export type ConfigCheck = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] };

// Stable, so issues of one rule keep the document's order.
function byRule(issues: ConfigIssue[]): ConfigIssue[] {
  return issues.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

// Static layer -----------------------------------------------------------------------------------

// V2: the character set is the canonical form, so "unique after normalization" is just unique
// keys. Case-sensitive, matched exactly by the download routes.
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
    // V3 needs the prefix only; a path with an unknown prefix is V2's alone.
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
  // V6, static part: one target per (issuer, kind).
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

/** The V1 issues of a failed ConfigSchema parse. */
export function schemaIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    rule: "V1",
    // zod reports a bad record key as "Invalid key in record"; say what is wrong with it.
    message:
      issue.code === "invalid_key"
        ? `Invalid key: ${issue.issues.map((inner) => inner.message).join("; ")}`
        : issue.message,
  }));
}

// State layer ------------------------------------------------------------------------------------

/**
 * V4 (referenced certificates are imported), V5 (a target's issuer has an SKI: CRLs are matched to
 * issuers by AKI = SKI) and V6's catalog part (two certificates with one SKI, e.g. a renewal on the
 * same key, must not each have a target of the same kind, or a CRL could not be attributed).
 */
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
      // V4, reported above.
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

// Migration layer --------------------------------------------------------------------------------

/**
 * V7 (a `/ca/` path in both configs keeps its certificate) and V9 (a target id in both keeps its
 * issuer and kind: one certificate verifies its current CRL and history); [] without `current`.
 *
 * Removing a target retires it whatever the catalog holds for it: downloads, lists and uploads look
 * only at config.json's targets, so nothing serves it and its CRLs get target_not_configured; the
 * catalog keeps its last current as history and to protect its verifier from deletion. Adding the
 * id back serves that current again, so a target that publishes again gets a new id
 * (`aia new-target-id`). Like a rebound `/ca/` path, an id re-added with another issuer or kind by
 * a later apply is not detected.
 */
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

// Whole ------------------------------------------------------------------------------------------

export interface ValidationContext {
  catalog: Catalog;
  /** The current config.json; omitted when missing or not valid, which skips V7 and V9. */
  current?: Config | undefined;
}

/**
 * Every violation at once, ordered by rule. When V1 (ConfigSchema) fails nothing else runs: the
 * other rules need a well-formed document. The state and migration rules run only with `context`.
 */
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

// Apply ------------------------------------------------------------------------------------------

/**
 * `ifMatch` is the unquoted config ETag (the SHA-256 hex of the stored config.json bytes);
 * `ifNoneMatch: "*"` is for the first configuration.
 */
export type ConfigPrecondition =
  { ifMatch: string; ifNoneMatch?: never } | { ifNoneMatch: "*"; ifMatch?: never };

export type ApplyConfigResult =
  /** `sha256` of the bytes written: the new HTTP ETag. */
  | { config: Config; sha256: string }
  | { error: "precondition_failed" }
  | { error: "config_invalid"; details: { issues: ConfigIssue[] } };

// Lenient: a current config that is not JSON or not valid stays replaceable and only skips V7 / V9.
function parseCurrent(bytes: Uint8Array): Config | undefined {
  try {
    return ConfigSchema.parse(decodeJson(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Replaces config.json; throws when catalog.json is invalid. The precondition is checked against
 * the SHA-256 of the stored bytes, so a config broken by an out-of-band write stays replaceable
 * after a GET returned it as is. A lost conditional write is precondition_failed, not retried.
 * The catalog is not re-read before the write: a publish or a certificate deletion in between is
 * the accepted cross-object window (one operator at a time).
 */
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
