// CRL publishing: the freshness rule and publishCrl. The catalog write is the one commit point:
// there are no PEM or alias companions and no edge cache.
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

// Freshness ---------------------------------------------------------------------------------------

/**
 * Whether `incoming` may replace the target's current CRL. It compares catalog summaries, not the
 * current DER: bytes that are the current CRL were already answered unchanged (alreadyCurrent).
 * A CRL Number on only one side is non_orderable; otherwise the higher number wins, and equal or
 * absent numbers fall back to thisUpdate, where the same instant is a conflict (other bytes for the
 * same CRL).
 *
 * Numbers (decimal strings) compare as BigInt and times (ISO 8601) as epoch milliseconds, never as
 * strings: a time with and one without milliseconds are the same instant. nextUpdate plays no part.
 * Full and delta targets are compared separately (AD CS numbers both from one counter, so each
 * sequence has gaps).
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

// publishCrl --------------------------------------------------------------------------------------

/** What the log line knows so far; publish fills it in as it goes. */
interface Trace {
  targetId?: string;
  kind?: CrlKind;
  sha256?: string;
  crlNumber?: string | null;
  thisUpdate?: string;
  /** nextUpdate has passed; such a CRL is still accepted. */
  expired?: boolean;
  /** How often the state was read: 1 + retries; 0 when toDer rejected the bytes. */
  attempts: number;
  /** Why, in English, for a failure (exception text included); never in a response. */
  detail?: string;
}

/**
 * The call's one `publish` log line. A field not known when the call ends is undefined; null is a
 * known absence (no CRL Number). Open like the HTTP LogRecord, so that its logger fits deps.log.
 */
export interface PublishLogRecord extends Trace {
  [field: string]: unknown;
  level: "info" | "warn" | "error";
  msg: "publish";
  /** On success; on a failure `reason` instead. */
  outcome?: PublishSuccess["outcome"];
  /** The error code, or `internal` when publishCrl threw. */
  reason?: PublishErrorCode | "internal";
  ms: number;
}

export interface PublishDeps extends CatalogDeps {
  now: () => Date;
  /** Receives exactly one record per call. */
  log: (record: PublishLogRecord) => void;
}

/** created / updated wrote `current`; unchanged found the same bytes current and kept it. */
export interface PublishSuccess {
  outcome: "created" | "updated" | "unchanged";
  targetId: string;
  kind: CrlKind;
  /** The configured issuer, whose key verified the signature (not again for unchanged bytes). */
  issuer: string;
  current: CurrentCrl;
  /** downloadPaths of the target in the config read by the deciding attempt. */
  downloads: string[];
}

/** The current CRL a freshness failure refers to (`details.current`). */
export interface CurrentVersion {
  sha256: string;
  crlNumber: string | null;
  thisUpdate: string;
}

/** The failures, `details` as the error envelope carries them. */
export type PublishFailure =
  | { error: "invalid_crl"; details: { reason: PkiParseReason } }
  | { error: "not_yet_valid"; details: { thisUpdate: string } }
  | {
      error: "scoped_crl_unsupported";
      /** serialNumber (uppercase hex) only for an entry extension. */
      details: { oid: string; serialNumber?: string };
    }
  /** No AKI keyIdentifier, or no imported certificate with that SKI. */
  | { error: "issuer_not_found"; details: { reason: "missing_aki" } | { authorityKeyId: string } }
  /** `certificates`: imported certificates with the AKI as SKI; no target of the kind names one. */
  | { error: "target_not_configured"; details: { kind: CrlKind; certificates: string[] } }
  | { error: "invalid_signature" | "unsupported_algorithm"; details: { algorithm: string } }
  | { error: "stale_crl" | "conflict" | "non_orderable"; details: { current: CurrentVersion } }
  | { error: "concurrent_update" };

export type PublishErrorCode = PublishFailure["error"];

export type PublishResult = PublishSuccess | PublishFailure;

/** A failure of the upload, thrown out of the attempt so that updateState ends without a write. */
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

/** What the header of an upload says, checked before its signature is verified. */
interface Header {
  /** parseCrlHeader's CRL: no revoked entries, `tbsView` the TBSCertList as received. */
  crl: ReceivedCrl;
  fields: CrlFields;
  kind: CrlKind;
  /** keyIdentifier of the Authority Key Identifier; undefined without one. */
  aki: string | undefined;
}

// A PkiParseError propagates (invalid_crl), and a policy violation is a Rejection.
function checkHeader(der: Uint8Array, now: Date, trace: Trace): Header {
  const crl = parseCrlHeader(der);
  const fields = readCrlFields(crl);
  const aki = authorityKeyId("crl", crl.crlExtensions?.extensions);
  // A valid Delta CRL Indicator makes a delta (an invalid one threw above).
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

// Decodes the whole CRL: call it only once its signature verified. Throws like checkHeader.
async function checkWhole(der: Uint8Array): Promise<CrlSummary> {
  const crl = parseCRL(der);
  const policy = checkEntryPolicy(crl);
  if (!policy.ok) {
    reject(policy);
  }
  return buildCrlSummary(crl, der);
}

/** The unchanged result for the target whose current CRL has digest `sha256`, without parsing. */
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
 * The target of `kind` whose issuer has the AKI as SKI; that issuer verifies, whatever other
 * certificates share the SKI. V6 allows one at most; more means an out-of-band config.json and
 * throws an Error (500), not a Rejection.
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

// A missing or unparsable issuer blob is a broken store, not a bad upload: it throws (500).
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

async function publish(
  deps: PublishDeps,
  bytes: Uint8Array,
  now: Date,
  trace: Trace
): Promise<PublishResult> {
  const der = toDer(bytes, "crl");
  const sha256 = await sha256Hex(der);
  trace.sha256 = sha256;

  // Header and whole CRL do not depend on the state, so each is checked at most once per call; the
  // signature is verified per attempt, with the issuer that attempt's state resolves. Blob and
  // marker are create-only and put at most once per call. An existing one (precondition-failed) has
  // the same bytes: a blob key holds its digest, and a marker is the superseded current record,
  // which every writer reads alike.
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
    // An earlier attempt's target does not describe this one.
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

    // Blob and marker go before the catalog write, the commit point: history.ts reads the catalog
    // first and relies on its blob and marker lists holding every version that catalog names.
    const key = crlBlobKey(targetId, summary, sha256);
    await putOnce(key, der);
    const publishedAt = now.toISOString();
    if (current !== null) {
      // Keep the superseded record verbatim. A lost race must not leave a false retirement time.
      await putOnce(crlHistoryKey(targetId, current.summary, current.sha256), encodeJson(current));
    }
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

/** The longest `detail` of a log line: it can quote the upload (a PEM label, a hex dump). */
const MAX_DETAIL_CHARS = 500;

/**
 * Publishes one CRL (DER or a single X509 CRL PEM block, recognized from the bytes) to the target
 * that the config binds to its issuer and kind. Bytes are never decoded whole before their
 * signature verified: until then an upload costs its body, one digest, the decoding of its header
 * (at most 16 KiB) and the signature check. A lost catalog write is retried on re-read state
 * (updateState); when the retries run out the result is concurrent_update.
 *
 * A rejection or unchanged before any write leaves the store as it was. A lost race leaves this
 * call's blob as an orphan that is not history, and possibly the marker of a current that was
 * really published.
 *
 * Exactly one `publish` record goes to deps.log per call, also when the call throws (an invalid
 * stored object, a missing issuer blob, a store error): then with reason `internal`, and the error
 * is rethrown.
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
    // A PkiParseError of the upload is invalid_crl; of the issuer certificate, a broken store.
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
