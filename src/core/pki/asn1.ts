import { BaseBlock, GeneralizedTime, UTCTime } from "asn1js";
import type { Integer } from "asn1js";

export type Asn1TimeType = "utcTime" | "generalizedTime";

export interface StrictTime {
  type: Asn1TimeType;
  raw: string;
  date: Date;
}

export class Asn1TimeError extends Error {
  override name = "Asn1TimeError";
}

export function asciiOf(view: Uint8Array): string {
  let text = "";
  for (const byte of view) {
    text += String.fromCharCode(byte);
  }
  return text;
}

export function stringOf(block: unknown): string | undefined {
  if (!(block instanceof BaseBlock) || block instanceof UTCTime) {
    return undefined;
  }
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function utcDate(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

export function readStrictTime(block: BaseBlock): StrictTime {
  if (!(block instanceof UTCTime)) {
    throw new Asn1TimeError("ASN.1 value is not a time");
  }
  const isUtc = !(block instanceof GeneralizedTime);
  const raw = asciiOf(block.valueBlock.valueHexView);
  const { year, month, day, hour, minute, second } = block;
  const date = utcDate(year, month - 1, day, hour, minute, second);
  let canonical: string | undefined;
  try {
    canonical = formatGeneralizedTime(date).slice(isUtc ? 2 : 0);
  } catch {}
  if (block.error !== "" || canonical !== raw) {
    throw new Asn1TimeError(`Invalid ASN.1 time: ${JSON.stringify(raw)}`);
  }
  return { type: isUtc ? "utcTime" : "generalizedTime", raw, date };
}

export function formatGeneralizedTime(date: Date): string {
  const iso = date.toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(iso);
  if (!match) {
    throw new RangeError(`No GeneralizedTime for ${iso}`);
  }
  return `${match.slice(1).join("")}Z`;
}

export function integerNumber(block: Integer): number {
  const value = block.toBigInt();
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > limit || value < -limit) {
    throw new RangeError("INTEGER is beyond Number.MAX_SAFE_INTEGER");
  }
  return Number(value);
}

export function children(block: BaseBlock): BaseBlock[] {
  const value: unknown = (block.valueBlock as { value?: unknown }).value;
  return Array.isArray(value)
    ? value.filter((item: unknown): item is BaseBlock => item instanceof BaseBlock)
    : [];
}

const UNIVERSAL = 1;
const BOOLEAN = 1;
const INTEGER = 2;
const BIT_STRING = 3;
const OBJECT_IDENTIFIER = 6;
const ENUMERATED = 10;
const SEQUENCE = 16;
const SET = 17;

const NON_EMPTY = new Set([BOOLEAN, INTEGER, BIT_STRING, OBJECT_IDENTIFIER, ENUMERATED]);

function derProblem(block: BaseBlock): string | undefined {
  const { idBlock, lenBlock } = block;
  if (idBlock.isHexOnly || idBlock.blockLength !== idBlock.toBER(true).byteLength) {
    return "tag not in its shortest form";
  }
  if (lenBlock.isIndefiniteForm) {
    return "indefinite length";
  }
  if (lenBlock.warnings.length > 0) {
    return "length not in its shortest form";
  }
  if (idBlock.tagClass === UNIVERSAL) {
    if (idBlock.isConstructed && idBlock.tagNumber !== SEQUENCE && idBlock.tagNumber !== SET) {
      return "constructed encoding of a primitive type";
    }
    if (!idBlock.isConstructed && NON_EMPTY.has(idBlock.tagNumber) && lenBlock.length === 0) {
      return "empty contents";
    }
  }
  return undefined;
}

export function assertWellFormed(root: BaseBlock, der = true): void {
  const stack: BaseBlock[] = [root];
  while (stack.length > 0) {
    const block = stack.pop();
    if (!block) {
      continue;
    }
    const isTime = block instanceof UTCTime || block instanceof GeneralizedTime;
    if (block.error) {
      const ErrorType = isTime ? Asn1TimeError : Error;
      throw new ErrorType(`ASN.1 decode error: ${block.error}`);
    }
    const problem = der ? derProblem(block) : undefined;
    if (problem !== undefined) {
      throw new Error(`Not DER: ${problem} (${tagLabel(block)})`);
    }
    if (der && isTime) {
      readStrictTime(block);
    }
    if (block.idBlock.isConstructed) {
      for (const child of children(block)) {
        stack.push(child);
      }
    }
  }
}

export function tagLabel(block: BaseBlock): string {
  const { tagClass, tagNumber, isConstructed } = block.idBlock;
  switch (tagClass) {
    case 1: {
      const name = (block.constructor as typeof BaseBlock).NAME;
      return name === "PRIMITIVE" || name === "CONSTRUCTED" ? `UNIVERSAL ${tagNumber}` : name;
    }
    case 2:
      return `APPLICATION ${tagNumber}`;
    case 3:
      return isConstructed ? `[${tagNumber}]` : `[${tagNumber}] PRIMITIVE`;
    default:
      return `PRIVATE ${tagNumber}`;
  }
}
