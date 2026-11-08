import { z } from "@hono/zod-openapi";
import {
  CertificateSummarySchema,
  CrlKind,
  CrlSummarySchema,
  Sha256Hex,
  Size,
  TargetId,
  Timestamp,
} from "../core/catalog.ts";

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("ErrorResponse");

export function jsonContent<S extends z.ZodType>(schema: S) {
  return { "application/json": { schema } };
}

export function jsonResponse<S extends z.ZodType>(description: string, schema: S) {
  return { description, content: jsonContent(schema) };
}

export const binary = z.string().openapi({ format: "binary" });

export function rawBody(mediaTypes: readonly string[]) {
  return {
    required: true,
    content: Object.fromEntries(
      mediaTypes.map((type) => [
        type,
        { schema: type === "application/x-pem-file" ? z.string() : binary },
      ])
    ),
  };
}

export const INTERNAL_ERROR = jsonResponse(
  "The store failed, or it cannot back what catalog.json and config.json name (logged, never " +
    "sent); retry later",
  ErrorResponse
);

export const PAYLOAD_TOO_LARGE = jsonResponse(
  "The body is larger than AIA_MAX_UPLOAD_BYTES",
  ErrorResponse
);

export const CERTIFICATE_MEDIA_TYPES = [
  "application/pkix-cert",
  "application/x-pem-file",
  "application/octet-stream",
] as const;

export const ImportedCertificate = z
  .object({
    outcome: z.enum(["created", "unchanged"]),
    id: Sha256Hex,
    size: Size,
    importedAt: Timestamp,
    summary: CertificateSummarySchema,
  })
  .openapi("ImportedCertificate");

export const CRL_MEDIA_TYPES = [
  "application/pkix-crl",
  "application/x-pem-file",
  "application/octet-stream",
] as const;

export const PublishedCrl = z
  .object({
    outcome: z.enum(["created", "updated", "unchanged"]),
    target: TargetId,
    kind: CrlKind,
    sha256: Sha256Hex,
    crlNumber: CrlSummarySchema.shape.crlNumber,
    baseCrlNumber: CrlSummarySchema.shape.baseCrlNumber,
    thisUpdate: CrlSummarySchema.shape.thisUpdate,
    nextUpdate: CrlSummarySchema.shape.nextUpdate,
    issuer: Sha256Hex,
    downloads: z.array(z.string()),
  })
  .openapi("PublishedCrl");

function sha256Param(description: string) {
  return z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .toLowerCase()
    .openapi({ description });
}

export const BlobParam = z.object({
  sha256: sha256Param("SHA-256 of the DER, hex (either case)"),
});

export const CertificateIdParam = z.object({
  id: sha256Param("The certificate id: SHA-256 of the DER, hex (either case)"),
});

export const TargetIdParam = z.object({
  targetId: z
    .string()
    .toLowerCase()
    .check(z.uuid())
    .openapi({ description: "The target id from config.json (UUID, either case)" }),
});

export const HistoryVersionParam = TargetIdParam.extend({
  sha256: sha256Param("SHA-256 of the version's DER, hex (either case)"),
});

const Downloads = z.array(z.string()).openapi({
  description:
    "The paths that serve the resource (config.json's path table), in code-unit order, each DER " +
    "path followed by its `.pem`; [] when none is configured",
});

const CertificateTarget = z
  .object({ targetId: TargetId, kind: CrlKind, label: z.string() })
  .openapi("CertificateTarget");

export const CertificateListItem = z
  .object({
    id: Sha256Hex,
    label: z.string().nullable(),
    importedAt: Timestamp,
    size: Size,
    summary: CertificateSummarySchema,
    downloads: Downloads,
    targets: z.array(CertificateTarget),
  })
  .openapi("CertificateListItem");

const CrlIssuer = z
  .object({ id: Sha256Hex, label: z.string().nullable(), subjectCN: z.string().nullable() })
  .openapi("CrlIssuer");

const CrlCurrent = z
  .object({
    sha256: Sha256Hex,
    size: Size,
    publishedAt: Timestamp,
    verifier: Sha256Hex,
    summary: CrlSummarySchema,
  })
  .openapi("CrlCurrent");

export const CrlTargetListItem = z
  .object({
    targetId: TargetId,
    kind: CrlKind,
    label: z.string(),
    issuer: CrlIssuer,
    downloads: Downloads,
    current: z
      .union([CrlCurrent, z.null()])
      .openapi({ description: "null while nothing is published" }),
  })
  .openapi("CrlTargetListItem");
