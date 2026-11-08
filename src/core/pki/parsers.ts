/**
 * Certificate and CRL parsing into pkijs objects, with every failure as a
 * {@link PkiParseError}.
 *
 * The signature covers everything but the outer SEQUENCE, signatureAlgorithm and
 * signatureValue, so only those must be strict DER: then nobody can publish a re-encoded copy
 * of a CRL ahead of the original. The rest only has to decode.
 *
 * A CRL can be large, so its header (everything but the revoked entries) is parsed first and
 * on its own; the entries are parsed one at a time, and only when needed.
 *
 * @packageDocumentation
 */
import { fromBER } from "asn1js";
import type { BaseBlock } from "asn1js";
import * as pkijs from "pkijs";
import { Asn1TimeError, assertWellFormed } from "./asn1.ts";
import { BIT_STRING, DerReader, INTEGER, SEQUENCE } from "./der.ts";
import { messageOf, PkiParseError } from "./errors.ts";
import type { PkiKind } from "./errors.ts";
import { plainExtension } from "./extensions.ts";
import type { PlainExtension } from "./extensions.ts";
import { encodeTlv, readTlv } from "./pem.ts";
import type { Tlv } from "./pem.ts";

const LABELS: Record<PkiKind, string> = { certificate: "certificate", crl: "CRL" };

function wellFormed(kind: PkiKind, block: BaseBlock, der: boolean): void {
  try {
    assertWellFormed(block, der);
  } catch (error) {
    throw new PkiParseError(
      kind,
      error instanceof Asn1TimeError ? "time" : "der",
      `Bad ${LABELS[kind]} DER: ${messageOf(error)}`,
      { cause: error }
    );
  }
}

/** Decodes one element that spans `der`, checking for decode errors but not DER rules. */
function decode(der: ArrayBuffer | Uint8Array, kind: PkiKind, limits?: { maxDepth: number }) {
  const label = LABELS[kind];
  let asn1: ReturnType<typeof fromBER>;
  try {
    asn1 = fromBER(der, limits);
  } catch (error) {
    throw new PkiParseError(kind, "der", `Bad ${label} DER: ${String(error)}`, { cause: error });
  }
  if (asn1.offset === -1) {
    throw new PkiParseError(kind, "der", `Bad ${label} DER: ${asn1.result.error}`);
  }
  if (asn1.offset !== der.byteLength) {
    throw new PkiParseError(kind, "trailing_bytes", `Bad ${label} DER: trailing bytes`);
  }
  wellFormed(kind, asn1.result, false);
  return asn1.result;
}

function construct<T>(kind: PkiKind, build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new PkiParseError(
      kind,
      "structure",
      `Bad ${LABELS[kind]} structure: ${messageOf(error)}`,
      { cause: error }
    );
  }
}

/**
 * Parses a DER certificate.
 *
 * @throws {@link PkiParseError}
 */
export function parseCertificate(der: ArrayBuffer | Uint8Array): pkijs.Certificate {
  const schema = decode(der, "certificate");
  return construct("certificate", () => new pkijs.Certificate({ schema }));
}

/** The two signature AlgorithmIdentifiers of a CRL, as received. */
export interface ReceivedAlgorithms {
  signatureAlgorithmView: Uint8Array;
  signatureView: Uint8Array;
}

export interface ReceivedCrl extends pkijs.CertificateRevocationList, ReceivedAlgorithms {}

/** RFC 5280 5.1.1.2: the outer and TBS signature algorithms must be identical. */
export function sameSignatureAlgorithms(received: ReceivedAlgorithms): boolean {
  const { signatureAlgorithmView: outer, signatureView: inner } = received;
  return (
    outer.byteLength === inner.byteLength && outer.every((octet, index) => octet === inner[index])
  );
}

/** Builds the pkijs CRL and keeps the raw algorithm bytes; the signature fields must be DER. */
function crlOf(schema: BaseBlock): ReceivedCrl {
  const crl = construct("crl", () => new pkijs.CertificateRevocationList({ schema }));
  const outer = new DerReader(schema);
  const tbs = new DerReader(outer.read(SEQUENCE));
  tbs.optional(INTEGER);
  const signature = tbs.read(SEQUENCE);
  const algorithm = outer.read(SEQUENCE);
  wellFormed("crl", algorithm, true);
  wellFormed("crl", outer.read(BIT_STRING), true);
  return Object.assign(crl, {
    signatureView: signature.valueBeforeDecodeView,
    signatureAlgorithmView: algorithm.valueBeforeDecodeView,
  });
}

const SEQUENCE_TAG = 0x30;
const UTC_TIME_TAG = 0x17;
const GENERALIZED_TIME_TAG = 0x18;
const CRL_EXTENSIONS_TAG = 0xa0;

/** Bounds the part of a CRL that is fully decoded before its signature is verified. */
const MAX_HEADER_BYTES = 16 * 1024;

/** Splits the contents of `parent` into at most `max` TLVs. */
function fieldsOf(der: Uint8Array, parent: Tlv, max: number): Tlv[] {
  const fields: Tlv[] = [];
  let at = parent.contents;
  while (at < parent.end) {
    const field = readTlv(der, at, parent.end);
    if (field === undefined) {
      throw new PkiParseError("crl", "der", "Bad CRL DER: a field is not one DER TLV");
    }
    if (fields.length === max) {
      throw new PkiParseError("crl", "structure", `Bad CRL structure: more than ${max} fields`);
    }
    fields.push(field);
    at = field.end;
  }
  return fields;
}

/**
 * Parses a DER CRL without its revoked entries; `tbsView` still covers the whole TBS, so
 * the signature can be verified.
 *
 * @throws {@link PkiParseError}
 */
export function parseCrlHeader(der: Uint8Array): ReceivedCrl {
  return splitCrl(der).crl;
}

// The revoked list is the SEQUENCE right after thisUpdate or nextUpdate; the header is
// re-encoded without it.
function splitCrl(der: Uint8Array): { crl: ReceivedCrl; revoked: Tlv | undefined } {
  const outer = readTlv(der, 0, der.length);
  if (outer === undefined) {
    throw new PkiParseError("crl", "der", "Bad CRL DER: not one definite-length DER TLV");
  }
  if (outer.end !== der.length) {
    throw new PkiParseError("crl", "trailing_bytes", "Bad CRL DER: trailing bytes");
  }
  const [tbs, ...unsigned] = outer.tag === SEQUENCE_TAG ? fieldsOf(der, outer, 3) : [];
  if (tbs?.tag !== SEQUENCE_TAG || unsigned.length !== 2) {
    throw new PkiParseError(
      "crl",
      "structure",
      "Bad CRL structure: not SEQUENCE { SEQUENCE, signatureAlgorithm, signatureValue }"
    );
  }
  const fields = fieldsOf(der, tbs, 7);
  const revoked = fields.findIndex(
    (field, index) =>
      field.tag === SEQUENCE_TAG &&
      [UTC_TIME_TAG, GENERALIZED_TIME_TAG].includes(fields[index - 1]?.tag ?? 0)
  );
  if (revoked !== -1 && ![undefined, CRL_EXTENSIONS_TAG].includes(fields[revoked + 1]?.tag)) {
    throw new PkiParseError(
      "crl",
      "structure",
      "Bad CRL structure: a field other than crlExtensions after revokedCertificates"
    );
  }
  const octets = (tlv: Tlv) => der.subarray(tlv.start, tlv.end);
  const header = encodeTlv(SEQUENCE_TAG, [
    encodeTlv(SEQUENCE_TAG, fields.filter((_, index) => index !== revoked).map(octets)),
    ...unsigned.map(octets),
  ]);
  if (header.byteLength > MAX_HEADER_BYTES) {
    throw new PkiParseError(
      "crl",
      "structure",
      "Bad CRL structure: more than 16 KiB besides the entries"
    );
  }
  const schema = decode(header, "crl");
  const tbsFields = new DerReader(new DerReader(schema).read(SEQUENCE)).rest(0);
  // asn1js reads a constructed value's elements as far as the input goes, so a field whose
  // elements overrun it would be read differently from the split above.
  const overruns = ({ idBlock, lenBlock, valueBlock }: BaseBlock) =>
    idBlock.isConstructed && valueBlock.blockLength !== lenBlock.length;
  if (tbsFields.some(overruns)) {
    throw new PkiParseError("crl", "der", "Bad CRL DER: a field's elements overrun it");
  }
  const crl = crlOf(schema);
  crl.tbsView = octets(tbs);
  return { crl, revoked: fields[revoked] };
}

export interface CrlEntry {
  serial: Uint8Array;
  revocationDate: pkijs.Time;
  extensions: PlainExtension[];
}

/** A CRL with its revoked entries. */
export interface WholeCrl extends ReceivedCrl {
  entries: CrlEntry[];
}

function readEntry(der: Uint8Array): CrlEntry {
  const schema = decode(der, "crl", { maxDepth: 97 });
  const entry = construct("crl", () => new pkijs.RevokedCertificate({ schema }));
  return {
    serial: entry.userCertificate.valueBlock.valueHexView,
    revocationDate: entry.revocationDate,
    extensions: entry.crlEntryExtensions?.extensions.map(plainExtension) ?? [],
  };
}

/**
 * Parses a DER CRL with all its revoked entries.
 *
 * @throws {@link PkiParseError}
 */
export function parseCRL(der: Uint8Array): WholeCrl {
  const { crl, revoked } = splitCrl(der);
  const entries = revoked
    ? fieldsOf(der, revoked, Infinity).map((tlv) => readEntry(der.subarray(tlv.start, tlv.end)))
    : [];
  return Object.assign(crl, { entries });
}
