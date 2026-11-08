import { ObjectIdentifier, Sequence } from "asn1js";
import * as pkijs from "pkijs";
import { CURVE_NAMES, HASH_ALG_NAMES } from "../../core/pki/constants.ts";
import { INTEGER, context, expectTag, explicit, hasTag, readInteger } from "../../core/pki/der.ts";
import { toUpperHex } from "../../core/digest.ts";
import type { I18nText } from "@/i18n";
import { MASK_GEN_ALG_NAMES, oidName } from "./oid-names";

export const versionText = (version: number | undefined) => `v${String((version ?? 0) + 1)}`;

const nameOf = (oid: string, names?: Record<string, string>) => oidName(oid, names) ?? oid;

const RSASSA_PSS_OID = "1.2.840.113549.1.1.10";

const SALT_LENGTH = context(2);

function saltLength(params: Sequence): number | undefined {
  const field = params.valueBlock.value.find((block) => hasTag(block, SALT_LENGTH));
  return field && readInteger(expectTag(explicit(field, SALT_LENGTH), INTEGER));
}

function pssText(params: Sequence, i18n: Pick<I18nText, "t">): string | undefined {
  try {
    const pss = new pkijs.RSASSAPSSParams({ schema: params });
    const mgfParams: unknown = pss.maskGenAlgorithm.algorithmParams;
    let mask = nameOf(pss.maskGenAlgorithm.algorithmId, MASK_GEN_ALG_NAMES);
    if (mgfParams instanceof Sequence) {
      try {
        const hash = new pkijs.AlgorithmIdentifier({ schema: mgfParams });
        mask += `/${nameOf(hash.algorithmId, HASH_ALG_NAMES)}`;
      } catch {}
    }
    const salt = i18n.t("algorithm.salt", { length: saltLength(params) ?? pss.saltLength });
    return `${nameOf(pss.hashAlgorithm.algorithmId, HASH_ALG_NAMES)}, ${mask}, ${salt}`;
  } catch {
    return undefined;
  }
}

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

export function uniqueIdHex(content: ArrayBuffer | undefined): string | undefined {
  return content && content.byteLength > 0
    ? toUpperHex(new Uint8Array(content).subarray(1))
    : undefined;
}
