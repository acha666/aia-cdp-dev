import type { BaseBlock } from "asn1js";
import type { Extension } from "pkijs";
import {
  DerReader,
  INTEGER,
  OCTET_STRING,
  context,
  contents,
  expectTag,
  readBigInt,
  readOne,
  sequenceOf,
} from "./der.ts";

export const readExtensionSchema = (extension: Extension): BaseBlock =>
  readOne(extension.extnValue.valueBlock.valueHexView);

export interface PlainExtension {
  extnID: string;
  critical: boolean;
  value: Uint8Array;
}

export const plainExtension = (extension: Extension): PlainExtension => ({
  extnID: extension.extnID,
  critical: extension.critical,
  value: extension.extnValue.valueBlock.valueHexView,
});

export const readSubjectKeyId = (value: BaseBlock): Uint8Array =>
  contents(expectTag(value, OCTET_STRING));

export function readAuthorityKeyId(value: BaseBlock) {
  const aki = new DerReader(value);
  const keyIdentifier = aki.optional(context(0), contents);
  const names = aki.optional(context(1), (issuer) => sequenceOf(issuer, context(1)));
  const serial = aki.optional(context(2), contents);
  aki.end();
  if (names?.some(({ idBlock }) => idBlock.tagClass !== 3 || idBlock.tagNumber > 8)) {
    throw new Error("Invalid GeneralName");
  }
  return { keyIdentifier, names, serial };
}

export const MAX_CRL_NUMBER_OCTETS = 20;

export function readCrlNumber(value: BaseBlock): bigint {
  const integer = expectTag(value, INTEGER);
  if (contents(integer).length > MAX_CRL_NUMBER_OCTETS) {
    throw new Error(`CRL number longer than ${MAX_CRL_NUMBER_OCTETS} octets`);
  }
  const number = readBigInt(integer);
  if (number < 0n) {
    throw new Error("Negative CRL number");
  }
  return number;
}
