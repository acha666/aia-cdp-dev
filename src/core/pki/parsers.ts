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

/** assertWellFormed as a PkiParseError: reason "time" for a time, "der" for anything else. */
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

// One top-level element and no decoder errors. Strict DER is left to the unsigned parts of a CRL
// (crlOf): what a CA signed is the CA's business. A Uint8Array may be a view into a larger buffer:
// asn1js decodes the view, so the end offset is compared with the view's byteLength, never the
// buffer's. asn1js's default limits (10 000 nodes, 16 MiB of contents, 100 levels) apply unless
// `limits` says otherwise.
function decode(der: ArrayBuffer | Uint8Array, kind: PkiKind, limits?: { maxDepth: number }) {
  const label = LABELS[kind];
  let asn1: ReturnType<typeof fromBER>;
  try {
    asn1 = fromBER(der, limits);
  } catch (error) {
    // asn1js throws instead of reporting some malformed values (a GeneralizedTime string).
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

/** PKIjs's object for `schema`; a tree that does not match PKIjs's schema is a structure error. */
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

/** Throws PkiParseError (kind "certificate", reason der / trailing_bytes / time / structure). */
export function parseCertificate(der: ArrayBuffer | Uint8Array): pkijs.Certificate {
  const schema = decode(der, "certificate");
  return construct("certificate", () => new pkijs.Certificate({ schema }));
}

/**
 * The octets of the two AlgorithmIdentifiers of a CRL as received (asn1js's valueBeforeDecodeView,
 * a view of its copy of the input, like PKIjs's own tbsView). RFC 5280 §5.1.1.2: they must be the
 * same. The upload policy compares these: the outer one is outside the signature, so anyone
 * holding the file can rewrite it, and comparing re-encodings would hide what asn1js normalizes.
 */
export interface ReceivedAlgorithms {
  /** The outer signatureAlgorithm of the CertificateList, outside the signature. */
  signatureAlgorithmView: Uint8Array;
  /** The signature field of the TBSCertList. */
  signatureView: Uint8Array;
}

/** A CRL from parseCrlHeader: PKIjs's object plus its AlgorithmIdentifiers as received. */
export interface ReceivedCrl extends pkijs.CertificateRevocationList, ReceivedAlgorithms {}

/** Whether the outer signatureAlgorithm and the TBS signature are the same octets (OID and parameters). */
export function sameSignatureAlgorithms(received: ReceivedAlgorithms): boolean {
  const { signatureAlgorithmView: outer, signatureView: inner } = received;
  return (
    outer.byteLength === inner.byteLength && outer.every((octet, index) => octet === inner[index])
  );
}

/**
 * PKIjs's CRL for `schema` plus its received AlgorithmIdentifiers. The signatureAlgorithm and
 * signatureValue are outside the signature, so anyone could re-encode them: they must be DER.
 */
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

// A CRL without its entries is the issuer name, the times, a few extensions and the signature: well
// under 4 KiB for any real CA. The cap keeps the decoding before the signature check small.
const MAX_HEADER_BYTES = 16 * 1024;

/** The TLVs that fill the contents of `parent` exactly; more than `max` is a structure error. */
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
 * The CRL in `der` without its revoked entries, for the checks an upload passes before its
 * signature is verified: those entries are only split off by their TLV header, never decoded.
 * The outer SEQUENCE must be DER and span `der` exactly, filled by exactly its three fields; the
 * revokedCertificates of the TBSCertList is the SEQUENCE after thisUpdate or nextUpdate. A
 * CertificateList re-assembled from every other field, octet for octet, must fit in 16 KiB and then
 * decode to the same fields. `tbsView` is the TBSCertList
 * as received, entries included, which the signature covers; `revokedCertificates` is undefined.
 * Throws PkiParseError like parseCRL.
 */
export function parseCrlHeader(der: Uint8Array): ReceivedCrl {
  return splitCrl(der).crl;
}

/** parseCrlHeader's CRL and the TLV of its revokedCertificates, undefined when the list is absent. */
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
  // The header is read without the list, so a field after it but crlExtensions would take its
  // place there (a nextUpdate, a second list) where the whole CRL fails PKIjs's schema.
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
  // asn1js reads the elements of a constructed value as far as its input goes, not only as far as
  // the value: a field whose elements overrun it makes asn1js read other fields than the split
  // above (a revoked list among them, whose entries parseCRL would then skip).
  const tbsFields = new DerReader(new DerReader(schema).read(SEQUENCE)).rest(0);
  const overruns = ({ idBlock, lenBlock, valueBlock }: BaseBlock) =>
    idBlock.isConstructed && valueBlock.blockLength !== lenBlock.length;
  if (tbsFields.some(overruns)) {
    throw new PkiParseError("crl", "der", "Bad CRL DER: a field's elements overrun it");
  }
  const crl = crlOf(schema);
  crl.tbsView = octets(tbs);
  return { crl, revoked: fields[revoked] };
}

/** A revoked entry from parseCRL as plain values: its asn1js tree is not kept. */
export interface CrlEntry {
  /** The contents octets of userCertificate. */
  serial: Uint8Array;
  revocationDate: pkijs.Time;
  /** [] when crlEntryExtensions is absent. */
  extensions: PlainExtension[];
}

/** A CRL from parseCRL: parseCrlHeader's CRL plus every revoked entry in order, [] for none. */
export interface WholeCrl extends ReceivedCrl {
  entries: CrlEntry[];
}

/** One entry of revokedCertificates (its TLV), decoded on its own. */
function readEntry(der: Uint8Array): CrlEntry {
  // An entry sits three levels below the CertificateList (TBSCertList, revokedCertificates).
  const schema = decode(der, "crl", { maxDepth: 97 });
  const entry = construct("crl", () => new pkijs.RevokedCertificate({ schema }));
  return {
    serial: entry.userCertificate.valueBlock.valueHexView,
    revocationDate: entry.revocationDate,
    extensions: entry.crlEntryExtensions?.extensions.map(plainExtension) ?? [],
  };
}

/**
 * The whole CRL, every revoked entry included. Throws PkiParseError (kind "crl", reason der /
 * trailing_bytes / time / structure). parseCrlHeader's checks come first; then each entry is
 * decoded on its own and kept as plain values, so that one entry's asn1js tree is alive at a time
 * (the tree of a whole CRL takes some 140 bytes of heap per octet). The entries still take far
 * more memory than the input, so this is only for a CRL whose signature verified or one already
 * stored; an upload is checked on parseCrlHeader first.
 */
export function parseCRL(der: Uint8Array): WholeCrl {
  const { crl, revoked } = splitCrl(der);
  const entries = revoked
    ? fieldsOf(der, revoked, Infinity).map((tlv) => readEntry(der.subarray(tlv.start, tlv.end)))
    : [];
  return Object.assign(crl, { entries });
}
