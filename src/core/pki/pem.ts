/**
 * PEM encoding and decoding, and minimal DER TLV handling.
 *
 * @packageDocumentation
 */
import { PkiParseError } from "./errors.ts";
import type { PkiKind } from "./errors.ts";

const PEM_LABELS: Record<PkiKind, string> = { certificate: "CERTIFICATE", crl: "X509 CRL" };

function boundaryLines(kind: PkiKind): [begin: string, end: string] {
  const label = PEM_LABELS[kind];
  return [`-----BEGIN ${label}-----`, `-----END ${label}-----`];
}

/** Encodes DER as PEM with 64-character lines and a trailing newline. */
export function derToPem(bytes: Uint8Array, kind: PkiKind): string {
  const lines = bytes.toBase64().match(/.{1,64}/g) ?? [];
  const [begin, end] = boundaryLines(kind);
  return `${begin}\n${lines.join("\n")}\n${end}\n`;
}

/** The exact length of {@link derToPem} output, for Content-Length without encoding. */
export function pemLength(derSize: number, kind: PkiKind): number {
  const base64 = 4 * Math.ceil(derSize / 3);
  const [begin, end] = boundaryLines(kind);
  return begin.length + end.length + base64 + Math.ceil(base64 / 64) + 2;
}

const BOUNDARY = /-----(BEGIN|END) ([^\r\n]*?)-----/g;

interface Boundary {
  type: "BEGIN" | "END";
  label: string;
  start: number;
  end: number;
}

function boundariesOf(text: string): Boundary[] {
  return Array.from(text.matchAll(BOUNDARY), (match) => ({
    type: match[1] === "BEGIN" ? "BEGIN" : "END",
    label: match[2] ?? "",
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Offsets of one DER element: its start, its contents and its end. */
export interface Tlv {
  tag: number;
  start: number;
  contents: number;
  end: number;
}

/** Reads one definite-length DER TLV within `limit`, or returns `undefined`. */
export function readTlv(der: Uint8Array, start: number, limit: number): Tlv | undefined {
  const tag = der[start];
  const first = der[start + 1];
  if (tag === undefined || first === undefined || (tag & 0x1f) === 0x1f || first === 0x80) {
    return undefined;
  }
  let contents = start + 2;
  let length = first;
  if (first > 0x80) {
    const count = first & 0x7f;
    if (count > 4 || contents + count > limit || der[contents] === 0) {
      return undefined;
    }
    length = 0;
    for (const octet of der.subarray(contents, contents + count)) {
      length = length * 256 + octet;
    }
    if (length < 0x80) {
      return undefined;
    }
    contents += count;
  }
  const end = contents + length;
  return end <= limit ? { tag, start, contents, end } : undefined;
}

/** Encodes a TLV from a one-byte tag and its contents. */
export function encodeTlv(tag: number, parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    octets.unshift(rest & 0xff);
  }
  const header = length < 0x80 ? [tag, length] : [tag, 0x80 | octets.length, ...octets];
  const der = new Uint8Array(header.length + length);
  der.set(header);
  let at = header.length;
  for (const part of parts) {
    der.set(part, at);
    at += part.byteLength;
  }
  return der;
}

export function isDerSequence(bytes: Uint8Array): boolean {
  const tlv = readTlv(bytes, 0, bytes.length);
  return tlv?.tag === 0x30 && tlv.end === bytes.length;
}

/**
 * Accepts DER, or exactly one PEM block with the label for `kind`. Input that is neither is
 * returned as is, so the DER parser reports what is wrong with it.
 *
 * @throws {@link PkiParseError} for a bad PEM block.
 */
export function toDer(bytes: Uint8Array, kind: PkiKind): Uint8Array {
  if (isDerSequence(bytes)) {
    return bytes;
  }
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  if (!text.includes("-----BEGIN ")) {
    return bytes;
  }
  const label = PEM_LABELS[kind];
  const boundaries = boundariesOf(text);
  const other = boundaries.find((boundary) => boundary.label !== label);
  if (other) {
    throw new PkiParseError(
      kind,
      "pem_label",
      `Unexpected PEM label ${JSON.stringify(other.label)}`
    );
  }
  const [begin, end] = boundaries;
  if (boundaries.length !== 2 || begin?.type !== "BEGIN" || end?.type !== "END") {
    throw new PkiParseError(kind, "pem_blocks", `Expected exactly one complete ${label} PEM block`);
  }
  try {
    return Uint8Array.fromBase64(text.slice(begin.end, end.start), { lastChunkHandling: "strict" });
  } catch (error) {
    throw new PkiParseError(kind, "pem_base64", `Invalid base64 in the ${label} PEM block`, {
      cause: error,
    });
  }
}

/** Splits text into its PEM blocks of `kind`, ignoring blocks with other labels. */
export function splitPemBlocks(text: string, kind: PkiKind): string[] {
  const label = PEM_LABELS[kind];
  const blocks: string[] = [];
  let open: Boundary | undefined;
  for (const boundary of boundariesOf(text)) {
    if (boundary.label !== label) {
      continue;
    }
    if (boundary.type === "BEGIN" && open === undefined) {
      open = boundary;
    } else if (boundary.type === "END" && open !== undefined) {
      blocks.push(`${text.slice(open.start, boundary.end)}\n`);
      open = undefined;
    } else {
      throw new PkiParseError(kind, "pem_blocks", `Unbalanced ${label} PEM boundaries`);
    }
  }
  if (open !== undefined) {
    throw new PkiParseError(kind, "pem_blocks", `${label} PEM block without an END line`);
  }
  return blocks;
}
