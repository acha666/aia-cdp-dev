import { createHash } from "node:crypto";
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { CrlSummarySchema } from "../../src/core/catalog.ts";
import type { CertificateSummary } from "../../src/core/catalog.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import {
  authorityKeyId,
  buildCertificateSummary,
  buildCrlSummary,
  NEXT_CRL_PUBLISH_OID,
} from "../../src/core/summary.ts";
import { cert, fixture, manifest } from "../fixtures/pki.ts";
import { attribute, extension, nameOf, pkiError } from "../helpers/pki.ts";

// The catalog summaries: buildCertificateSummary on every fixture certificate, buildCrlSummary on
// every parsable fixture CRL.

const sha1 = (der: Uint8Array) => createHash("sha1").update(der).digest("hex");
const iso = (time: string | null) => (time === null ? null : new Date(time).toISOString());

async function summaryOf(name: string): Promise<CertificateSummary> {
  const der = fixture(cert(name).der);
  return buildCertificateSummary(parseCertificate(der), der);
}

describe("buildCertificateSummary", () => {
  it.each(manifest.certificates.map((c) => [c.name, c] as const))(
    "summarizes certs/%s.der in the catalog format",
    async (name, entry) => {
      const summary = await summaryOf(name);
      // The issuer side matches the issuing certificate's subject side.
      const issuer = await summaryOf(entry.issuer);
      expect(summary).toEqual({
        // Uppercase hex of the INTEGER content bytes, as `openssl x509 -serial` prints it.
        serialNumber: entry.serial,
        notBefore: iso(entry.notBefore),
        notAfter: iso(entry.notAfter),
        sha1: sha1(fixture(entry.der)),
        subjectCN: expect.any(String) as unknown,
        issuerCN: issuer.subjectCN,
        subjectKeyId:
          summary.subjectKeyId === null
            ? null
            : (expect.stringMatching(/^(?:[0-9a-f]{2})+$/) as unknown),
        authorityKeyId: summary.authorityKeyId === null ? null : issuer.subjectKeyId,
      });
    }
  );

  it("uses null where the key identifiers or the CN are absent", async () => {
    expect((await summaryOf("root-ca")).authorityKeyId).toBeNull();
    expect(await summaryOf("leaf-min")).toMatchObject({ subjectKeyId: null, authorityKeyId: null });
    const der = fixture(cert("leaf-full").der);
    const certificate = parseCertificate(der);
    certificate.subject = nameOf([
      attribute("2.5.4.10", new asn1.Utf8String({ value: "Example" })),
    ]);
    expect((await buildCertificateSummary(certificate, der)).subjectCN).toBeNull();
  });

  it("uses the first string CN from the library's parsed attributes", async () => {
    const der = fixture(cert("leaf-full").der);
    const certificate = parseCertificate(der);
    certificate.subject = nameOf(
      [attribute("2.5.4.3", new asn1.Integer({ value: 1 }))],
      [attribute("2.5.4.3", new asn1.Utf8String({ value: "First CN" }))],
      [attribute("2.5.4.3", new asn1.Utf8String({ value: "Later CN" }))]
    );
    expect((await buildCertificateSummary(certificate, der)).subjectCN).toBe("First CN");
  });

  it("keeps a leading 00 of the serial number", async () => {
    const der = fixture(cert("leaf-full").der);
    const certificate = parseCertificate(der);
    certificate.serialNumber = new asn1.Integer({
      valueHex: Uint8Array.of(0x00, 0x80, 0x0a).buffer,
    });
    expect((await buildCertificateSummary(certificate, der)).serialNumber).toBe("00800A");
  });

  it.each(["2.5.29.14", "2.5.29.35"])("rejects a malformed %s as extension_value", async (oid) => {
    const der = fixture(cert("issuing-ca-1").der);
    const certificate = parseCertificate(der);
    certificate.extensions = [
      ...(certificate.extensions ?? []).filter((ext) => ext.extnID !== oid),
      extension(oid, new asn1.Null()),
    ];
    await expect(buildCertificateSummary(certificate, der)).rejects.toThrow(
      pkiError("certificate", "extension_value")
    );
  });
});

describe("buildCrlSummary", () => {
  it.each(
    manifest.crls
      .filter((crl) => crl.expect !== "invalid_crl")
      .map((crl) => [crl.file, crl] as const)
  )("summarizes %s in the catalog format", async (file, crl) => {
    const der = fixture(file);
    const summary = await buildCrlSummary(parseCRL(der), der);
    expect(summary).toEqual({
      crlNumber: crl.crlNumber,
      baseCrlNumber: crl.baseCrlNumber,
      thisUpdate: iso(crl.thisUpdate),
      nextUpdate: iso(crl.nextUpdate),
      revokedCount: crl.revoked,
      sha1: sha1(der),
      nextPublish: iso(crl.nextPublish),
    });
    // The strict catalog schema takes it as is (no missing or extra keys, canonical formats).
    expect(CrlSummarySchema.parse(summary)).toEqual(summary);
  });

  // The time only informs the CRL status: a value that cannot be read is null, not a rejection.
  const time = new asn1.UTCTime({ valueDate: new Date("2026-01-10T12:00:00Z") });
  it.each([
    [
      "a GeneralizedTime",
      new asn1.GeneralizedTime({ valueDate: new Date("2050-06-01T12:00:00Z") }),
      "2050-06-01T12:00:00.000Z",
    ],
    ["an INTEGER", new asn1.Integer({ value: 1 }), null],
    ["a SEQUENCE holding a time", new asn1.Sequence({ value: [time] }), null],
  ])("reads a Next CRL Publish holding %s", async (_case, value, expected) => {
    const der = fixture("crls/issuing-ca-1/full-adcs.der");
    const crl = parseCRL(der);
    crl.crlExtensions!.extensions = [
      ...crl.crlExtensions!.extensions.filter((ext) => ext.extnID !== NEXT_CRL_PUBLISH_OID),
      extension(NEXT_CRL_PUBLISH_OID, value),
    ];
    expect((await buildCrlSummary(crl, der)).nextPublish).toBe(expected);
  });
});

describe("key identifiers and CRL numbers", () => {
  it("reads the AKI keyIdentifier as lowercase hex, undefined without one, and throws on a malformed one", () => {
    const issuer = [new pkijs.GeneralName({ type: 6, value: "https://ca.example/issuer" })];
    const serial = new asn1.Integer({ value: 17 });
    const aki = (keyIdentifier?: asn1.OctetString) =>
      extension(
        "2.5.29.35",
        new pkijs.AuthorityKeyIdentifier({
          ...(keyIdentifier === undefined ? {} : { keyIdentifier }),
          authorityCertIssuer: issuer,
          authorityCertSerialNumber: serial,
        }).toSchema()
      );
    const keyId = new asn1.OctetString({ valueHex: Uint8Array.of(0xab, 0xcd).buffer });
    expect(authorityKeyId("crl", [aki(keyId)])).toBe("abcd");
    expect(authorityKeyId("crl", [aki()])).toBeUndefined();
    expect(authorityKeyId("crl", undefined)).toBeUndefined();
    const malformed = pkiError("crl", "extension_value");
    expect(() => authorityKeyId("crl", [extension("2.5.29.35", new asn1.Null())])).toThrow(
      malformed
    );
    // The three fields in their order and nothing else (RFC 5280 §4.2.1.1).
    const tagged = (tagNumber: number, ...bytes: number[]) =>
      new asn1.Primitive({
        idBlock: { tagClass: 3, tagNumber },
        valueHex: Uint8Array.from(bytes).buffer,
      });
    for (const value of [
      [tagged(2, 17), tagged(0, 0xab, 0xcd)],
      [tagged(0, 0xab, 0xcd), new asn1.Null()],
    ]) {
      expect(() =>
        authorityKeyId("crl", [extension("2.5.29.35", new asn1.Sequence({ value }))])
      ).toThrow(malformed);
    }
  });

  it("reads CRL numbers exactly and rejects negative, oversized or wrong-tag values", async () => {
    const der = fixture("crls/issuing-ca-1/full-adcs.der");
    const summaryWith = (ext: pkijs.Extension) => {
      const crl = parseCRL(der);
      crl.crlExtensions!.extensions = [ext];
      return buildCrlSummary(crl, der);
    };
    for (const [oid, field] of [
      ["2.5.29.20", "crlNumber"],
      ["2.5.29.27", "baseCrlNumber"],
    ] as const) {
      const large = 2n ** 100n + 123n;
      expect((await summaryWith(extension(oid, asn1.Integer.fromBigInt(large))))[field]).toBe(
        large.toString()
      );
      for (const value of [
        new asn1.Integer({ value: -1 }),
        asn1.Integer.fromBigInt(2n ** 200n),
        new asn1.Enumerated({ value: 1 }),
      ]) {
        await expect(
          summaryWith(extension(oid, value)),
          `${oid} ${value.constructor.name}`
        ).rejects.toThrow(pkiError("crl", "extension_value"));
      }
    }
  });
});
