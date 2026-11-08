/**
 * CRL upload: parse, match to a target by Authority Key Identifier, verify the signature
 * with the target's issuer, check freshness, store the blob and make it current.
 *
 * @packageDocumentation
 */
import { encodeJson, updateState } from "./catalog.ts";
import type {
  CatalogDeps,
  CatalogMutation,
  CrlKind,
  CrlSummary,
  CurrentCrl,
  State,
} from "./catalog.ts";
import { sha256Hex } from "./digest.ts";
import { crlBlobKey, crlHistoryKey } from "./history.ts";
import { checkCrlPolicy, checkEntryPolicy } from "./pki/crl-policy.ts";
import type { CrlPolicyFailure } from "./pki/crl-policy.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiParseReason } from "./pki/errors.ts";
import { parseCertificate, parseCRL, parseCrlHeader } from "./pki/parsers.ts";
import type { ReceivedCrl } from "./pki/parsers.ts";
import { toDer } from "./pki/pem.ts";
import { verifyCrlSignature } from "./pki/verify.ts";
import type { SignatureCheck, SignatureFailure } from "./pki/verify.ts";
import { downloadPaths } from "./resources.ts";
import { readBlob } from "./store.ts";
import type { ObjectStore } from "./store.ts";
import { authorityKeyId, buildCrlSummary, readCrlFields } from "./summary.ts";
import type { CrlFields } from "./summary.ts";

/**
 * Orders an incoming CRL against the current one: by CRL Number when both have one, then by
 * thisUpdate.
 *
 * @returns `non_orderable` when only one of them has a CRL Number, `conflict` for a
 * different CRL with the same number and thisUpdate.
 */
export function compareFreshness(
  current: Pick<CrlSummary, "crlNumber" | "thisUpdate">,
  incoming: Pick<CrlSummary, "crlNumber" | "thisUpdate">
): "updated" | "stale_crl" | "conflict" | "non_orderable" {
  const before = current.crlNumber;
  const after = incoming.crlNumber;
  if ((before === null) !== (after === null)) {
    return "non_orderable";
  }
  if (before !== null && after !== null) {
    const order = BigInt(after) - BigInt(before);
    if (order !== 0n) {
      return order > 0n ? "updated" : "stale_crl";
    }
  }
  const order = Date.parse(incoming.thisUpdate) - Date.parse(current.thisUpdate);
  if (order === 0) {
    return "conflict";
  }
  return order > 0 ? "updated" : "stale_crl";
}

/** Fields collected along the way for the single log record of an upload. */
interface Trace {
  targetId?: string;
  kind?: CrlKind;
  sha256?: string;
  crlNumber?: string | null;
  thisUpdate?: string;
  expired?: boolean;
  attempts: number;
  detail?: string;
}

export interface PublishLogRecord extends Trace {
  [field: string]: unknown;
  level: "info" | "warn" | "error";
  msg: "publish";
  outcome?: PublishSuccess["outcome"];
  reason?: PublishErrorCode | "internal";
  ms: number;
}

export interface PublishDeps extends CatalogDeps {
  now: () => Date;
  log: (record: PublishLogRecord) => void;
}

export interface PublishSuccess {
  outcome: "created" | "updated" | "unchanged";
  targetId: string;
  kind: CrlKind;
  issuer: string;
  current: CurrentCrl;
  downloads: string[];
}

export interface CurrentVersion {
  sha256: string;
  crlNumber: string | null;
  thisUpdate: string;
}

export type PublishFailure =
  | { error: "invalid_crl"; details: { reason: PkiParseReason } }
  | { error: "not_yet_valid"; details: { thisUpdate: string } }
  | {
      error: "scoped_crl_unsupported";
      details: { oid: string; serialNumber?: string };
    }
  | { error: "issuer_not_found"; details: { reason: "missing_aki" } | { authorityKeyId: string } }
  | { error: "target_not_configured"; details: { kind: CrlKind; certificates: string[] } }
  | { error: "invalid_signature" | "unsupported_algorithm"; details: { algorithm: string } }
  | { error: "stale_crl" | "conflict" | "non_orderable"; details: { current: CurrentVersion } }
  | { error: "concurrent_update" };

export type PublishErrorCode = PublishFailure["error"];

export type PublishResult = PublishSuccess | PublishFailure;

/** Ends an upload with a client-facing failure; `detail` goes to the log only. */
class Rejection extends Error {
  override name = "Rejection";
  readonly failure: PublishFailure;

  constructor(failure: PublishFailure, detail: string) {
    super(detail);
    this.failure = failure;
  }
}

function reject({ ok: _ok, detail, ...failure }: CrlPolicyFailure | SignatureFailure): never {
  throw new Rejection(failure, detail);
}

interface Header {
  crl: ReceivedCrl;
  fields: CrlFields;
  kind: CrlKind;
  aki: string | undefined;
}

/** Parses what is needed to find the target, and applies the policy that needs no issuer. */
function checkHeader(der: Uint8Array, now: Date, trace: Trace): Header {
  const crl = parseCrlHeader(der);
  const fields = readCrlFields(crl);
  const aki = authorityKeyId("crl", crl.crlExtensions?.extensions);
  const kind: CrlKind = fields.baseCrlNumber === null ? "full" : "delta";
  trace.kind = kind;
  trace.crlNumber = fields.crlNumber;
  trace.thisUpdate = fields.thisUpdate;

  const policy = checkCrlPolicy(crl, now);
  if (!policy.ok) {
    reject(policy);
  }
  trace.expired = policy.expired;
  return { crl, fields, kind, aki };
}

/** Parses the revoked entries too; only reached once the signature is good. */
async function checkWhole(der: Uint8Array): Promise<CrlSummary> {
  const crl = parseCRL(der);
  const policy = checkEntryPolicy(crl);
  if (!policy.ok) {
    reject(policy);
  }
  return buildCrlSummary(crl, der);
}

/** Finds the target that already serves these exact bytes, which makes the upload a no-op. */
function alreadyCurrent(state: State, sha256: string): PublishSuccess | undefined {
  for (const [targetId, target] of Object.entries(state.config.targets)) {
    const current = state.catalog.targets[targetId]?.current;
    if (current?.sha256 === sha256) {
      const downloads = downloadPaths(state.config, { target: targetId });
      return {
        outcome: "unchanged",
        targetId,
        kind: target.kind,
        issuer: target.issuer,
        current,
        downloads,
      };
    }
  }
  return undefined;
}

/**
 * Finds the one target of `kind` whose issuer's Subject Key Identifier is `aki`.
 *
 * @throws Error if several match, which a validated config rules out (rule V6).
 */
function resolveTarget(
  state: State,
  aki: string | undefined,
  kind: CrlKind
): { targetId: string; issuer: string } {
  if (aki === undefined) {
    throw new Rejection(
      { error: "issuer_not_found", details: { reason: "missing_aki" } },
      "The CRL has no Authority Key Identifier keyIdentifier"
    );
  }
  const candidates = Object.entries(state.catalog.certificates)
    .filter(([, certificate]) => certificate.summary.subjectKeyId === aki)
    .map(([id]) => id)
    .sort();
  if (candidates.length === 0) {
    throw new Rejection(
      { error: "issuer_not_found", details: { authorityKeyId: aki } },
      `No imported certificate has the Subject Key Identifier ${aki}`
    );
  }
  const targets = Object.entries(state.config.targets).filter(
    ([, target]) => target.kind === kind && candidates.includes(target.issuer)
  );
  const [found, ...more] = targets;
  if (found === undefined) {
    throw new Rejection(
      { error: "target_not_configured", details: { kind, certificates: candidates } },
      `No ${kind} target names certificate ${candidates.join(", ")}`
    );
  }
  if (more.length > 0) {
    throw new Error(
      `config.json breaks rule V6: ${kind} targets ${targets.map(([id]) => id).join(", ")} ` +
        `have issuers with the Subject Key Identifier ${aki}`
    );
  }
  const [targetId, target] = found;
  return { targetId, issuer: target.issuer };
}

async function verifyWithIssuer(
  store: ObjectStore,
  state: State,
  issuer: string,
  crl: ReceivedCrl
): Promise<SignatureCheck> {
  const entry = state.catalog.certificates[issuer];
  if (entry === undefined) {
    throw new Error(`Certificate ${issuer} is not in the catalog`);
  }
  const der = await readBlob(store, entry.key);
  return verifyCrlSignature(crl, parseCertificate(der).subjectPublicKeyInfo);
}

function currentVersion(current: CurrentCrl): CurrentVersion {
  return {
    sha256: current.sha256,
    crlNumber: current.summary.crlNumber,
    thisUpdate: current.summary.thisUpdate,
  };
}

/**
 * Runs the upload inside {@link updateState}. Parsing and signature checks are cached
 * across retries; blobs are written once, before the catalog that points at them.
 */
async function publish(
  deps: PublishDeps,
  bytes: Uint8Array,
  now: Date,
  trace: Trace
): Promise<PublishResult> {
  const der = toDer(bytes, "crl");
  const sha256 = await sha256Hex(der);
  trace.sha256 = sha256;

  let header: Header | undefined;
  let summary: CrlSummary | undefined;
  const written = new Set<string>();
  const putOnce = async (key: string, body: Uint8Array) => {
    if (!written.has(key)) {
      await deps.store.put(key, body, { ifNoneMatch: "*" });
      written.add(key);
    }
  };
  const attempt = async (state: State): Promise<CatalogMutation<PublishSuccess>> => {
    trace.attempts++;
    delete trace.targetId;
    const unchanged = alreadyCurrent(state, sha256);
    if (unchanged !== undefined) {
      trace.targetId = unchanged.targetId;
      trace.kind = unchanged.kind;
      trace.crlNumber = unchanged.current.summary.crlNumber;
      trace.thisUpdate = unchanged.current.summary.thisUpdate;
      return { result: unchanged };
    }

    header ??= checkHeader(der, now, trace);
    const { crl, fields, kind, aki } = header;
    const { targetId, issuer } = resolveTarget(state, aki, kind);
    trace.targetId = targetId;

    const check = await verifyWithIssuer(deps.store, state, issuer, crl);
    if (!check.ok) {
      reject(check);
    }

    const entry = state.catalog.targets[targetId];
    const current = entry?.current ?? null;
    const downloads = downloadPaths(state.config, { target: targetId });
    if (current !== null) {
      const freshness = compareFreshness(current.summary, fields);
      if (freshness !== "updated") {
        const version = currentVersion(current);
        throw new Rejection(
          { error: freshness, details: { current: version } },
          `${freshness} against the current CRL ${version.crlNumber ?? "without a number"} ` +
            `of ${version.thisUpdate}`
        );
      }
    }

    summary ??= await checkWhole(der);

    const key = crlBlobKey(targetId, summary, sha256);
    await putOnce(key, der);
    const publishedAt = now.toISOString();
    if (current !== null) {
      await putOnce(crlHistoryKey(targetId, current.summary, current.sha256), encodeJson(current));
    }
    // The replaced CRL stays downloadable from the target's history.
    const record: CurrentCrl = {
      sha256,
      key,
      size: der.byteLength,
      publishedAt,
      verifier: issuer,
      summary,
    };
    return {
      next: {
        ...state.catalog,
        targets: { ...state.catalog.targets, [targetId]: { ...entry, current: record } },
      },
      result: {
        outcome: current === null ? "created" : "updated",
        targetId,
        kind,
        issuer,
        current: record,
        downloads,
      },
    };
  };

  const update = await updateState(deps, attempt);
  if ("error" in update) {
    trace.detail = `The catalog write was lost ${trace.attempts} times`;
  }
  return update;
}

const MAX_DETAIL_CHARS = 500;

/**
 * Publishes an uploaded CRL (DER or PEM) and logs one record for it.
 *
 * @returns The outcome, or a failure the client can act on.
 * @throws For internal errors (store failures, an inconsistent state), after logging them.
 */
export async function publishCrl(deps: PublishDeps, bytes: Uint8Array): Promise<PublishResult> {
  const now = deps.now();
  const started = performance.now();
  const trace: Trace = { attempts: 0 };
  const line = (
    level: PublishLogRecord["level"],
    end: Pick<PublishLogRecord, "outcome" | "reason">
  ): PublishLogRecord => ({
    level,
    msg: "publish",
    ...trace,
    ...end,
    ms: Math.round((performance.now() - started) * 10) / 10,
    detail: trace.detail?.slice(0, MAX_DETAIL_CHARS),
  });

  let result: PublishResult;
  try {
    result = await publish(deps, bytes, now, trace);
  } catch (error) {
    if (error instanceof Rejection) {
      trace.detail = error.message;
      result = error.failure;
    } else if (error instanceof PkiParseError && error.kind === "crl") {
      trace.detail = `${error.reason}: ${error.message}`;
      result = { error: "invalid_crl", details: { reason: error.reason } };
    } else {
      trace.detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      deps.log(line("error", { reason: "internal" }));
      throw error;
    }
  }
  deps.log(
    "error" in result
      ? line("warn", { reason: result.error })
      : line("info", { outcome: result.outcome })
  );
  return result;
}
