import type { webcrypto } from "node:crypto";
import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { toDigestInput } from "../../src/core/digest.ts";
import type { ObjectStore } from "../../src/core/store.ts";
import { NOW } from "../fixtures/pki.ts";
import { attribute, extension, nameOf } from "./pki.ts";
import { applyOver, importOrThrow } from "./publish.ts";

const HOUR = 3_600_000;

export interface GeneratedCa {
  der: Uint8Array;
  keyId: Uint8Array;
  commonName: string;
  privateKey: webcrypto.CryptoKey;
}

const commonNameOf = (commonName: string) =>
  nameOf([attribute("2.5.4.3", new asn1.Utf8String({ value: commonName }))]);

const utcTime = (offsetMs: number) =>
  new pkijs.Time({ type: 0, value: new Date(NOW.getTime() + offsetMs) });

/** Generates a fresh CA with Web Crypto, for cases the fixtures do not cover. */
export async function generateCa(commonName = "Generated Test CA"): Promise<GeneratedCa> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1.Integer({ value: 1 });
  certificate.issuer = commonNameOf(commonName);
  certificate.subject = commonNameOf(commonName);
  certificate.notBefore = utcTime(-24 * HOUR);
  certificate.notAfter = utcTime(365 * 24 * HOUR);
  await certificate.subjectPublicKeyInfo.importKey(publicKey);
  const keyId = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-1",
      toDigestInput(certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)
    )
  );
  certificate.extensions = [
    extension("2.5.29.19", new pkijs.BasicConstraints({ cA: true }).toSchema(), true),
    extension("2.5.29.14", new asn1.OctetString({ valueHex: keyId })),
  ];
  await certificate.sign(privateKey, "SHA-256");
  const der = new Uint8Array(certificate.toSchema(true).toBER(false));
  return { der, keyId, commonName, privateKey };
}

export interface CrlOptions {
  crlNumber?: bigint;
  thisUpdateMs?: number;
  revoked?: number;
}

export async function signCrl(
  ca: GeneratedCa,
  { crlNumber = 1n, thisUpdateMs = -HOUR, revoked = 0 }: CrlOptions = {}
): Promise<Uint8Array> {
  const crl = new pkijs.CertificateRevocationList();
  crl.version = 1;
  crl.issuer = commonNameOf(ca.commonName);
  crl.thisUpdate = utcTime(thisUpdateMs);
  crl.nextUpdate = utcTime(7 * 24 * HOUR);
  if (revoked > 0) {
    const revocationDate = utcTime(-2 * HOUR);
    const reasonCode = extension("2.5.29.21", new asn1.Enumerated({ value: 1 }));
    crl.revokedCertificates = Array.from(
      { length: revoked },
      (_, index) =>
        new pkijs.RevokedCertificate({
          userCertificate: asn1.Integer.fromBigInt(2n ** 64n + BigInt(index)),
          revocationDate,
          crlEntryExtensions: new pkijs.Extensions({ extensions: [reasonCode] }),
        })
    );
  }
  crl.crlExtensions = new pkijs.Extensions({
    extensions: [
      extension(
        "2.5.29.35",
        new pkijs.AuthorityKeyIdentifier({
          keyIdentifier: new asn1.OctetString({ valueHex: ca.keyId }),
        }).toSchema()
      ),
      extension("2.5.29.20", asn1.Integer.fromBigInt(crlNumber)),
    ],
  });
  await crl.sign(ca.privateKey, "SHA-256");
  return new Uint8Array((crl.toSchema(true) as asn1.Sequence).toBER(false));
}

export async function setupGeneratedCa(store: ObjectStore, ca: GeneratedCa): Promise<string> {
  const issuer = await importOrThrow(store, ca.der);
  const targetId = crypto.randomUUID();
  const config = {
    version: 1,
    certificates: {},
    targets: { [targetId]: { issuer, kind: "full", label: ca.commonName } },
    paths: { "/crl/generated-ca.crl": { target: targetId } },
  };
  const applied = await applyOver(store, config);
  if ("error" in applied) {
    throw new Error(`applyConfig: ${JSON.stringify(applied)}`);
  }
  return targetId;
}
