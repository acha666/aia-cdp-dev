import type { webcrypto } from "node:crypto";
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it, vi } from "vitest";
import { SIGNATURE_ALG_NAMES } from "../../../src/core/pki/constants.ts";
import { parseCertificate, parseCRL } from "../../../src/core/pki/parsers.ts";
import { verifyCrlSignature } from "../../../src/core/pki/verify.ts";
import { cert, fixture } from "../../fixtures/pki.ts";

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const ROOT_FULL_01 = "crls/root-ca/full-01.der";

const crlOf = (file: string) => parseCRL(fixture(file));
const spkiOf = (name: string) => parseCertificate(fixture(cert(name).der)).subjectPublicKeyInfo;
const engine = pkijs.getCrypto(true);

const cryptoSpy = () => vi.spyOn(engine, "verifyWithPublicKey");

const algorithmId = (id: string, params?: asn1.BaseBlock) =>
  new pkijs.AlgorithmIdentifier({
    algorithmId: id,
    ...(params === undefined ? {} : { algorithmParams: params }),
  });

describe("allow-list", () => {
  type Hash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
  const ALLOWED: [oid: string, scheme: "pkcs1" | "pss" | "ecdsa", hash: Hash, curve?: string][] = [
    ["1.2.840.113549.1.1.5", "pkcs1", "SHA-1"],
    ["1.2.840.113549.1.1.11", "pkcs1", "SHA-256"],
    ["1.2.840.113549.1.1.12", "pkcs1", "SHA-384"],
    ["1.2.840.113549.1.1.13", "pkcs1", "SHA-512"],
    ["1.2.840.113549.1.1.10", "pss", "SHA-256"],
    ["1.2.840.10045.4.1", "ecdsa", "SHA-1", "P-256"],
    ["1.2.840.10045.4.3.2", "ecdsa", "SHA-256", "P-256"],
    ["1.2.840.10045.4.3.3", "ecdsa", "SHA-384", "P-384"],
    ["1.2.840.10045.4.3.4", "ecdsa", "SHA-512", "P-521"],
  ];

  async function resigned(
    signatureAlgorithm: pkijs.AlgorithmIdentifier,
    sign: (tbs: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>
  ): Promise<Uint8Array> {
    const crl = crlOf(FULL_01);
    crl.signature = signatureAlgorithm;
    crl.signatureAlgorithm = signatureAlgorithm;
    const schema = crl.toSchema(true) as asn1.Sequence;
    const tbs = new Uint8Array((schema.valueBlock.value[0] as asn1.Sequence).toBER(false));
    crl.tbsView = tbs;
    crl.signatureValue = new asn1.BitString({ valueHex: await sign(tbs) });
    return new Uint8Array((crl.toSchema() as asn1.Sequence).toBER(false));
  }

  async function spkiFrom(key: webcrypto.CryptoKey): Promise<pkijs.PublicKeyInfo> {
    const der = await crypto.subtle.exportKey("spki", key);
    return new pkijs.PublicKeyInfo({ schema: asn1.fromBER(der).result });
  }

  const rsa = crypto.subtle
    .generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: Uint8Array.of(1, 0, 1),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )
    .then(async ({ privateKey, publicKey }) => ({
      pkcs8: await crypto.subtle.exportKey("pkcs8", privateKey),
      spki: await spkiFrom(publicKey),
    }));

  it.each(ALLOWED)(
    "verifies %s (%s %s %s) and rejects it tampered",
    async (oid, scheme, hash, curve) => {
      let der: Uint8Array;
      let spki: pkijs.PublicKeyInfo;
      if (scheme === "ecdsa") {
        const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve! }, true, [
          "sign",
          "verify",
        ]);
        spki = await spkiFrom(keys.publicKey);
        der = await resigned(algorithmId(oid), async (tbs) =>
          pkijs.createCMSECDSASignature(
            await crypto.subtle.sign({ name: "ECDSA", hash }, keys.privateKey, tbs)
          )
        );
      } else {
        const pss = scheme === "pss";
        const name = pss ? "RSA-PSS" : "RSASSA-PKCS1-v1_5";
        const { pkcs8 } = await rsa;
        spki = (await rsa).spki;
        const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name, hash }, false, ["sign"]);
        const sha256 = algorithmId("2.16.840.1.101.3.4.2.1", new asn1.Null());
        const params = pss
          ? new pkijs.RSASSAPSSParams({
              hashAlgorithm: sha256,
              maskGenAlgorithm: algorithmId("1.2.840.113549.1.1.8", sha256.toSchema()),
              saltLength: 32,
            }).toSchema()
          : new asn1.Null();
        der = await resigned(algorithmId(oid, params), (tbs) =>
          crypto.subtle.sign(pss ? { name, saltLength: 32 } : { name }, key, tbs)
        );
      }
      expect(await verifyCrlSignature(parseCRL(der), spki)).toEqual({ ok: true });

      const tampered = parseCRL(der);
      const bytes = tampered.tbsView;
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      expect(await verifyCrlSignature(tampered, spki)).toMatchObject({
        ok: false,
        error: "invalid_signature",
        details: { algorithm: SIGNATURE_ALG_NAMES[oid] },
      });
    }
  );

  it.each([
    ["an Ed25519 CRL", crlOf("crls/ed25519-ca/full-01.der"), spkiOf("ed25519-ca")],
    [
      "an issuer key on brainpoolP384r1",
      crlOf(ROOT_FULL_01),
      new pkijs.PublicKeyInfo({
        algorithm: algorithmId(
          "1.2.840.10045.2.1",
          new asn1.ObjectIdentifier({ value: "1.3.36.3.3.2.8.1.1.11" })
        ),
        subjectPublicKey: spkiOf("root-ca").subjectPublicKey,
      }),
    ],
  ])("refuses %s as unsupported_algorithm without cryptography", async (_case, crl, spki) => {
    const spy = cryptoSpy();
    expect(await verifyCrlSignature(crl, spki)).toMatchObject({
      ok: false,
      error: "unsupported_algorithm",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("refusals before the cryptography", () => {
  it.each([
    ["an RSA signature with an EC key", FULL_01, "root-ca"],
    ["an ECDSA signature with an RSA key", ROOT_FULL_01, "issuing-ca-1"],
  ])("rejects %s as invalid_signature", async (_case, file, ca) => {
    const spy = cryptoSpy();
    expect(await verifyCrlSignature(crlOf(file), spkiOf(ca))).toMatchObject({
      ok: false,
      error: "invalid_signature",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a signature BIT STRING with unused bits", async () => {
    const crl = crlOf(FULL_01);
    crl.signatureValue = new asn1.BitString({
      valueHex: crl.signatureValue.valueBlock.valueHexView.slice().buffer,
      unusedBits: 1,
    });
    expect(await verifyCrlSignature(crl, spkiOf("issuing-ca-1"))).toMatchObject({
      ok: false,
      error: "invalid_signature",
    });
  });

  const variants = (): [string, Uint8Array][] => {
    const bytes = crlOf(ROOT_FULL_01).signatureValue.valueBlock.valueHexView;
    const [r, s] = (asn1.fromBER(bytes).result as asn1.Sequence).valueBlock.value.map((part) => [
      ...(part as asn1.Integer).valueBlock.valueHexView,
    ]);
    const nonDer = r![0] === 0 ? r!.slice(1) : [0, ...r!];
    const body = [0x02, nonDer.length, ...nonDer, 0x02, s!.length, ...s!];
    const enumerated = [0x0a, r!.length, ...r!, 0x0a, s!.length, ...s!];
    return [
      ["a trailing byte after the SEQUENCE", Uint8Array.from([...bytes, 0])],
      ["an r not in DER", Uint8Array.from([0x30, body.length, ...body])],
      ["ENUMERATED in place of INTEGER", Uint8Array.from([0x30, enumerated.length, ...enumerated])],
    ];
  };

  it.each(variants())("rejects an ECDSA signature with %s", async (_case, value) => {
    const crl = crlOf(ROOT_FULL_01);
    crl.signatureValue = new asn1.BitString({ valueHex: value.slice().buffer });
    const spki = spkiOf("root-ca");
    expect(
      await engine.verifyWithPublicKey(
        crl.tbsView,
        crl.signatureValue,
        spki,
        crl.signatureAlgorithm
      )
    ).toBe(true);
    const spy = cryptoSpy();
    expect(await verifyCrlSignature(crl, spki)).toMatchObject({
      ok: false,
      error: "invalid_signature",
      details: { algorithm: "ecdsa-with-SHA384" },
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
