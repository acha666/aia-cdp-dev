// Signature check of an uploaded CRL. Not the verify method of PKIjs's CertificateRevocationList:
// that compares the CRL's issuer name with the certificate's subject and silently fails a critical
// extension outside PKIjs's own list. Here the key is whichever certificate the target names, the
// CRL extension policy (crl-policy.ts) has already run, and PKIjs only does the cryptography, on
// the engine it installs from globalThis.crypto by itself (the engine is never replaced).
import { Any, Null, ObjectIdentifier, Sequence } from "asn1js";
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import { CURVE_NAMES, HASH_ALG_NAMES, KEY_ALG_NAMES, SIGNATURE_ALG_NAMES } from "./constants.ts";
import { DerReader, INTEGER, contents, readDer } from "./der.ts";
import { messageOf } from "./errors.ts";
import { toDigestInput } from "../digest.ts";

/** A refusal shaped like CrlPolicyFailure (crl-policy.ts): publishCrl maps both alike. */
export interface SignatureFailure {
  ok: false;
  error: "invalid_signature" | "unsupported_algorithm";
  /** `algorithm`: the CRL's signature algorithm, its SIGNATURE_ALG_NAMES name, else the OID. */
  details: { algorithm: string };
  /** The algorithm and why, for the log only (it may hold exception text). */
  detail: string;
}

export type SignatureCheck = { ok: true } | SignatureFailure;

type Scheme = "pkcs1" | "pss" | "ecdsa";

/**
 * The allow-list, by signature algorithm OID; everything else is unsupported_algorithm before any
 * cryptography: EdDSA, the SHA-224 variants, DSA, SM2, MD2 / MD5, unknown OIDs. SHA-1 is accepted:
 * a distribution point does not judge the CA's choices. The hash of RSASSA-PSS is in its
 * parameters.
 */
const ALLOWED_SIGNATURES: ReadonlyMap<string, Scheme> = new Map<string, Scheme>([
  ["1.2.840.113549.1.1.5", "pkcs1"], // sha1WithRSAEncryption
  ["1.2.840.113549.1.1.11", "pkcs1"], // sha256WithRSAEncryption
  ["1.2.840.113549.1.1.12", "pkcs1"], // sha384WithRSAEncryption
  ["1.2.840.113549.1.1.13", "pkcs1"], // sha512WithRSAEncryption
  ["1.2.840.113549.1.1.10", "pss"], // RSASSA-PSS
  ["1.2.840.10045.4.1", "ecdsa"], // ecdsa-with-SHA1
  ["1.2.840.10045.4.3.2", "ecdsa"], // ecdsa-with-SHA256
  ["1.2.840.10045.4.3.3", "ecdsa"], // ecdsa-with-SHA384
  ["1.2.840.10045.4.3.4", "ecdsa"], // ecdsa-with-SHA512
]);

/** Hashes RSASSA-PSS may name, the same four. */
const PSS_HASHES: ReadonlySet<string> = new Set([
  "1.3.14.3.2.26",
  "2.16.840.1.101.3.4.2.1",
  "2.16.840.1.101.3.4.2.2",
  "2.16.840.1.101.3.4.2.3",
]);

const RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const RSASSA_PSS = "1.2.840.113549.1.1.10";
const EC_PUBLIC_KEY = "1.2.840.10045.2.1";

/** Issuer curves by OID, with the octet length of their order (r and s at most that long). */
const ALLOWED_CURVES: ReadonlyMap<string, number> = new Map([
  ["1.2.840.10045.3.1.7", 32], // P-256
  ["1.3.132.0.34", 48], // P-384
  ["1.3.132.0.35", 66], // P-521
]);

interface Refusal {
  error: SignatureFailure["error"];
  detail: string;
}

const name = (names: Record<string, string>, oid: string) =>
  names[oid] === undefined ? oid : `${names[oid]} (${oid})`;

// PKIjs types algorithmParams as any.
function absentOrNull(params: unknown): boolean {
  return params === undefined || params instanceof Any || params instanceof Null;
}

/**
 * RSASSA-PSS-params (RFC 4055 §3.1) whose hash is allowed (absent: the RFC default, SHA-1). The
 * other fields are signed with the TBS, so only the CA can get them wrong. Parameters that PKIjs
 * cannot decode are a problem too.
 */
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

/**
 * ECDSA-Sig-Value (RFC 5480 §2.2.3) in DER: exactly SEQUENCE { r INTEGER, s INTEGER }, both
 * minimal and positive and no longer than the curve order. PKIjs ignores bytes after the SEQUENCE,
 * takes an ENUMERATED for an INTEGER and a negative or zero-padded INTEGER as its unsigned bytes,
 * so without this one signature would verify under several encodings, which OpenSSL refuses too.
 */
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
    // X.690 §8.3.2: no leading 00 unless the next octet has its top bit set; r, s ∈ [1, n − 1].
    const padded = first === 0 && (value.length === 1 || second < 0x80);
    if (first >= 0x80 || padded || value.length - (first === 0 ? 1 : 0) > orderLength) {
      return "The ECDSA signature holds an r or s that is not a positive minimal INTEGER";
    }
  }
  return undefined;
}

/** What the allow-list and the issuer key say before any cryptography; undefined: go ahead. */
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
    // WebCrypto imports RSA public keys only as rsaEncryption.
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
 * Whether `crl` was signed with the key `issuerSpki` (the target's configured issuer). The
 * algorithm is admitted by OID first (unsupported_algorithm), then
 * `pkijs.getCrypto(true).verifyWithPublicKey` checks the signature over `crl.tbsView`: the
 * TBSCertList octets as received (parseCRL and parseCrlHeader both keep them), never a re-encoding.
 * False, or a throw from the cryptography, is invalid_signature with the exception text in `detail`
 * only. Issuer names are not compared. The only throw left is a missing crypto engine, a server
 * fault rather than a bad signature.
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
