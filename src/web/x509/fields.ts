// The one-line texts of a certificate's and a CRL's other fields: version, algorithms (with their
// parameters), the public key's size or curve, and the unique identifiers. The RSASSA-PSS integers
// are read from their contents octets: PKIjs's numbers are asn1js's valueDec, 0 from four contents
// octets on.
import { ObjectIdentifier, Sequence } from "asn1js";
import * as pkijs from "pkijs";
import { CURVE_NAMES, HASH_ALG_NAMES } from "../../core/pki/constants.ts";
import { INTEGER, context, expectTag, explicit, hasTag, readInteger } from "../../core/pki/der.ts";
import { toUpperHex } from "../../core/digest.ts";
import type { I18nText } from "@/i18n";
import { MASK_GEN_ALG_NAMES, oidName } from "./oid-names";

/** "v1", "v2", "v3" from the version field (0, 1, 2; absent is v1). */
export const versionText = (version: number | undefined) => `v${String((version ?? 0) + 1)}`;

/** An OID's name from `names`, else from the dictionary, else the OID. */
const nameOf = (oid: string, names?: Record<string, string>) => oidName(oid, names) ?? oid;

const RSASSA_PSS_OID = "1.2.840.113549.1.1.10";

const SALT_LENGTH = context(2);

/** saltLength [2] EXPLICIT INTEGER of RSASSA-PSS-params (RFC 4055 §3.1); undefined when absent. */
function saltLength(params: Sequence): number | undefined {
  const field = params.valueBlock.value.find((block) => hasTag(block, SALT_LENGTH));
  return field && readInteger(expectTag(explicit(field, SALT_LENGTH), INTEGER));
}

/** "SHA-256, MGF1/SHA-256, salt 32"; undefined when the parameters do not decode. */
function pssText(params: Sequence, i18n: Pick<I18nText, "t">): string | undefined {
  try {
    const pss = new pkijs.RSASSAPSSParams({ schema: params });
    const mgfParams: unknown = pss.maskGenAlgorithm.algorithmParams;
    let mask = nameOf(pss.maskGenAlgorithm.algorithmId, MASK_GEN_ALG_NAMES);
    if (mgfParams instanceof Sequence) {
      try {
        const hash = new pkijs.AlgorithmIdentifier({ schema: mgfParams });
        mask += `/${nameOf(hash.algorithmId, HASH_ALG_NAMES)}`;
      } catch {
        // An MGF1 hash that does not decode is left out.
      }
    }
    // PKIjs's default (20, RFC 4055 §3.1) when absent.
    const salt = i18n.t("algorithm.salt", { length: saltLength(params) ?? pss.saltLength });
    return `${nameOf(pss.hashAlgorithm.algorithmId, HASH_ALG_NAMES)}, ${mask}, ${salt}`;
  } catch {
    return undefined;
  }
}

/**
 * The algorithm's name followed by its decoded parameters: "RSASSA-PSS (SHA-256, MGF1/SHA-256,
 * salt 32)", "ECDSA (P-256)"; NULL and parameters that do not decode add nothing.
 */
export function formatAlgorithm(
  algorithm: pkijs.AlgorithmIdentifier,
  names: Record<string, string>,
  i18n: Pick<I18nText, "t">
): string {
  const base = nameOf(algorithm.algorithmId, names);
  const params: unknown = algorithm.algorithmParams;
  let detail: string | undefined;
  if (params instanceof ObjectIdentifier) {
    detail = nameOf(params.valueBlock.toString(), CURVE_NAMES);
  } else if (algorithm.algorithmId === RSASSA_PSS_OID && params instanceof Sequence) {
    detail = pssText(params, i18n);
  }
  return detail === undefined ? base : `${base} (${detail})`;
}

/** An RSA key's modulus size in bits, or an EC key's curve name; neither for any other key. */
export function publicKeyInfo(spki: pkijs.PublicKeyInfo): { bits?: number; curve?: string } {
  const key: unknown = spki.parsedKey;
  if (key instanceof pkijs.RSAPublicKey) {
    const modulus = BigInt(`0x${toUpperHex(key.modulus.valueBlock.valueHexView) || "0"}`);
    return modulus > 0n ? { bits: modulus.toString(2).length } : {};
  }
  if (key instanceof pkijs.ECPublicKey) {
    const curve = pkijs.ECNamedCurves.find(key.namedCurve);
    return { curve: nameOf(curve?.id ?? key.namedCurve, CURVE_NAMES) };
  }
  return {};
}

/**
 * The bits of an implicitly tagged BIT STRING whose raw contents PKIjs keeps (a unique ID): the
 * octets after the unused-bit count, in hex; undefined when absent.
 */
export function uniqueIdHex(content: ArrayBuffer | undefined): string | undefined {
  return content && content.byteLength > 0
    ? toUpperHex(new Uint8Array(content).subarray(1))
    : undefined;
}
