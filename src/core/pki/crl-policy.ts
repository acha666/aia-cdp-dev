/**
 * The CRL rules beyond well-formedness. Only complete CRLs are accepted: a CRL that covers
 * part of the issuer's certificates, or certificates of another issuer, cannot replace the
 * previous one.
 *
 * @packageDocumentation
 */
import type { Extension } from "pkijs";
import { toHex, toUpperHex } from "../digest.ts";
import { SEQUENCE, context, hasTag, sequenceOf } from "./der.ts";
import { messageOf } from "./errors.ts";
import { readExtensionSchema } from "./extensions.ts";
import { sameSignatureAlgorithms } from "./parsers.ts";
import type { ReceivedCrl, WholeCrl } from "./parsers.ts";

/** How far thisUpdate may be ahead of the server clock. */
const MAX_CLOCK_SKEW_MS = 300_000;

const ISSUING_DISTRIBUTION_POINT_OID = "2.5.29.28";

const CERTIFICATE_ISSUER_OID = "2.5.29.29";

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
      expired: boolean;
    }
  | CrlPolicyFailure;

/** An Issuing Distribution Point limits the scope with any field but distributionPoint. */
function limitsScope(extension: Extension): boolean {
  return sequenceOf(readExtensionSchema(extension), SEQUENCE, 0).some(
    (field) => !hasTag(field, context(0))
  );
}

/**
 * Checks the CRL header: matching signature algorithms, thisUpdate not in the future, and
 * full scope. An expired CRL is accepted and flagged, since it is still the newest one.
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

/** Rejects indirect CRLs, whose entries name another certificate issuer. */
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
