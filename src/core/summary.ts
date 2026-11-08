// Catalog summaries. A summary is always built whole and replaces the previous one (no merge, no
// summary version), so there is one implementation of each summary.
import type {
  Certificate,
  CertificateRevocationList,
  Extension,
  RelativeDistinguishedNames,
} from "pkijs";
import type { CertificateSummary, CrlSummary } from "./catalog.ts";
import { sha1Hex, toHex, toUpperHex } from "./digest.ts";
import { readStrictTime, stringOf } from "./pki/asn1.ts";
import { PkiParseError } from "./pki/errors.ts";
import type { PkiKind } from "./pki/errors.ts";
import {
  readAuthorityKeyId,
  readCrlNumber,
  readExtensionSchema,
  readSubjectKeyId,
} from "./pki/extensions.ts";
import type { WholeCrl } from "./pki/parsers.ts";

/** AD CS Next CRL Publish: when the CA will publish its next CRL (before nextUpdate). */
export const NEXT_CRL_PUBLISH_OID = "1.3.6.1.4.1.311.21.4";

const findExtension = (extensions: Extension[] | undefined, oid: string) =>
  extensions?.find((extension) => extension.extnID === oid);

/** `read(value)` of the extension, with whatever it throws reported as a malformed `name`. */
function readExtension<T>(
  kind: PkiKind,
  name: string,
  extension: Extension,
  read: (value: ReturnType<typeof readExtensionSchema>) => T
): T {
  try {
    return read(readExtensionSchema(extension));
  } catch (error) {
    throw new PkiParseError(kind, "extension_value", `Invalid ${name} extension`, {
      cause: error,
    });
  }
}

/**
 * keyIdentifier of the Authority Key Identifier in `extensions` (a certificate's or a CRL's),
 * lowercase hex; undefined without the extension or without a keyIdentifier. A malformed one,
 * trailing bytes included, is a PkiParseError of `kind`.
 */
export function authorityKeyId(
  kind: PkiKind,
  extensions: Extension[] | undefined
): string | undefined {
  const extension = findExtension(extensions, "2.5.29.35");
  const key =
    extension &&
    readExtension(
      kind,
      "Authority Key Identifier",
      extension,
      (value) => readAuthorityKeyId(value).keyIdentifier
    );
  return key && toHex(key);
}

function subjectKeyId(cert: Certificate): string | undefined {
  const extension = findExtension(cert.extensions, "2.5.29.14");
  return (
    extension &&
    toHex(readExtension("certificate", "Subject Key Identifier", extension, readSubjectKeyId))
  );
}

// A malformed SKI / AKI rejects the certificate, never skipped silently. An empty key id is
// rejected too: it cannot identify a key, and the catalog format requires hex.
function nonEmptyKeyId(name: string, keyId: string | undefined): string | null {
  if (keyId === "") {
    throw new PkiParseError("certificate", "extension_value", `Empty ${name} key identifier`);
  }
  return keyId ?? null;
}

/** The first string CN in the attributes PKIjs has already decoded. */
function commonName(name: RelativeDistinguishedNames): string | null {
  for (const attribute of name.typesAndValues) {
    const text = attribute.type === "2.5.4.3" ? stringOf(attribute.value) : undefined;
    if (text !== undefined) {
      return text;
    }
  }
  return null;
}

/**
 * Summary of a certificate parsed by parseCertificate (so its times are valid RFC 5280 times) from
 * `der`. Throws PkiParseError (kind "certificate", reason "extension_value") when the Subject or
 * Authority Key Identifier extension is present but malformed.
 */
export async function buildCertificateSummary(
  cert: Certificate,
  der: Uint8Array
): Promise<CertificateSummary> {
  return {
    subjectCN: commonName(cert.subject),
    issuerCN: commonName(cert.issuer),
    serialNumber: toUpperHex(cert.serialNumber.valueBlock.valueHexView),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    subjectKeyId: nonEmptyKeyId("Subject Key Identifier", subjectKeyId(cert)),
    authorityKeyId: nonEmptyKeyId(
      "Authority Key Identifier",
      authorityKeyId("certificate", cert.extensions)
    ),
    sha1: await sha1Hex(der),
  };
}

/** The CRL Number or Delta CRL Indicator `oid` of `crl`; undefined without it. */
function crlNumber(crl: CertificateRevocationList, oid: string, name: string): bigint | undefined {
  const extension = findExtension(crl.crlExtensions?.extensions, oid);
  return extension && readExtension("crl", name, extension, readCrlNumber);
}

/**
 * The AD CS Next CRL Publish time: exactly one UTCTime / GeneralizedTime in the RFC 5280 form (AD
 * CS writes a UTCTime). Undefined without the extension, and also for a value that cannot be read
 * as such: the time only informs the CRL status, so it does not reject the CRL.
 */
function nextCrlPublish(crl: CertificateRevocationList): Date | undefined {
  const extension = findExtension(crl.crlExtensions?.extensions, NEXT_CRL_PUBLISH_OID);
  if (!extension) {
    return undefined;
  }
  try {
    return readStrictTime(readExtensionSchema(extension)).date;
  } catch {
    return undefined;
  }
}

/** The fields of a CRL summary that the CRL's own fields and extensions give. */
export type CrlFields = Omit<CrlSummary, "revokedCount" | "sha1">;

/**
 * The CrlFields of a CRL from parseCRL or parseCrlHeader (so its times are valid RFC 5280 times).
 * Throws PkiParseError (kind "crl", reason "extension_value") when the CRL Number or the Delta CRL
 * Indicator (exactly one INTEGER ≥ 0, not longer than MAX_CRL_NUMBER_OCTETS) is present but
 * malformed. A Next CRL Publish that cannot be read is null, like a missing one.
 */
export function readCrlFields(crl: CertificateRevocationList): CrlFields {
  const number = crlNumber(crl, "2.5.29.20", "CRL Number");
  const base = crlNumber(crl, "2.5.29.27", "Delta CRL Indicator");
  return {
    crlNumber: number?.toString(10) ?? null,
    baseCrlNumber: base?.toString(10) ?? null,
    thisUpdate: crl.thisUpdate.value.toISOString(),
    nextUpdate: crl.nextUpdate?.value.toISOString() ?? null,
    nextPublish: nextCrlPublish(crl)?.toISOString() ?? null,
  };
}

/**
 * Summary of a CRL parsed by parseCRL from `der`, in the catalog format of `current.summary`.
 * Throws like readCrlFields.
 */
export async function buildCrlSummary(crl: WholeCrl, der: Uint8Array): Promise<CrlSummary> {
  return {
    ...readCrlFields(crl),
    revokedCount: crl.entries.length,
    sha1: await sha1Hex(der),
  };
}
