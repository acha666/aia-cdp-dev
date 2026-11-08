// The browser's X.509 display (src/web/x509): the extension decoders on the AD CS style fixtures,
// then on one value built in the test for each decoder the fixtures do not reach, values that are
// shown although an upload would reject them, values that are errors, names and algorithms. A
// decoded extension is compared as its rows, "label: value" (lines joined with " | ", tags with
// ", ", sections apart by "---"); how each value kind looks is in components.test.ts.
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toHex } from "../../src/core/digest.ts";
import { KEY_ALG_NAMES, SIGNATURE_ALG_NAMES } from "../../src/core/pki/constants.ts";
import { plainExtension } from "../../src/core/pki/extensions.ts";
import type { PlainExtension } from "../../src/core/pki/extensions.ts";
import { parseCertificate, parseCRL } from "../../src/core/pki/parsers.ts";
import { attribute, nameOf } from "../helpers/pki.ts";
import { der as fixtureDer } from "./helpers";
import { createAppI18n } from "@/i18n";
import { describeExtension, entryColumns } from "@/x509/extensions";
import type { ExtensionDisplay } from "@/x509/extensions";
import { formatAlgorithm, publicKeyInfo } from "@/x509/fields";
import { readName } from "@/x509/names";

const i18n = createAppI18n("en").global;

// Times show in the browser's time zone.
beforeEach(() => vi.stubEnv("TZ", "UTC"));

const certificate = (name: string) => parseCertificate(fixtureDer(`certs/${name}.der`));
const crl = (file: string) => parseCRL(fixtureDer(file));

/** The extension as rows, after asserting that it decoded. */
function rowsOf(display: ExtensionDisplay): string[] {
  expect([display.status, display.error]).toEqual(["parsed", undefined]);
  const text = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    const { hex, lines, tags } = (value ?? {}) as {
      hex?: string;
      lines?: string[];
      tags?: string[];
    };
    return hex ?? lines?.join(" | ") ?? tags?.join(", ") ?? "(empty)";
  };
  return (display.sections ?? []).flatMap((section, index) => [
    ...(index > 0 ? ["---"] : []),
    ...section.map((row) => `${row.label}: ${text(row.value)}`),
  ]);
}

const describe1 = (extension: PlainExtension) => describeExtension(extension, i18n);

/** The display of the extension `oid` among `extensions`. */
function byOid(extensions: pkijs.Extension[] | PlainExtension[] | undefined, oid: string) {
  const found = extensions?.find((extension) => extension.extnID === oid);
  expect(found, `extension ${oid} present`).toBeDefined();
  const plain = found instanceof pkijs.Extension ? plainExtension(found) : found!;
  return describe1(plain);
}

describe("the fixtures", () => {
  it("decodes every extension of certs/issuing-ca-1, the Microsoft ones included", () => {
    const issuing = certificate("issuing-ca-1");
    const displays = (issuing.extensions ?? []).map((extension) =>
      describe1(plainExtension(extension))
    );
    // The AD CS SubCA template shape, in order; basicConstraints and keyUsage are critical.
    expect(displays.map((display) => [display.name, display.status, display.critical])).toEqual([
      ["Subject Key Identifier", "parsed", false],
      ["Authority Key Identifier", "parsed", false],
      ["Basic Constraints", "parsed", true],
      ["Key Usage", "parsed", true],
      ["Authority Information Access", "parsed", false],
      ["CRL Distribution Points", "parsed", false],
      ["CA Version", "parsed", false],
      ["Certificate Template Name", "parsed", false],
    ]);
    expect(rowsOf(byOid(issuing.extensions, "1.3.6.1.4.1.311.21.1"))).toEqual([
      "CA certificate index: 0",
      "CA key index: 0",
    ]);
    expect(rowsOf(byOid(issuing.extensions, "1.3.6.1.4.1.311.20.2"))).toEqual([
      "Template name: SubCA",
    ]);
    expect(readName(issuing.subject).rfc4514).toBe(
      "CN=Example Issuing CA 01 (RSA),O=Example PKI,C=US"
    );
    expect(readName(issuing.issuer).rfc4514).toBe(
      "CN=Example Root CA (ECC P-384),O=Example PKI,C=US"
    );
    expect(readName(issuing.subject).rdns[0]?.[0]?.encoding).toBe("printableString");
    // Signed by root-ca: ECDSA, whose AlgorithmIdentifier has no parameters (RFC 5758 §3.2).
    expect(formatAlgorithm(issuing.signatureAlgorithm, SIGNATURE_ALG_NAMES, i18n)).toBe(
      "ecdsa-with-SHA384"
    );
    expect(publicKeyInfo(issuing.subjectPublicKeyInfo)).toEqual({ bits: 2048 });
  });

  it("decodes the extensions of crls/issuing-ca-1/full-adcs and delta-adcs", () => {
    const full = crl("crls/issuing-ca-1/full-adcs.der").crlExtensions?.extensions;
    // In the order of the file: openssl ca appends the CRL Number last.
    expect(full?.map((extension) => describe1(plainExtension(extension)).name)).toEqual([
      "Authority Key Identifier",
      "CA Version",
      "Next CRL Publish",
      "Freshest CRL",
      "CRL Self CDP",
      "CRL Number",
    ]);
    expect(rowsOf(byOid(full, "1.3.6.1.4.1.311.21.4"))).toEqual([
      "Next CRL publish: Jan 10, 2026 12:00:00 (UTC)",
    ]);
    expect(rowsOf(byOid(full, "2.5.29.20"))).toEqual(["CRL Number: 19"]);
    const delta = crl("crls/issuing-ca-1/delta-adcs.der").crlExtensions?.extensions;
    expect(byOid(delta, "2.5.29.27").critical).toBe(true);
    expect(rowsOf(byOid(delta, "2.5.29.27"))).toEqual(["Base CRL Number: 19"]);
  });

  it("decodes the entry extensions of crls/issuing-ca-1/full-03 and crls/issuing-ca-2/full-01", () => {
    const entries = (file: string) =>
      new Map(crl(file).entries.map((entry) => [toHex(entry.serial), entry.extensions]));
    const full03 = entries("crls/issuing-ca-1/full-03.der");
    const revoked = full03.get("2002")!;
    expect(rowsOf(byOid(revoked, "2.5.29.21"))).toEqual(["Reason: keyCompromise (1)"]);
    expect(entryColumns(revoked, i18n)).toMatchObject({ reason: "keyCompromise" });
    expect(entryColumns(revoked, i18n).invalidityDate).toMatch(/^\w{3} \d{2}, \d{4} .* \(UTC\)$/);
    expect(entryColumns(full03.get("2003")!, i18n).reason).toBe("superseded");
    const hold = entries("crls/issuing-ca-2/full-01.der").get("3000")!;
    expect(hold.map((extension) => rowsOf(describe1(extension)))).toEqual([
      ["Reason: certificateHold (6)"],
      ["Hold instruction: holdInstructionReject (1.2.840.10040.2.3)"],
    ]);
  });

  it("decodes the Extended Key Usage of certs/leaf-full", () => {
    const leaf = certificate("leaf-full");
    expect(rowsOf(byOid(leaf.extensions, "2.5.29.37"))).toEqual([
      "Purposes: serverAuth, clientAuth",
    ]);
  });
});

// Builders of the values below.
const seq = (...value: asn1.BaseBlock[]) => new asn1.Sequence({ value });
const utf8 = (value: string) => new asn1.Utf8String({ value });
const int = (value: number) => new asn1.Integer({ value });
const objectId = (value: string) => new asn1.ObjectIdentifier({ value });
const octets = (bytes: ArrayLike<number>) =>
  new asn1.OctetString({ valueHex: Uint8Array.from(bytes).buffer });
const bits = (byte: number, unusedBits: number) =>
  new asn1.BitString({ valueHex: Uint8Array.of(byte).buffer, unusedBits });
const context = (tagNumber: number, ...value: asn1.BaseBlock[]) =>
  new asn1.Constructed({ idBlock: { tagClass: 3, tagNumber }, value });
/** A context-specific primitive: an IMPLICIT [n] value's contents octets. */
const implicit = (tagNumber: number, ...bytes: number[]) =>
  new asn1.Primitive({
    idBlock: { tagClass: 3, tagNumber },
    valueHex: Uint8Array.from(bytes).buffer,
  });
const zeros = (count: number) => new Array<number>(count).fill(0);
/** An extension value given as its octets, for encodings asn1js would not write. */
const der = (...bytes: number[]) => ({ toBER: () => Uint8Array.from(bytes).buffer });
const uri = (value: string) => new pkijs.GeneralName({ type: 6, value });
const ip = (...bytes: number[]) => new pkijs.GeneralName({ type: 7, value: octets(bytes) });
/** A GeneralName inside a hand-built SEQUENCE (PKIjs types toSchema() as a union). */
const block = (name: pkijs.GeneralName) => name.toSchema() as asn1.BaseBlock;

const SCT_LOG_ID = Uint8Array.from({ length: 32 }, (_, index) => index);
const SCT_SIGNATURE = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02];
const SCT_TIME = new Date("2026-01-02T03:04:05.678Z");

/** A list of one v1 SCT (RFC 6962 §3.2–3.3) by hand: PKIjs's encoder pads it with zero octets. */
function sctList(missing = 0): asn1.OctetString {
  const ms = BigInt(SCT_TIME.getTime());
  const stamp = Array.from({ length: 8 }, (_, at) => Number((ms >> BigInt(56 - 8 * at)) & 0xffn));
  // v1, log id, timestamp, no extensions, sha256 / ecdsa, signature.
  const sct = [0, ...SCT_LOG_ID, ...stamp, 0, 0, 4, 3, 0, SCT_SIGNATURE.length, ...SCT_SIGNATURE];
  // `missing` octets cut from the end, with the SCT's own length left as it was.
  const kept = sct.slice(0, sct.length - missing);
  return octets([0, kept.length + 2, 0, sct.length, ...kept]);
}

const qcType = seq(objectId("0.4.0.1862.1.6.1"));
// PKIjs types the QCStatements constructor with QCStatement's parameters.
const qcStatements = new pkijs.QCStatements();
qcStatements.values = [
  new pkijs.QCStatement({ id: "0.4.0.1862.1.1" }),
  new pkijs.QCStatement({ id: "0.4.0.1862.1.6", type: qcType }),
];

const policies = (policyIdentifier: string, policyQualifiers?: pkijs.PolicyQualifierInfo[]) =>
  new pkijs.CertificatePolicies({
    certificatePolicies: [
      new pkijs.PolicyInformation({
        policyIdentifier,
        ...(policyQualifiers === undefined ? {} : { policyQualifiers }),
      }),
    ],
  }).toSchema();

const notice = new asn1.IA5String({ value: "not a UserNotice" });

/** What the tables below hold: an extension value, or its octets as `der` gives them. */
interface Encodable {
  toBER(): ArrayBuffer;
}

const plain = (oid: string, value: Encodable): PlainExtension => ({
  extnID: oid,
  critical: false,
  value: new Uint8Array(value.toBER()),
});

const DECODED: [type: string, oid: string, value: Encodable, rows: string[]][] = [
  [
    "authorityKeyIdentifier",
    "2.5.29.35",
    new pkijs.AuthorityKeyIdentifier({
      keyIdentifier: octets([0xab, 0xcd]),
      authorityCertIssuer: [uri("https://ca.example/issuer")],
      authorityCertSerialNumber: int(17),
    }).toSchema(),
    [
      "Key ID: ABCD",
      "Authority certificate issuer: URI: https://ca.example/issuer",
      "Authority certificate serial: 11",
    ],
  ],
  // Read from the contents octets: asn1js's valueDec is 0 from four contents octets on.
  [
    "basicConstraints",
    "2.5.29.19",
    new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 2 ** 40 }).toSchema(),
    ["CA: Yes", "Path Length: 1099511627776"],
  ],
  [
    "subjectAltName",
    "2.5.29.17",
    seq(
      context(0, objectId("1.3.6.1.4.1.311.20.2.3"), context(0, utf8("user@ad.example"))),
      block(new pkijs.GeneralName({ type: 8, value: "1.2.3.4" })),
      context(4, seq(new asn1.Set({ value: [seq(objectId("2.5.4.3"), utf8("Indirect, CA"))] }))),
      block(ip(192, 0, 2, 1)),
      block(ip(0x20, 1, 0x0d, 0xb8, ...zeros(11), 1))
    ),
    [
      "Names: userPrincipalName: user@ad.example | RID: 1.2.3.4 | DirName: CN=Indirect\\, CA | IP: 192.0.2.1 | IP: 2001:db8::1",
    ],
  ],
  // No text form: the DER is kept. PKIjs cannot read either.
  [
    "subjectAltName",
    "2.5.29.17",
    seq(context(3, seq()), context(5, context(1, utf8("party")))),
    ["Names: X.400: A3023000 | EDI Party: A509A1070C057061727479"],
  ],
  [
    "issuerAltName",
    "2.5.29.18",
    new pkijs.AltName({ altNames: [uri("https://ca.example")] }).toSchema(),
    ["Names: URI: https://ca.example"],
  ],
  [
    "nameConstraints",
    "2.5.29.30",
    // RFC 5280 DER (IMPLICIT [0] minimum, [1] maximum), built by hand: PKIjs tags them EXPLICIT.
    seq(
      context(
        0,
        seq(block(ip(192, 0, 2, 0, 255, 255, 255, 0))),
        seq(block(ip(0x20, 1, 0x0d, 0xb8, ...zeros(12), 255, 255, 255, 255, ...zeros(12))))
      ),
      context(
        1,
        seq(
          block(new pkijs.GeneralName({ type: 1, value: "nobody@example.com" })),
          implicit(0, 1),
          implicit(1, 3)
        )
      )
    ),
    [
      "Permitted: IP: 192.0.2.0/24 | IP: 2001:db8::/32",
      "Excluded: Email: nobody@example.com [1–3]",
    ],
  ],
  [
    "issuingDistributionPoint",
    "2.5.29.28",
    new pkijs.IssuingDistributionPoint({
      distributionPoint: [uri("http://crl.example/full.crl")],
    }).toSchema(),
    ["Full name: URI: http://crl.example/full.crl"],
  ],
  [
    "policyConstraints",
    "2.5.29.36",
    new pkijs.PolicyConstraints({ requireExplicitPolicy: 0, inhibitPolicyMapping: 2 }).toSchema(),
    ["Require explicit policy: 0", "Inhibit policy mapping: 2"],
  ],
  [
    "policyMappings",
    "2.5.29.33",
    seq(seq(objectId("1.2.3.4"), objectId("2.23.140.1.2.2"))),
    ["1.2.3.4: CA/Browser Forum OV (2.23.140.1.2.2)"],
  ],
  ["inhibitAnyPolicy", "2.5.29.54", int(1), ["Skip certificates: 1"]],
  [
    "privateKeyUsagePeriod",
    "2.5.29.16",
    new pkijs.PrivateKeyUsagePeriod({
      notBefore: new Date("2026-01-01T00:00:00Z"),
      notAfter: new Date("2027-01-01T00:00:00Z"),
    }).toSchema(),
    ["Not before: Jan 01, 2026 00:00:00 (UTC)", "Not after: Jan 01, 2027 00:00:00 (UTC)"],
  ],
  [
    "certificateIssuer",
    "2.5.29.29",
    new pkijs.GeneralNames({ names: [uri("https://other.example")] }).toSchema(),
    ["Names: URI: https://other.example"],
  ],
  [
    "expiredCertsOnCRL",
    "2.5.29.60",
    new asn1.GeneralizedTime({ valueDate: new Date("2020-06-01T00:00:00Z") }),
    ["Expired certificates since: Jun 01, 2020 00:00:00 (UTC)"],
  ],
  [
    "certificatePolicies",
    "2.5.29.32",
    policies("2.23.140.1.2.1", [
      new pkijs.PolicyQualifierInfo({
        policyQualifierId: "1.3.6.1.5.5.7.2.1",
        qualifier: new asn1.IA5String({ value: "https://ca.example/cps" }),
      }),
      new pkijs.PolicyQualifierInfo({
        policyQualifierId: "1.3.6.1.5.5.7.2.2",
        qualifier: seq(seq(utf8("Example Org"), seq(int(1), int(2))), utf8("Read the CPS")),
      }),
    ]),
    [
      "Policy: CA/Browser Forum DV (2.23.140.1.2.1)",
      "CPS: https://ca.example/cps",
      "User notice: Example Org (1, 2)\nRead the CPS",
    ],
  ],
  // A qualifier that does not decode keeps only its DER.
  [
    "certificatePolicies",
    "2.5.29.32",
    seq(seq(objectId("2.5.29.32.0"), seq(seq(objectId("1.3.6.1.5.5.7.2.2"), notice)))),
    ["Policy: anyPolicy (2.5.29.32.0)", "userNotice: 16106E6F74206120557365724E6F74696365"],
  ],
  [
    "msApplicationPolicies",
    "1.3.6.1.4.1.311.21.10",
    policies("1.3.6.1.5.5.7.3.1"),
    ["Policy: serverAuth (1.3.6.1.5.5.7.3.1)"],
  ],
  [
    "cRLDistributionPoints",
    "2.5.29.31",
    // RFC 5280 DER, built by hand: PKIjs writes [1] reasons without the unused-bits octet.
    seq(
      seq(
        context(0, context(0, block(uri("http://crl.example/a.crl")))),
        implicit(1, 0x05, 0x60),
        context(2, block(new pkijs.GeneralName({ type: 2, value: "crl-issuer.example" })))
      )
    ),
    [
      "Full name: URI: http://crl.example/a.crl",
      "Reasons: keyCompromise, cACompromise",
      "CRL issuer: DNS: crl-issuer.example",
    ],
  ],
  // nameRelativeToCRLIssuer [1] IMPLICIT RelativeDistinguishedName, which PKIjs cannot read.
  [
    "freshestCRL",
    "2.5.29.46",
    seq(seq(context(0, context(1, seq(objectId("2.5.4.3"), utf8("Delta")))))),
    ["Relative to CRL issuer: commonName=Delta"],
  ],
  [
    "subjectInfoAccess",
    "1.3.6.1.5.5.7.1.11",
    seq(seq(objectId("1.3.6.1.5.5.7.48.5"), block(uri("http://repo.example")))),
    ["CA Repository: URI: http://repo.example"],
  ],
  ["tlsFeature", "1.3.6.1.5.5.7.1.24", seq(int(5)), ["Features: status_request"]],
  ["ocspNoCheck", "1.3.6.1.5.5.7.48.1.5", new asn1.Null(), ["OCSP no-check: Yes"]],
  [
    "netscapeCertType",
    "2.16.840.1.113730.1.1",
    bits(0xa0, 5),
    ["Certificate types: sslClient, smime"],
  ],
  [
    "netscapeComment",
    "2.16.840.1.113730.1.13",
    new asn1.IA5String({ value: "Generated by test" }),
    ["Comment: Generated by test"],
  ],
  [
    "qcStatements",
    "1.3.6.1.5.5.7.1.3",
    qcStatements.toSchema(),
    ["QcCompliance (0.4.0.1862.1.1): ", "QcType (0.4.0.1862.1.6): 3009060704008E46010601"],
  ],
  [
    "signedCertificateTimestampList",
    "1.3.6.1.4.1.11129.2.4.2",
    sctList(),
    [
      "Log ID: 000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F",
      "Timestamp: Jan 02, 2026 03:04:05 (UTC)",
      "Signature: sha256/ecdsa",
    ],
  ],
  // dateOfBirth and countryOfCitizenship (RFC 3739 §3.2.2), and a title.
  [
    "subjectDirectoryAttributes",
    "2.5.29.9",
    new pkijs.SubjectDirectoryAttributes({
      attributes: [
        new pkijs.Attribute({
          type: "1.3.6.1.5.5.7.9.1",
          values: [new asn1.GeneralizedTime({ valueDate: new Date("1980-01-01T12:00:00Z") })],
        }),
        new pkijs.Attribute({
          type: "1.3.6.1.5.5.7.9.4",
          values: [
            new asn1.PrintableString({ value: "CA" }),
            new asn1.PrintableString({ value: "US" }),
          ],
        }),
        new pkijs.Attribute({ type: "2.5.4.12", values: [utf8("Operator")] }),
      ],
    }).toSchema(),
    [
      "1.3.6.1.5.5.7.9.1: 1980-01-01T12:00:00.000Z",
      "1.3.6.1.5.5.7.9.4: CA; US",
      "title (2.5.4.12): Operator",
    ],
  ],
  [
    "msCertificateTemplate",
    "1.3.6.1.4.1.311.21.7",
    seq(objectId("1.3.6.1.4.1.311.21.8.1.2.3"), int(100), int(4)),
    ["Template OID: 1.3.6.1.4.1.311.21.8.1.2.3", "Template version: 100.4"],
  ],
  [
    "msPreviousCaCertificateHash",
    "1.3.6.1.4.1.311.21.2",
    octets([1, 2, 3]),
    ["Previous CA certificate hash: 010203"],
  ],
  ["msCrlVirtualBase", "1.3.6.1.4.1.311.21.3", int(42), ["Virtual base CRL number: 42"]],
  [
    "msNtdsCaSecurity",
    "1.3.6.1.4.1.311.25.2",
    seq(
      context(
        0,
        objectId("1.3.6.1.4.1.311.25.2.1"),
        context(0, octets(new TextEncoder().encode("S-1-5-21-1-2-3-1105")))
      )
    ),
    ["Security identifier (SID): S-1-5-21-1-2-3-1105"],
  ],
];

describe("decoders on values built in the test", () => {
  it.each(DECODED)("decodes %s (%s)", (_type, oid, value, rows) => {
    const display = describe1(plain(oid, value));
    expect(rowsOf(display)).toEqual(rows);
    // A decoded extension needs no dump.
    expect(display.asn1).toBeUndefined();
  });

  it("gives unsupported and malformed extensions a generic ASN.1 dump", () => {
    const unsupported = describe1(
      plain(
        "1.2.3.4.5",
        seq(
          objectId("2.5.29.20"),
          utf8("hello"),
          // Exact: asn1js's valueDec is 0 from four contents octets on.
          asn1.Integer.fromBigInt(2n ** 100n + 123n),
          new asn1.Enumerated({ value: 2 ** 31 })
        )
      )
    );
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.asn1).toEqual([
      { depth: 0, tag: "SEQUENCE", length: 34 },
      { depth: 1, tag: "OBJECT IDENTIFIER", length: 3, value: "2.5.29.20 (CRL Number)" },
      { depth: 1, tag: "UTF8String", length: 5, value: "hello" },
      { depth: 1, tag: "INTEGER", length: 13, value: "1267650600228229401496703205499" },
      { depth: 1, tag: "ENUMERATED", length: 5, value: "2147483648" },
    ]);
    const malformed = describe1(plain("2.5.29.19", new asn1.Null()));
    expect(malformed).toMatchObject({ status: "error", hex: "0500" });
    expect(malformed.error).toEqual(expect.any(String));
    expect(malformed.asn1).toEqual([{ depth: 0, tag: "NULL", length: 0 }]);
    const undecodable = describe1({ extnID: "1.2.3", critical: false, value: Uint8Array.of(0xff) });
    expect(undecodable.asn1).toBeUndefined();
  });

  it.each([
    [
      "a CRL number outside upload limits",
      "2.5.29.20",
      asn1.Integer.fromBigInt(2n ** 200n),
      ["CRL Number: 1606938044258990275541962092341162602522202993782792835301376"],
    ],
    ["a BER IDP flag", "2.5.29.28", seq(implicit(1, 1)), ["Only user certificates: Yes"]],
    ["a BER long-form length", "2.5.29.19", der(0x30, 0x81, 0x00), ["CA: No"]],
    ["a BER true BOOLEAN", "2.5.29.19", der(0x30, 0x03, 0x01, 0x01, 0x01), ["CA: Yes"]],
    [
      "extra BasicConstraints fields",
      "2.5.29.19",
      seq(new asn1.Boolean({ value: true }), int(0), int(5)),
      ["CA: Yes", "Path Length: 0"],
    ],
    ["an empty SubjectAltName", "2.5.29.17", seq(), ["Names: "]],
    [
      "extra AccessDescription fields",
      "1.3.6.1.5.5.7.1.1",
      seq(seq(objectId("1.3.6.1.5.5.7.48.1"), block(uri("http://ocsp.example")), new asn1.Null())),
      ["OCSP: URI: http://ocsp.example"],
    ],
    [
      "extra QCStatement fields",
      "1.3.6.1.5.5.7.1.3",
      seq(seq(objectId("0.4.0.1862.1.1"), new asn1.Null(), new asn1.Null())),
      ["QcCompliance (0.4.0.1862.1.1): 0500"],
    ],
  ] as const)("displays %s without imposing upload validation", (_case, oid, value, rows) => {
    const display = describe1(plain(oid, value));
    expect(rowsOf(display)).toEqual(rows);
    expect(display.hex).toBe(toHex(value.toBER()).toUpperCase());
  });

  it.each([
    // PKIjs yields an SCT of 1970 with an empty log id from truncated TLS data.
    ["a truncated SCT list", "1.3.6.1.4.1.11129.2.4.2", octets([0, 2, 9, 9])],
    // PKIjs reads the short last SCT, its signature cut, as if the octets were there.
    ["an SCT longer than the list", "1.3.6.1.4.1.11129.2.4.2", sctList(2)],
    ["an empty SCT list (1..2^16-1)", "1.3.6.1.4.1.11129.2.4.2", octets([0, 0])],
    [
      "a pathLenConstraint beyond Number.MAX_SAFE_INTEGER",
      "2.5.29.19",
      seq(
        new asn1.Boolean({ value: true }),
        asn1.Integer.fromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
      ),
    ],
    // Do not silently display a prefix of an extension value.
    ["trailing bytes after the value", "2.5.29.19", der(0x30, 0x00, 0x05, 0x00)],
    // PKIjs writes and reads [1] reasons without the unused-bits octet: 0x60 is no such count.
    ["reasons without the unused-bits octet", "2.5.29.31", seq(seq(implicit(1, 0x60)))],
    [
      "an empty IMPLICIT INTEGER (GeneralSubtree minimum)",
      "2.5.29.30",
      seq(context(0, seq(block(uri("http://x")), implicit(0)))),
    ],
  ])("reports %s as an error, not as decoded rows", (_case, oid, value) => {
    const display = describe1(plain(oid, value));
    expect([display.status, display.sections]).toEqual(["error", undefined]);
    expect(display.asn1).toBeDefined();
  });
});

describe("names", () => {
  it("report encodings, keep multi-attribute RDNs, escape RFC 4514 specials and keep raw non-strings", () => {
    const name = readName(
      nameOf(
        [attribute("2.5.4.6", new asn1.PrintableString({ value: "CA" }))],
        [
          attribute("0.9.2342.19200300.100.1.25", new asn1.IA5String({ value: "example" })),
          attribute("2.5.4.10", new asn1.BmpString({ value: "Acme, Inc. " })),
        ],
        [attribute("2.5.4.5", new asn1.Integer({ value: 7 }))],
        [attribute("2.5.4.3", new asn1.TeletexString({ value: "#1 <Root>" }))],
        [attribute("2.5.4.11", new asn1.Utf8String({ value: " a\\b;c\\ " }))]
      )
    );
    expect(name.rdns.map((rdn) => rdn.map((attribute) => attribute.encoding))).toEqual([
      ["printableString"],
      ["ia5String", "bmpString"],
      ["unknown"],
      ["teletexString"],
      ["utf8String"],
    ]);
    expect(name.rdns[2]?.[0]).toMatchObject({ string: undefined, value: "#020107" });
    expect(name.rfc4514).toBe(
      "OU=\\ a\\\\b\\;c\\\\\\ ,CN=\\#1 \\<Root\\>,serialNumber=#020107,DC=example+O=Acme\\, Inc.\\ ,C=CA"
    );
  });

  it("label title, description, businessCategory and postalCode by their attribute names", () => {
    const name = nameOf(
      [attribute("2.5.4.17", utf8("8001"))],
      [attribute("2.5.4.15", utf8("Private Organization"))],
      [attribute("2.5.4.13", utf8("Test CA"))],
      [attribute("2.5.4.12", utf8("Operator"))],
      [attribute("2.5.4.3", utf8("Example"))]
    );
    expect(readName(name).rfc4514).toBe(
      "CN=Example,title=Operator,description=Test CA,businessCategory=Private Organization,postalCode=8001"
    );
  });
});

describe("algorithms and keys", () => {
  it("decodes NULL, named curve and RSASSA-PSS algorithm parameters", () => {
    // leaf-full: sha256WithRSAEncryption (NULL parameters) by issuing-ca-1 over a P-256 key.
    const leaf = certificate("leaf-full");
    expect(formatAlgorithm(leaf.signatureAlgorithm, SIGNATURE_ALG_NAMES, i18n)).toBe(
      "sha256WithRSAEncryption"
    );
    expect(formatAlgorithm(leaf.subjectPublicKeyInfo.algorithm, KEY_ALG_NAMES, i18n)).toBe(
      "ecPublicKey (P-256)"
    );
    expect(publicKeyInfo(leaf.subjectPublicKeyInfo)).toEqual({ curve: "P-256" });
    const pss = crl("crls/issuing-ca-1/full-pss.der");
    expect(formatAlgorithm(pss.signatureAlgorithm, SIGNATURE_ALG_NAMES, i18n)).toBe(
      "RSASSA-PSS (SHA-256, MGF1/SHA-256, salt 32)"
    );
  });

  it("names an unnamed curve and an unnamed algorithm by their OIDs", () => {
    const algorithm = (algorithmId: string, algorithmParams?: asn1.BaseBlock) =>
      new pkijs.AlgorithmIdentifier({ algorithmId, algorithmParams });
    expect(
      formatAlgorithm(algorithm("1.2.840.10045.2.1", objectId("1.3.6.1")), KEY_ALG_NAMES, i18n)
    ).toBe("ecPublicKey (1.3.6.1)");
    expect(formatAlgorithm(algorithm("1.2.3.4", octets([0xff])), SIGNATURE_ALG_NAMES, i18n)).toBe(
      "1.2.3.4"
    );
  });
});
