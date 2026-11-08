import * as asn1 from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";
import { checkCrlPolicy, checkEntryPolicy } from "../../../src/core/pki/crl-policy.ts";
import { plainExtension } from "../../../src/core/pki/extensions.ts";
import { parseCRL } from "../../../src/core/pki/parsers.ts";
import type { ReceivedCrl } from "../../../src/core/pki/parsers.ts";
import { cert, crlEntry, fixture, NOW } from "../../fixtures/pki.ts";
import { extension } from "../../helpers/pki.ts";

const FULL_01 = "crls/issuing-ca-1/full-01.der";
const ISSUING_DISTRIBUTION_POINT_OID = "2.5.29.28";
const CERTIFICATE_ISSUER_OID = "2.5.29.29";
const UNKNOWN = "1.3.6.1.4.1.32473.99";

const crlOf = (file: string) => parseCRL(fixture(file));
const at = (iso: string, deltaMs = 0) => new Date(Date.parse(iso) + deltaMs);
const OK = { ok: true, expired: false };

function withCrlExtension(crl: ReceivedCrl, added: pkijs.Extension) {
  crl.crlExtensions = new pkijs.Extensions({
    extensions: [...(crl.crlExtensions?.extensions ?? []), added],
  });
  return crl;
}

function withEntryExtension(added: pkijs.Extension) {
  const crl = crlOf(FULL_01);
  const entry = crl.entries[0]!;
  entry.extensions.push(plainExtension(added));
  return crl;
}

describe("checkCrlPolicy", () => {
  it("accepts thisUpdate exactly five minutes ahead and rejects one ms more", () => {
    const { thisUpdate } = crlEntry(FULL_01);
    expect(checkCrlPolicy(crlOf(FULL_01), at(thisUpdate, -5 * 60_000))).toEqual(OK);
    expect(checkCrlPolicy(crlOf(FULL_01), at(thisUpdate, -5 * 60_000 - 1))).toEqual({
      ok: false,
      error: "not_yet_valid",
      details: { thisUpdate: new Date(thisUpdate).toISOString() },
      detail: expect.any(String) as unknown,
    });
  });

  it("accepts a CRL past its nextUpdate as expired, and one without nextUpdate never", () => {
    const { nextUpdate } = crlEntry(FULL_01);
    expect(checkCrlPolicy(crlOf(FULL_01), at(nextUpdate!))).toEqual(OK);
    expect(checkCrlPolicy(crlOf(FULL_01), at(nextUpdate!, 1))).toEqual({ ok: true, expired: true });
    const crl = crlOf("crls/issuing-ca-1/full-no-next-update.der");
    expect(checkCrlPolicy(crl, new Date("2099-01-01T00:00:00Z"))).toEqual(OK);
  });

  it("accepts any other extension, critical or not", () => {
    const crl = crlOf("crls/issuing-ca-1/full-unknown-critical.der");
    withCrlExtension(crl, extension(UNKNOWN, new asn1.Sequence(), true));
    for (const ext of crl.crlExtensions!.extensions) {
      ext.critical = true;
    }
    expect(checkCrlPolicy(crl, NOW)).toEqual(OK);
  });

  it("accepts an IDP naming only the distribution point and refuses any other field", () => {
    expect(checkCrlPolicy(crlOf("crls/issuing-ca-1/full-idp-dp-only.der"), NOW)).toEqual(OK);
    const caCerts = new asn1.Sequence({
      value: [
        new asn1.Primitive({
          idBlock: { tagClass: 3, tagNumber: 2 },
          valueHex: Uint8Array.of(0xff).buffer,
        }),
      ],
    });
    const crl = withCrlExtension(
      crlOf(FULL_01),
      extension(ISSUING_DISTRIBUTION_POINT_OID, caCerts)
    );
    expect(checkCrlPolicy(crl, NOW)).toMatchObject({ ok: false, error: "scoped_crl_unsupported" });
    const notSequence = extension(ISSUING_DISTRIBUTION_POINT_OID, new asn1.Integer({ value: 1 }));
    expect(checkCrlPolicy(withCrlExtension(crlOf(FULL_01), notSequence), NOW)).toMatchObject({
      ok: false,
      error: "invalid_crl",
      details: { reason: "extension_value" },
    });
  });
});

describe("checkEntryPolicy", () => {
  const value = new asn1.Utf8String({ value: "x" });

  it("accepts any other entry extension, critical or not", () => {
    const crl = withEntryExtension(extension(UNKNOWN, value, true));
    for (const ext of crl.entries[0]!.extensions) {
      ext.critical = true;
    }
    expect(checkEntryPolicy(crl)).toEqual({ ok: true });
  });

  it("rejects a certificateIssuer entry (an indirect CRL), also when not critical", () => {
    const names = new pkijs.GeneralNames({
      names: [new pkijs.GeneralName({ type: 6, value: "http://other.example.test/" })],
    });
    const crl = withEntryExtension(extension(CERTIFICATE_ISSUER_OID, names.toSchema()));
    expect(checkEntryPolicy(crl)).toMatchObject({
      ok: false,
      error: "scoped_crl_unsupported",
      details: { oid: CERTIFICATE_ISSUER_OID, serialNumber: cert("leaf-revoked").serial },
    });
  });
});
