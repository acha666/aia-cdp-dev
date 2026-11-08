import { describe, expect, it } from "vitest";
import type { PkiKind, PkiParseReason } from "../../../src/core/pki/errors.ts";
import { derToPem, pemLength, splitPemBlocks, toDer } from "../../../src/core/pki/pem.ts";
import { fixture, fixtureText } from "../../fixtures/pki.ts";
import { pkiError } from "../../helpers/pki.ts";

const encode = (value: string) => new TextEncoder().encode(value);

const ROOT_DER = fixture("certs/root-ca.der");
const ROOT_PEM = fixtureText("certs/root-ca.pem");
const CRL_DER = fixture("crls/issuing-ca-1/full-01.der");

describe("toDer", () => {
  it("returns DER unchanged, and input that is neither DER nor PEM too", () => {
    expect(toDer(CRL_DER, "crl")).toBe(CRL_DER);
    const garbage = fixture("invalid/garbage.txt");
    expect(toDer(garbage, "crl")).toBe(garbage);
  });

  it("decodes PEM with CRLF, a UTF-8 BOM or explanatory text around the block", () => {
    expect(toDer(encode(ROOT_PEM), "certificate")).toEqual(ROOT_DER);
    expect(toDer(fixture("crls/issuing-ca-1/full-01.crlf.pem"), "crl")).toEqual(CRL_DER);
    const wrapped = `\uFEFFBag Attributes\n    subject=Zürich\n${ROOT_PEM}\ntrailing notes\n`;
    expect(toDer(encode(wrapped), "certificate")).toEqual(ROOT_DER);
    expect(toDer(encode(`0 is how this note starts\n${ROOT_PEM}`), "certificate")).toEqual(
      ROOT_DER
    );
  });

  it.each<[string, Uint8Array, PkiKind, PkiParseReason]>([
    ["a block labelled for the other kind", encode(ROOT_PEM), "crl", "pem_label"],
    [
      "two blocks instead of using the first",
      encode(`${ROOT_PEM}${fixtureText("certs/issuing-ca-1.pem")}`),
      "certificate",
      "pem_blocks",
    ],
    ["a block without its END line", fixture("invalid/truncated.pem"), "crl", "pem_blocks"],
    [
      "a body that is not base64",
      encode(ROOT_PEM.replace(/\n./, "\n*")),
      "certificate",
      "pem_base64",
    ],
  ])("rejects %s", (_, bytes, kind, reason) => {
    expect(() => toDer(bytes, kind)).toThrow(pkiError(kind, reason));
  });
});

describe("splitPemBlocks", () => {
  it("returns every complete block of the kind, in order, and skips other labels", () => {
    const bundle = [
      "chain exported for the AIA service\r\n",
      fixtureText("certs/root-ca.pem"),
      fixtureText("crls/root-ca/full-01.pem"),
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      fixtureText("certs/issuing-ca-1.pem").replaceAll("\n", "\r\n"),
      fixtureText("certs/issuing-ca-2.pem"),
    ].join("");
    const blocks = splitPemBlocks(bundle, "certificate");
    expect(blocks.map((block) => toDer(encode(block), "certificate"))).toEqual(
      ["root-ca", "issuing-ca-1", "issuing-ca-2"].map((name) => fixture(`certs/${name}.der`))
    );
    expect(splitPemBlocks(bundle, "crl").map((block) => toDer(encode(block), "crl"))).toEqual([
      fixture("crls/root-ca/full-01.der"),
    ]);
  });

  it("rejects a truncated bundle instead of importing part of it", () => {
    const truncated = `${ROOT_PEM}${fixtureText("certs/issuing-ca-1.pem").replace("-----END", "")}`;
    expect(() => splitPemBlocks(truncated, "certificate")).toThrow(
      pkiError("certificate", "pem_blocks")
    );
  });
});

describe("the download PEM format", () => {
  it("derToPem reproduces OpenSSL's PEM byte for byte", () => {
    for (const [name, kind] of [
      ["certs/root-ca", "certificate"],
      ["crls/issuing-ca-1/full-01", "crl"],
    ] as const) {
      const pem = encode(derToPem(fixture(`${name}.der`), kind));
      expect(pem, name).toEqual(fixture(`${name}.pem`));
    }
  });

  it("pemLength equals the length of derToPem's output", () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 7) % 256);
    const sizes = [...Array.from({ length: 96 }, (_, index) => index + 1), bytes.length];
    for (const kind of ["certificate", "crl"] as const) {
      expect(sizes.map((size) => pemLength(size, kind))).toEqual(
        sizes.map((size) => derToPem(bytes.subarray(0, size), kind).length)
      );
    }
  });
});
