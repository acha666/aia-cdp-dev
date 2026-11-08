// Extension and clock policy of an uploaded CRL. checkCrlPolicy runs on parseCrlHeader's CRL
// before the signature check (verify.ts), checkEntryPolicy on the whole CRL once the signature
// verified. Only what the service itself relies on is checked: unknown extensions, critical or
// not, are the CA's business.
import type { Extension } from "pkijs";
import { toHex, toUpperHex } from "../digest.ts";
import { SEQUENCE, context, hasTag, sequenceOf } from "./der.ts";
import { messageOf } from "./errors.ts";
import { readExtensionSchema } from "./extensions.ts";
import { sameSignatureAlgorithms } from "./parsers.ts";
import type { ReceivedCrl, WholeCrl } from "./parsers.ts";

/** How far thisUpdate may lie ahead of the clock: exactly five minutes is still accepted. */
const MAX_CLOCK_SKEW_MS = 300_000;

const ISSUING_DISTRIBUTION_POINT_OID = "2.5.29.28";

/** An entry naming another issuer makes the CRL indirect (RFC 5280 §5.3.3). */
const CERTIFICATE_ISSUER_OID = "2.5.29.29";

/**
 * A violation, one variant per error code; publishCrl maps `error` and `details` to the envelope
 * as they are and keeps `detail` for its log line. `serialNumber` (the entry of an entry
 * extension) is uppercase hex like the catalog's.
 */
export type CrlPolicyFailure =
  | {
      ok: false;
      error: "invalid_crl";
      details: { reason: "signature_algorithm_mismatch" | "extension_value" };
      detail: string;
    }
  | { ok: false; error: "not_yet_valid"; details: { thisUpdate: string }; detail: string }
  | {
      ok: false;
      error: "scoped_crl_unsupported";
      details: { oid: string; serialNumber?: string };
      detail: string;
    };

export type CrlPolicyResult =
  | {
      ok: true;
      /** nextUpdate has passed: accepted, and logged. */
      expired: boolean;
    }
  | CrlPolicyFailure;

/**
 * Whether an IssuingDistributionPoint holds a field other than distributionPoint [0] (RFC 5280
 * §5.2.5: the others limit the scope of the CRL). Throws when the value is not a SEQUENCE.
 */
function limitsScope(extension: Extension): boolean {
  return sequenceOf(readExtensionSchema(extension), SEQUENCE, 0).some(
    (field) => !hasTag(field, context(0))
  );
}

/**
 * The upload policy of the CRL itself, in this order, the first violation winning:
 *
 * 1. The outer signatureAlgorithm and the TBS signature must be the same octets as received, OID
 *    and parameters (RFC 5280 §5.1.1.2) → invalid_crl / signature_algorithm_mismatch. Received,
 *    not re-encoded: the outer one is outside the signature, and asn1js would re-encode some
 *    non-DER forms canonically.
 * 2. Clock, in epoch milliseconds: thisUpdate more than MAX_CLOCK_SKEW_MS after `now` →
 *    not_yet_valid; a nextUpdate before `now` is accepted with `expired: true`.
 * 3. The Issuing Distribution Point, whatever its criticality: naming only the distributionPoint
 *    (the AD CS CDP option) is accepted; any other field → scoped_crl_unsupported, also when the
 *    IDP is not marked critical: the service keeps one full and one delta CRL per issuer, and a
 *    partition published as the issuer's CRL would read as complete to a client that skips a
 *    non-critical IDP; a value that is not a SEQUENCE → invalid_crl / extension_value. Every other
 *    extension, critical or not, is the CA's business: its bytes stay in the blob.
 *
 * Pure: nothing but `crl` and `now` is read, and the signature is not checked. The entries are
 * checkEntryPolicy's.
 */
export function checkCrlPolicy(crl: ReceivedCrl, now: Date): CrlPolicyResult {
  if (!sameSignatureAlgorithms(crl)) {
    return {
      ok: false,
      error: "invalid_crl",
      details: { reason: "signature_algorithm_mismatch" },
      detail: `signatureAlgorithm ${toHex(crl.signatureAlgorithmView)} differs from the TBS signature ${toHex(crl.signatureView)}`,
    };
  }

  const thisUpdate = crl.thisUpdate.value;
  if (thisUpdate.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: "not_yet_valid",
      details: { thisUpdate: thisUpdate.toISOString() },
      detail: `thisUpdate ${thisUpdate.toISOString()} is ahead of ${now.toISOString()}`,
    };
  }
  const nextUpdate = crl.nextUpdate?.value;
  const expired = nextUpdate !== undefined && nextUpdate.getTime() < now.getTime();

  const idp = crl.crlExtensions?.extensions.find(
    (extension) => extension.extnID === ISSUING_DISTRIBUTION_POINT_OID
  );
  if (idp !== undefined) {
    let scoped: boolean;
    try {
      scoped = limitsScope(idp);
    } catch (error) {
      return {
        ok: false,
        error: "invalid_crl",
        details: { reason: "extension_value" },
        detail: `Invalid Issuing Distribution Point: ${messageOf(error)}`,
      };
    }
    if (scoped) {
      return {
        ok: false,
        error: "scoped_crl_unsupported",
        details: { oid: ISSUING_DISTRIBUTION_POINT_OID },
        detail: "The Issuing Distribution Point limits the scope of the CRL",
      };
    }
  }

  return { ok: true, expired };
}

/**
 * The upload policy of the revoked entries: an entry with certificateIssuer (an indirect CRL) →
 * scoped_crl_unsupported with the entry's serial number. Pure, like checkCrlPolicy.
 */
export function checkEntryPolicy(crl: WholeCrl): { ok: true } | CrlPolicyFailure {
  for (const entry of crl.entries) {
    if (entry.extensions.some((extension) => extension.extnID === CERTIFICATE_ISSUER_OID)) {
      const serialNumber = toUpperHex(entry.serial);
      return {
        ok: false,
        error: "scoped_crl_unsupported",
        details: { oid: CERTIFICATE_ISSUER_OID, serialNumber },
        detail: `Entry ${serialNumber} names a certificate issuer (indirect CRL)`,
      };
    }
  }
  return { ok: true };
}
