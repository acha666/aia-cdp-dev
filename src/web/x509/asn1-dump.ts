import {
  BitString,
  Boolean as Asn1Boolean,
  GeneralizedTime,
  Integer,
  Null,
  ObjectIdentifier,
  OctetString,
  UTCTime,
  fromBER,
} from "asn1js";
import type { BaseBlock } from "asn1js";
import { asciiOf, children, readStrictTime, stringOf, tagLabel } from "../../core/pki/asn1.ts";
import { toUpperHex } from "../../core/digest.ts";
import { KNOWN_OID_NAMES } from "./oid-names";

export interface Asn1Line {
  depth: number;
  tag: string;
  length: number;
  value?: string;
}

const MAX_VALUE_CHARS = 256;

function clip(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

function describeOid(oid: string): string {
  const name = KNOWN_OID_NAMES[oid];
  return name ? `${oid} (${name})` : oid;
}

function primitiveText(block: BaseBlock): string | undefined {
  if (block.idBlock.isConstructed) {
    return undefined;
  }
  if (block instanceof Asn1Boolean) {
    return block.valueBlock.value ? "TRUE" : "FALSE";
  }
  if (block instanceof Integer) {
    return block.toBigInt().toString(10);
  }
  if (block instanceof ObjectIdentifier) {
    return describeOid(block.valueBlock.toString());
  }
  if (block instanceof Null) {
    return undefined;
  }
  if (block instanceof UTCTime || block instanceof GeneralizedTime) {
    try {
      return readStrictTime(block).date.toISOString();
    } catch {
      return clip(asciiOf(block.valueBlock.valueHexView));
    }
  }
  if (block instanceof BitString) {
    const unused = block.valueBlock.unusedBits;
    const hex = toUpperHex(block.valueBlock.valueHexView);
    return clip(unused > 0 ? `${hex} (${unused} unused bits)` : hex);
  }
  if (block instanceof OctetString) {
    return clip(toUpperHex(block.valueBlock.valueHexView));
  }
  const text = stringOf(block);
  if (text !== undefined) {
    return clip(text);
  }
  const view = (block.valueBlock as { valueHexView?: Uint8Array }).valueHexView;
  return clip(toUpperHex(view ?? block.toBER(false)));
}

const DUMP_LIMITS = { maxLines: 200, maxDepth: 12 };

export function dumpAsn1(bytes: Uint8Array | ArrayBuffer): Asn1Line[] | undefined {
  let parsed: ReturnType<typeof fromBER>;
  try {
    parsed = fromBER(bytes);
  } catch {
    return undefined;
  }
  if (parsed.offset === -1 || parsed.result.error !== "") {
    return undefined;
  }
  const lines: Asn1Line[] = [];
  const visit = (block: BaseBlock, depth: number): void => {
    if (lines.length >= DUMP_LIMITS.maxLines) {
      return;
    }
    const value = primitiveText(block);
    const line: Asn1Line = { depth, tag: tagLabel(block), length: block.valueBlock.blockLength };
    if (value !== undefined) {
      line.value = value;
    }
    lines.push(line);
    if (depth < DUMP_LIMITS.maxDepth) {
      for (const child of children(block)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(parsed.result, 0);
  return lines;
}

export function blockHex(block: BaseBlock): string {
  return toUpperHex(block.toBER(false));
}

export function displayText(block: BaseBlock): string {
  return primitiveText(block) ?? blockHex(block);
}
