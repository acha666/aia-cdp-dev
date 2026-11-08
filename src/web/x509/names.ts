// X.509 names for display: a Name as its RFC 4514 string and attributes, and the GeneralName
// CHOICE as one line of text ("DNS: example.com"), with its special forms (otherName and the AD
// GUID, IP addresses and constraint ranges, directoryName). The small GeneralName readers also
// cover forms that PKIjs models cannot read or round-trip correctly.
import { BaseBlock, Set as Asn1Set } from "asn1js";
import * as pkijs from "pkijs";
import { stringOf } from "../../core/pki/asn1.ts";
import {
  OBJECT_IDENTIFIER,
  OCTET_STRING,
  SEQUENCE,
  DerReader,
  context,
  contents,
  expectTag,
  hasTag,
  explicit,
  readAscii,
  readOid,
  sequenceOf,
} from "../../core/pki/der.ts";
import { toHex, toUpperHex } from "../../core/digest.ts";
import type { I18nText } from "@/i18n";
import { blockHex, displayText } from "./asn1-dump";
import { OID_DICTIONARY, OTHER_NAME_TYPES, oidName } from "./oid-names";

type Text = Pick<I18nText, "t">;

// =============================================================================
// Names
// =============================================================================

/** One AttributeTypeAndValue; `value` is the string, or "#" and the DER of any other value. */
export interface NameAttribute {
  oid: string;
  /** The attribute type's long name, else its OID. */
  label: string;
  /** The string value; undefined when the value is no ASN.1 string. */
  string: string | undefined;
  value: string;
  /** The ASN.1 string type (utf8String, …), "unknown" for any other value. */
  encoding: string;
}

export interface NameView {
  /** RFC 4514, most significant RDN last. */
  rfc4514: string;
  /** The RDNs, each a list of attributes, in DER order. */
  rdns: NameAttribute[][];
}

const ENCODING_BY_TAG: Record<number, string> = {
  12: "utf8String",
  18: "numericString",
  19: "printableString",
  20: "teletexString",
  22: "ia5String",
  26: "visibleString",
  27: "generalString",
  28: "universalString",
  30: "bmpString",
};

/** RFC 4514 §2.4: specials anywhere, a space first or last, # first, NUL as \00. */
function escapeRdnValue(value: string): string {
  return value.replace(/[\\,+"<>;]|^[ #]| $|\0/g, (char) => (char === "\0" ? "\\00" : `\\${char}`));
}

function formatRfc4514(rdns: NameAttribute[][]): string {
  return [...rdns]
    .reverse()
    .map((rdn) =>
      rdn
        .map((attribute) => {
          const entry = OID_DICTIONARY[attribute.oid];
          const label = entry?.short ?? entry?.name ?? attribute.oid;
          const value =
            attribute.string !== undefined
              ? escapeRdnValue(attribute.string)
              : attribute.value.toLowerCase();
          return `${label}=${value}`;
        })
        .join("+")
    )
    .join(",");
}

/**
 * `value instanceof BaseBlock` narrows `unknown` to BaseBlock<any, any>, which typescript-eslint
 * rejects as an argument (no-unsafe-argument); this guard narrows to BaseBlock.
 */
const isBlock = (value: unknown): value is BaseBlock => value instanceof BaseBlock;

/** One AttributeTypeAndValue ::= SEQUENCE { type, value ANY }; the value need not be a string. */
function readAttribute(schema: BaseBlock): NameAttribute {
  const tv = new pkijs.AttributeTypeAndValue({ schema });
  const block: unknown = tv.value;
  const string = stringOf(block);
  const universal = isBlock(block) && block.idBlock.tagClass === 1;
  return {
    oid: tv.type,
    label: oidName(tv.type) ?? tv.type,
    string,
    value: string ?? `#${isBlock(block) ? blockHex(block) : ""}`,
    encoding: (universal ? ENCODING_BY_TAG[block.idBlock.tagNumber] : undefined) ?? "unknown",
  };
}

export function readName(name: pkijs.RelativeDistinguishedNames): NameView {
  const rdns = name.toSchema().valueBlock.value.map((group) => {
    if (!(group instanceof Asn1Set)) {
      throw new Error("Invalid RDN set");
    }
    return group.valueBlock.value.map(readAttribute);
  });
  return { rfc4514: formatRfc4514(rdns), rdns };
}

/** "commonName=x+…" with the attribute types' names (or OIDs), unescaped. */
export const formatAttributes = (attributes: readonly NameAttribute[]) =>
  attributes.map(({ label, value }) => `${label}=${value}`).join("+");

/** RelativeDistinguishedName ::= SET SIZE (1..MAX) OF AttributeTypeAndValue, under [1] IMPLICIT. */
export const readRelativeName = (block: BaseBlock) =>
  sequenceOf(block, context(1)).map(readAttribute);

// =============================================================================
// General names
// =============================================================================

/** The GeneralName CHOICE alternatives in tag order: [n] is GENERAL_NAME_TYPES[n] (RFC 5280). */
const GENERAL_NAME_TYPES = [
  "otherName",
  "rfc822Name",
  "dNSName",
  "x400Address",
  "directoryName",
  "ediPartyName",
  "uniformResourceIdentifier",
  "iPAddress",
  "registeredID",
] as const;

/** 16 octets in the GUID text form, whose first three fields are little-endian. */
function formatGuid(bytes: Uint8Array): string {
  const le = (start: number, end: number) => toHex(bytes.slice(start, end).reverse());
  const hex = toHex(bytes);
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** OtherName ::= SEQUENCE { type-id OBJECT IDENTIFIER, value [0] EXPLICIT ANY }, under [0]. */
export function readOtherNameParts(block: BaseBlock): { typeOid: string; inner: BaseBlock } {
  const other = new DerReader(block, context(0));
  const typeOid = readOid(other.read(OBJECT_IDENTIFIER));
  const inner = explicit(other.read(context(0)), context(0));
  other.end();
  return { typeOid, inner };
}

/** The AD object GUID of a domain controller certificate: 16 octets, shown as a GUID. */
const AD_GUID = "1.3.6.1.4.1.311.25.1";

function formatOtherName(block: BaseBlock): string {
  const { typeOid, inner } = readOtherNameParts(block);
  const bytes = hasTag(inner, OCTET_STRING) ? contents(inner) : undefined;
  const value =
    stringOf(inner) ??
    (typeOid === AD_GUID && bytes?.length === 16 ? formatGuid(bytes) : displayText(inner));
  return `${OTHER_NAME_TYPES[typeOid] ?? typeOid}: ${value || blockHex(inner)}`;
}

function formatIpAddress(bytes: Uint8Array): string | undefined {
  if (bytes.length === 4) {
    return bytes.join(".");
  }
  if (bytes.length !== 16) {
    return undefined;
  }
  // Eight groups of four hex digits; the WHATWG URL host serializer writes them in RFC 5952 form.
  const groups = toHex(bytes).replace(/(.{4})(?=.)/g, "$1:");
  return new URL(`http://[${groups}]`).hostname.slice(1, -1);
}

/** The prefix length of a contiguous netmask (ones, then zeros); undefined for any other mask. */
function prefixLength(mask: Uint8Array): number | undefined {
  const bits = Array.from(mask, (byte) => byte.toString(2).padStart(8, "0")).join("");
  return /^(1*)0*$/.exec(bits)?.[1]?.length;
}

/** iPAddress is 4/16 bytes in alternative names and 8/32 bytes (address + mask) in constraints. */
function formatIpGeneralName(bytes: Uint8Array): string {
  const plain = formatIpAddress(bytes);
  if (plain) {
    return plain;
  }
  if (bytes.length === 8 || bytes.length === 32) {
    const half = bytes.length / 2;
    const address = formatIpAddress(bytes.subarray(0, half)) ?? "";
    const mask = bytes.subarray(half);
    const prefix = prefixLength(mask);
    return prefix === undefined ? `${address}/${formatIpAddress(mask)}` : `${address}/${prefix}`;
  }
  return toUpperHex(bytes);
}

/** The text of a GeneralName after its type, read from its context-tagged element. */
function generalNameValue(type: (typeof GENERAL_NAME_TYPES)[number], block: BaseBlock): string {
  switch (type) {
    case "rfc822Name":
    case "dNSName":
    case "uniformResourceIdentifier":
      return readAscii(block);
    case "registeredID":
      return readOid(block);
    case "directoryName": {
      // Name is a CHOICE, so explicitly tagged.
      const schema = expectTag(explicit(block, context(4)), SEQUENCE);
      return readName(new pkijs.RelativeDistinguishedNames({ schema })).rfc4514;
    }
    case "iPAddress":
      return formatIpGeneralName(contents(block));
    default:
      // x400Address, ediPartyName: IMPLICIT SEQUENCEs with no useful text form; the DER is shown.
      if (!block.idBlock.isConstructed) {
        throw new Error("Invalid GeneralName");
      }
      return blockHex(block);
  }
}

/**
 * "DNS: host" (RFC 5280 §4.2.1.6), after the UI's short label of the type
 * (extension.generalName.*); an otherName after its known name or type OID.
 */
export function formatGeneralName(block: BaseBlock, i18n: Text): string {
  const type =
    block.idBlock.tagClass === 3 ? GENERAL_NAME_TYPES[block.idBlock.tagNumber] : undefined;
  if (type === undefined) {
    throw new Error("Invalid GeneralName");
  }
  if (type === "otherName") {
    return formatOtherName(block);
  }
  return `${i18n.t(`extension.generalName.${type}`)}: ${generalNameValue(type, block)}`;
}

/** GeneralNames, possibly implicitly tagged, one line each; an empty list stays empty. */
export const formatGeneralNames = (block: BaseBlock, i18n: Text, tag = SEQUENCE) =>
  sequenceOf(block, tag, 0).map((name) => formatGeneralName(name, i18n));
