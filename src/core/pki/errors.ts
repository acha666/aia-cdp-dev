export type PkiKind = "certificate" | "crl";

export const PKI_PARSE_REASONS = [
  "der",
  "trailing_bytes",
  "time",
  "structure",
  "extension_value",
  "pem_label",
  "pem_blocks",
  "pem_base64",
  "signature_algorithm_mismatch",
] as const;

export type PkiParseReason = (typeof PKI_PARSE_REASONS)[number];

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PkiParseError extends Error {
  override name = "PkiParseError";
  readonly kind: PkiKind;
  readonly reason: PkiParseReason;

  constructor(kind: PkiKind, reason: PkiParseReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
    this.reason = reason;
  }
}
