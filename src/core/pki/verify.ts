/**
 * CRL signature verification with an allow-list of algorithms: RSA PKCS #1 v1.5, RSASSA-PSS
 * and ECDSA (on P-256, P-384 or P-521), each with SHA-1, SHA-256, SHA-384 or SHA-512.
 *
 * @packageDocumentation
 */
import { Any, Null, ObjectIdentifier, Sequence } from "asn1js";
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import { CURVE_NAMES, HASH_ALG_NAMES, KEY_ALG_NAMES, SIGNATURE_ALG_NAMES } from "./constants.ts";
import { DerReader, INTEGER, contents, readDer } from "./der.ts";
import { messageOf } from "./errors.ts";
import { toDigestInput } from "../digest.ts";

export interface SignatureFailure {
  ok: false;
  error: "invalid_signature" | "unsupported_algorithm";
  details: { algorithm: string };
  detail: string;
}

export type SignatureCheck = { ok: true } | SignatureFailure;

type Scheme = "pkcs1" | "pss" | "ecdsa";

const ALLOWED_SIGNATURES: ReadonlyMap<string, Scheme> = new Map<string, Scheme>([
  ["1.2.840.113549.1.1.5", "pkcs1"],
  ["1.2.840.113549.1.1.11", "pkcs1"],
  ["1.2.840.113549.1.1.12", "pkcs1"],
  ["1.2.840.113549.1.1.13", "pkcs1"],
  ["1.2.840.113549.1.1.10", "pss"],
  ["1.2.840.10045.4.1", "ecdsa"],
  ["1.2.840.10045.4.3.2", "ecdsa"],
  ["1.2.840.10045.4.3.3", "ecdsa"],
  ["1.2.840.10045.4.3.4", "ecdsa"],
]);

const PSS_HASHES: ReadonlySet<string> = new Set([
  "1.3.14.3.2.26",
  "2.16.840.1.101.3.4.2.1",
  "2.16.840.1.101.3.4.2.2",
  "2.16.840.1.101.3.4.2.3",
]);

const RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const RSASSA_PSS = "1.2.840.113549.1.1.10";
const EC_PUBLIC_KEY = "1.2.840.10045.2.1";

/** Allowed curves and the byte length of their group order. */
const ALLOWED_CURVES: ReadonlyMap<string, number> = new Map([
  ["1.2.840.10045.3.1.7", 32],
  ["1.3.132.0.34", 48],
  ["1.3.132.0.35", 66],
]);

interface Refusal {
  error: SignatureFailure["error"];
  detail: string;
}

const name = (names: Record<string, string>, oid: string) =>
  names[oid] === undefined ? oid : `${names[oid]} (${oid})`;

function absentOrNull(params: unknown): boolean {
  return params === undefined || params instanceof Any || params instanceof Null;
}

function pssProblem(params: unknown): string | undefined {
  if (!(params instanceof Sequence)) {
    return "RSASSA-PSS without RSASSA-PSS-params";
  }
  let hash: pkijs.AlgorithmIdentifier;
  try {
    hash = new pkijs.RSASSAPSSParams({ schema: params }).hashAlgorithm;
  } catch (error) {
    return `Undecodable RSASSA-PSS-params: ${messageOf(error)}`;
  }
  if (!PSS_HASHES.has(hash.algorithmId) || !absentOrNull(hash.algorithmParams)) {
    return `RSASSA-PSS with the hash ${name(HASH_ALG_NAMES, hash.algorithmId)}`;
  }
  return undefined;
}

/** Requires r and s to be minimal positive INTEGERs that fit the curve; pkijs accepts BER. */
function ecdsaSignatureProblem(signature: Uint8Array, orderLength: number): string | undefined {
  let parts: BaseBlock[];
  try {
    const value = new DerReader(readDer(signature));
    parts = [value.read(INTEGER), value.read(INTEGER)];
    value.end();
  } catch (error) {
    return `The ECDSA signature is not DER SEQUENCE { r INTEGER, s INTEGER }: ${messageOf(error)}`;
  }
  for (const part of parts) {
    const value = contents(part);
    const [first = 0, second = 0] = value;
    const padded = first === 0 && (value.length === 1 || second < 0x80);
    if (first >= 0x80 || padded || value.length - (first === 0 ? 1 : 0) > orderLength) {
      return "The ECDSA signature holds an r or s that is not a positive minimal INTEGER";
    }
  }
  return undefined;
}

/** Checks the algorithm, its parameters and the issuer key before any crypto runs. */
function admit(
  crl: pkijs.CertificateRevocationList,
  issuerSpki: pkijs.PublicKeyInfo
): Refusal | undefined {
  const algorithm = crl.signatureAlgorithm;
  const scheme = ALLOWED_SIGNATURES.get(algorithm.algorithmId);
  if (scheme === undefined) {
    return { error: "unsupported_algorithm", detail: "Not in the signature algorithm allow-list" };
  }
  const params: unknown = algorithm.algorithmParams;
  const paramsProblem =
    scheme === "pss"
      ? pssProblem(params)
      : absentOrNull(params)
        ? undefined
        : "Parameters where the algorithm has none";
  if (paramsProblem !== undefined) {
    return { error: "unsupported_algorithm", detail: paramsProblem };
  }

  const key = issuerSpki.algorithm;
  const keyName = name(KEY_ALG_NAMES, key.algorithmId);
  let orderLength: number | undefined;
  if (scheme === "ecdsa") {
    if (key.algorithmId !== EC_PUBLIC_KEY) {
      return { error: "invalid_signature", detail: `An ECDSA signature, but a ${keyName} key` };
    }
    const curve: unknown = key.algorithmParams;
    const curveOid = curve instanceof ObjectIdentifier ? curve.valueBlock.toString() : undefined;
    orderLength = curveOid === undefined ? undefined : ALLOWED_CURVES.get(curveOid);
    if (orderLength === undefined) {
      const curveName =
        curveOid === undefined ? "explicit parameters" : name(CURVE_NAMES, curveOid);
      return { error: "unsupported_algorithm", detail: `An issuer key on ${curveName}` };
    }
  } else if (key.algorithmId === RSASSA_PSS) {
    return { error: "unsupported_algorithm", detail: "An RSASSA-PSS-restricted issuer key" };
  } else if (key.algorithmId !== RSA_ENCRYPTION) {
    return { error: "invalid_signature", detail: `An RSA signature, but a ${keyName} key` };
  }

  const signature = crl.signatureValue.valueBlock;
  if (signature.unusedBits !== 0) {
    return { error: "invalid_signature", detail: "The signature BIT STRING has unused bits" };
  }
  if (orderLength !== undefined) {
    const problem = ecdsaSignatureProblem(signature.valueHexView, orderLength);
    if (problem !== undefined) {
      return { error: "invalid_signature", detail: problem };
    }
  }
  return undefined;
}

/**
 * Verifies the CRL signature over its TBS bytes with the issuer's public key. pkijs's
 * `crl.verify()` is not used because it also compares issuer names and rejects critical
 * extensions it does not know.
 */
export async function verifyCrlSignature(
  crl: pkijs.CertificateRevocationList,
  issuerSpki: pkijs.PublicKeyInfo
): Promise<SignatureCheck> {
  const algorithm =
    SIGNATURE_ALG_NAMES[crl.signatureAlgorithm.algorithmId] ?? crl.signatureAlgorithm.algorithmId;
  const refuse = (error: SignatureFailure["error"], why: string): SignatureFailure => ({
    ok: false,
    error,
    details: { algorithm },
    detail: `${algorithm}: ${why}`,
  });
  const refusal = admit(crl, issuerSpki);
  if (refusal !== undefined) {
    return refuse(refusal.error, refusal.detail);
  }

  const engine = pkijs.getCrypto(true);
  try {
    const verified = await engine.verifyWithPublicKey(
      toDigestInput(crl.tbsView),
      crl.signatureValue,
      issuerSpki,
      crl.signatureAlgorithm
    );
    return verified ? { ok: true } : refuse("invalid_signature", "The signature does not match");
  } catch (error) {
    return refuse("invalid_signature", messageOf(error));
  }
}
