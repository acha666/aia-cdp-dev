/**
 * Formatting of distinguished names and GeneralNames.
 *
 * @packageDocumentation
 */

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

/** One attribute of a name; `value` is its text, or `#` and its hex encoding. */
export interface NameAttribute {
  oid: string;
  label: string;
  string: string | undefined;
  value: string;
  encoding: string;
}

export interface NameView {
  rfc4514: string;
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

function escapeRdnValue(value: string): string {
  return value.replace(/[\\,+"<>;]|^[ #]| $|\0/g, (char) => (char === "\0" ? "\\00" : `\\${char}`));
}

/** Formats a name as RFC 4514 text, most specific RDN first. */
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

const isBlock = (value: unknown): value is BaseBlock => value instanceof BaseBlock;

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

/** Reads a name with its RDNs in encoded order and its RFC 4514 form. */
export function readName(name: pkijs.RelativeDistinguishedNames): NameView {
  const rdns = name.toSchema().valueBlock.value.map((group) => {
    if (!(group instanceof Asn1Set)) {
      throw new Error("Invalid RDN set");
    }
    return group.valueBlock.value.map(readAttribute);
  });
  return { rfc4514: formatRfc4514(rdns), rdns };
}

export const formatAttributes = (attributes: readonly NameAttribute[]) =>
  attributes.map(({ label, value }) => `${label}=${value}`).join("+");

export const readRelativeName = (block: BaseBlock) =>
  sequenceOf(block, context(1)).map(readAttribute);

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

/** Formats a Microsoft GUID, whose first three groups are little-endian. */
function formatGuid(bytes: Uint8Array): string {
  const le = (start: number, end: number) => toHex(bytes.slice(start, end).reverse());
  const hex = toHex(bytes);
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readOtherNameParts(block: BaseBlock): { typeOid: string; inner: BaseBlock } {
  const other = new DerReader(block, context(0));
  const typeOid = readOid(other.read(OBJECT_IDENTIFIER));
  const inner = explicit(other.read(context(0)), context(0));
  other.end();
  return { typeOid, inner };
}

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
  const groups = toHex(bytes).replace(/(.{4})(?=.)/g, "$1:");
  return new URL(`http://[${groups}]`).hostname.slice(1, -1);
}

function prefixLength(mask: Uint8Array): number | undefined {
  const bits = Array.from(mask, (byte) => byte.toString(2).padStart(8, "0")).join("");
  return /^(1*)0*$/.exec(bits)?.[1]?.length;
}

/** An address, or an address and mask in name constraints, written as a prefix length when it is one. */
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

function generalNameValue(type: (typeof GENERAL_NAME_TYPES)[number], block: BaseBlock): string {
  switch (type) {
    case "rfc822Name":
    case "dNSName":
    case "uniformResourceIdentifier":
      return readAscii(block);
    case "registeredID":
      return readOid(block);
    case "directoryName": {
      const schema = expectTag(explicit(block, context(4)), SEQUENCE);
      return readName(new pkijs.RelativeDistinguishedNames({ schema })).rfc4514;
    }
    case "iPAddress":
      return formatIpGeneralName(contents(block));
    default:
      if (!block.idBlock.isConstructed) {
        throw new Error("Invalid GeneralName");
      }
      return blockHex(block);
  }
}

/** Formats one GeneralName as `type: value`. */
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

export const formatGeneralNames = (block: BaseBlock, i18n: Text, tag = SEQUENCE) =>
  sequenceOf(block, tag, 0).map((name) => formatGeneralName(name, i18n));
