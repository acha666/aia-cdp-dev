import { fromBER, Integer, ObjectIdentifier } from "asn1js";
import type { BaseBlock } from "asn1js";
import { asciiOf, assertWellFormed, integerNumber } from "./asn1.ts";
import { encodeTlv } from "./pem.ts";

export interface Tag {
  readonly cls: number;
  readonly num: number;
  readonly name: string;
}

const universal = (num: number, name: string): Tag => ({ cls: 1, num, name });
export const context = (num: number): Tag => ({ cls: 3, num, name: `[${String(num)}]` });
export const INTEGER = universal(2, "INTEGER");
export const BIT_STRING = universal(3, "BIT STRING");
export const OCTET_STRING = universal(4, "OCTET STRING");
export const NULL = universal(5, "NULL");
export const OBJECT_IDENTIFIER = universal(6, "OBJECT IDENTIFIER");
export const ENUMERATED = universal(10, "ENUMERATED");
export const SEQUENCE = universal(16, "SEQUENCE");
export const IA5_STRING = universal(22, "IA5String");
export const GENERALIZED_TIME = universal(24, "GeneralizedTime");

export function hasTag(block: BaseBlock, tag: Tag): boolean {
  return block.idBlock.tagClass === tag.cls && block.idBlock.tagNumber === tag.num;
}

export function readOne(bytes: Uint8Array): BaseBlock {
  const parsed = fromBER(bytes);
  if (parsed.offset !== bytes.byteLength || parsed.result.error !== "") {
    throw new Error("Invalid ASN.1 value");
  }
  return parsed.result;
}

export function readDer(bytes: Uint8Array): BaseBlock {
  const block = readOne(bytes);
  assertWellFormed(block);
  return block;
}

export function expectTag(block: BaseBlock, tag: Tag): BaseBlock {
  if (!hasTag(block, tag)) {
    throw new Error(`Expected ${tag.name}`);
  }
  return block;
}

export function asUniversal(block: BaseBlock, tag: Tag): BaseBlock {
  return readOne(encodeTlv(tag.num, [contents(block)]));
}

export function contents(block: BaseBlock): Uint8Array {
  if (block.idBlock.isConstructed) {
    throw new Error("Expected a primitive ASN.1 element");
  }
  return block.valueBeforeDecodeView.subarray(
    block.idBlock.blockLength + block.lenBlock.blockLength
  );
}

export class DerReader {
  readonly #items: readonly BaseBlock[];
  #next = 0;

  constructor(block: BaseBlock, tag: Tag = SEQUENCE) {
    const value: unknown = (block.valueBlock as { value?: unknown }).value;
    if (!block.idBlock.isConstructed || !hasTag(block, tag) || !Array.isArray(value)) {
      throw new Error(`Expected a constructed ${tag.name}`);
    }
    this.#items = value as BaseBlock[];
  }

  optional(tag?: Tag): BaseBlock | undefined;
  optional<T>(tag: Tag, read: (block: BaseBlock) => T): T | undefined;
  optional<T>(tag?: Tag, read?: (block: BaseBlock) => T): BaseBlock | T | undefined {
    const item = this.#items[this.#next];
    if (item === undefined || (tag !== undefined && !hasTag(item, tag))) {
      return undefined;
    }
    this.#next++;
    return read ? read(item) : item;
  }

  read(tag: Tag): BaseBlock {
    const item = this.optional(tag);
    if (item === undefined) {
      throw new Error(`Missing ${tag.name}`);
    }
    return item;
  }

  any(): BaseBlock {
    const item = this.optional();
    if (item === undefined) {
      throw new Error("Missing ASN.1 element");
    }
    return item;
  }

  rest(min = 1): BaseBlock[] {
    const items = this.#items.slice(this.#next);
    if (items.length < min) {
      throw new Error("Too few elements");
    }
    this.#next = this.#items.length;
    return items;
  }

  end(): void {
    if (this.#next !== this.#items.length) {
      throw new Error("Unexpected ASN.1 element");
    }
  }
}

export function sequenceOf(block: BaseBlock, tag: Tag = SEQUENCE, min = 1): BaseBlock[] {
  return new DerReader(block, tag).rest(min);
}

export function explicit(block: BaseBlock, tag: Tag): BaseBlock {
  const wrapper = new DerReader(block, tag);
  const item = wrapper.any();
  wrapper.end();
  return item;
}

export function readBoolean(block: BaseBlock): boolean {
  const bytes = contents(block);
  if (bytes.length !== 1) {
    throw new Error("Invalid BOOLEAN");
  }
  return bytes[0] !== 0;
}

function integerOf(block: BaseBlock): Integer {
  const bytes = contents(block);
  if (bytes.length === 0) {
    throw new Error("Invalid INTEGER");
  }
  return new Integer({ valueHex: bytes });
}

export const readInteger = (block: BaseBlock): number => integerNumber(integerOf(block));

export const readBigInt = (block: BaseBlock): bigint => integerOf(block).toBigInt();

export function readBits(block: BaseBlock, names: readonly string[]): string[] {
  const [unused = 8, ...bytes] = contents(block);
  const padding = (bytes.at(-1) ?? 0) & ((1 << unused) - 1);
  if (unused > 7 || (bytes.length === 0 && unused !== 0) || padding !== 0) {
    throw new Error("Invalid BIT STRING");
  }
  const totalBits = bytes.length * 8 - unused;
  return names.filter(
    (_name, index) => index < totalBits && ((bytes[index >> 3] ?? 0) & (0x80 >> (index & 7))) !== 0
  );
}

export function readOid(block: BaseBlock): string {
  const bytes = contents(block);
  const oid = new ObjectIdentifier();
  if (bytes.length === 0 || oid.valueBlock.fromBER(bytes, 0, bytes.length) !== bytes.length) {
    throw new Error("Invalid OBJECT IDENTIFIER");
  }
  return oid.valueBlock.toString();
}

export const readAscii = (block: BaseBlock): string => asciiOf(contents(block));
