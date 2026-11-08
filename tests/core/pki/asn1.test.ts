import * as asn1 from "asn1js";
import { describe, expect, it } from "vitest";
import {
  Asn1TimeError,
  assertWellFormed,
  formatGeneralizedTime,
  readStrictTime,
} from "../../../src/core/pki/asn1.ts";

const bytes = (hex: string) => Uint8Array.fromHex(hex.replaceAll(" ", ""));

function decodedTime(tagNumber: 23 | 24, raw: string): asn1.BaseBlock {
  const block = new asn1.Primitive({
    idBlock: { tagClass: 1, tagNumber },
    valueHex: new TextEncoder().encode(raw).buffer,
  });
  return asn1.fromBER(block.toBER(false)).result;
}

describe("strict RFC 5280 times", () => {
  it("reads the type, the raw text and the date, pivoting UTCTime years at 50", () => {
    expect(readStrictTime(decodedTime(23, "491231235959Z"))).toEqual({
      type: "utcTime",
      raw: "491231235959Z",
      date: new Date("2049-12-31T23:59:59Z"),
    });
    expect(readStrictTime(decodedTime(23, "500101000000Z")).date).toEqual(
      new Date("1950-01-01T00:00:00Z")
    );
    expect(readStrictTime(decodedTime(24, "20991231235959Z"))).toEqual({
      type: "generalizedTime",
      raw: "20991231235959Z",
      date: new Date("2099-12-31T23:59:59Z"),
    });
  });

  it.each<[23 | 24, string]>([
    [23, "ZZZZZZZZZZZZZ"],
    [23, "260230000000Z"],
    [23, "2605080000Z"],
    [23, "260508000000+0800"],
    [24, "20260508000000.5Z"],
  ])("rejects the %s time %j instead of inventing a date", (tag, raw) => {
    expect(() => readStrictTime(decodedTime(tag, raw))).toThrow(Asn1TimeError);
  });
});

describe("assertWellFormed", () => {
  it.each([
    ["the indefinite length", "30 80 02 01 01 00 00"],
    ["a long-form length below 128", "04 81 03 01 02 03"],
    ["a low tag number in the high-tag-number form", "1f 02 01 05"],
    ["a constructed OCTET STRING", "24 03 04 01 aa"],
    ["an empty INTEGER", "30 02 02 00"],
    ["BER inside a SEQUENCE", "30 06 04 81 01 aa 05 00"],
  ])("rejects %s", (_, hex) => {
    const decoded = asn1.fromBER(bytes(hex));
    expect(decoded.offset).toBe(bytes(hex).byteLength);
    expect(() => assertWellFormed(decoded.result)).toThrow(/^Not DER: /);
  });

  it.each([
    ["an OCTET STRING holding BER", "04 03 04 81 00"],
    ["a BIT STRING holding a broken UTCTime", `03 15 00 17 12 ${"41 ".repeat(18)}`],
  ])("accepts %s", (_, hex) => {
    expect(() => assertWellFormed(asn1.fromBER(bytes(hex)).result)).not.toThrow();
  });
});

it("formatGeneralizedTime writes a fixed-width UTC text without milliseconds, sorting as time", () => {
  expect(formatGeneralizedTime(new Date("2026-01-03T11:50:07.999Z"))).toBe("20260103115007Z");
  expect(formatGeneralizedTime(new Date("2026-01-03T23:50:00+08:00"))).toBe("20260103155000Z");
  const texts = [
    "0999-12-31T23:59:59Z",
    "1999-12-31T23:59:59Z",
    "2026-01-04T00:00:00Z",
    "9999-12-31T23:59:59Z",
  ].map((iso) => formatGeneralizedTime(new Date(iso)));
  expect(texts.every((text) => /^\d{14}Z$/.test(text))).toBe(true);
  expect(texts.toSorted()).toEqual(texts);
});
