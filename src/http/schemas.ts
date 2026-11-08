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

/** All API failures use the same envelope. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("ErrorResponse");

/** The `content` of a JSON request body or response. */
export function jsonContent<S extends z.ZodType>(schema: S) {
  return { "application/json": { schema } };
}

/** A response with a JSON body. */
export function jsonResponse<S extends z.ZodType>(description: string, schema: S) {
  return { description, content: jsonContent(schema) };
}

/** A binary request body or response (DER). */
export const binary = z.string().openapi({ format: "binary" });

/**
 * The raw request body of an upload under each of `mediaTypes`: text for PEM, binary otherwise.
 * The format is always recognized from the bytes.
 */
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

/** The 500 of the certificate and CRL routes. */
export const INTERNAL_ERROR = jsonResponse(
  "The store failed, or it cannot back what catalog.json and config.json name (logged, never " +
    "sent); retry later",
  ErrorResponse
);

/** The 413 of every route that reads a request body. */
export const PAYLOAD_TOO_LARGE = jsonResponse(
  "The body is larger than AIA_MAX_UPLOAD_BYTES",
  ErrorResponse
);

// Admin --------------------------------------------------------------------------------------------

/** The request media types of POST /api/v1/admin/certificates, for the raw body. */
export const CERTIFICATE_MEDIA_TYPES = [
  "application/pkix-cert",
  "application/x-pem-file",
  "application/octet-stream",
] as const;

/** 200 / 201 of POST /api/v1/admin/certificates: the catalog entry, without its store key. */
export const ImportedCertificate = z
  .object({
    outcome: z.enum(["created", "unchanged"]),
    /** SHA-256 of the DER. */
    id: Sha256Hex,
    size: Size,
    importedAt: Timestamp,
    summary: CertificateSummarySchema,
  })
  .openapi("ImportedCertificate");

// CRL upload ---------------------------------------------------------------------------------------

/**
 * The request media types of POST /api/v1/crls, for the raw body. They only pass the gate: the
 * format (DER or one X509 CRL PEM block) is always recognized from the bytes.
 */
export const CRL_MEDIA_TYPES = [
  "application/pkix-crl",
  "application/x-pem-file",
  "application/octet-stream",
] as const;

/** 200 / 201 of POST /api/v1/crls. */
export const PublishedCrl = z
  .object({
    /** created → 201; updated, unchanged → 200. */
    outcome: z.enum(["created", "updated", "unchanged"]),
    /** The target the configuration binds to the CRL's issuer and kind. */
    target: TargetId,
    kind: CrlKind,
    /** SHA-256 of the DER: the target's current CRL after the upload. */
    sha256: Sha256Hex,
    crlNumber: CrlSummarySchema.shape.crlNumber,
    baseCrlNumber: CrlSummarySchema.shape.baseCrlNumber,
    thisUpdate: CrlSummarySchema.shape.thisUpdate,
    nextUpdate: CrlSummarySchema.shape.nextUpdate,
    /** Id of the issuer certificate the target names, whose key verified the signature. */
    issuer: Sha256Hex,
    /** The paths that serve the target, in code-unit order, each DER path before its `.pem`. */
    downloads: z.array(z.string()),
  })
  .openapi("PublishedCrl");

// Public reads ------------------------------------------------------------------------------------
// The bodies of src/core/views.ts: catalog facts only. The UI decodes a certificate or CRL from its
// blob (GET /api/v1/blobs/{sha256}).

/**
 * A SHA-256 path parameter: 64 hex digits in either case, normalised to lowercase. Checked before
 * it is lowercased, so the documented pattern is the input's (either case). One path segment, so
 * `/` (sent as `%2F`) is a 400.
 */
function sha256Param(description: string) {
  return z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .toLowerCase()
    .openapi({ description });
}

/** Path parameter of GET /api/v1/blobs/{sha256}, normalised to lowercase. */
export const BlobParam = z.object({
  sha256: sha256Param("SHA-256 of the DER, hex (either case)"),
});

/** Path parameter of DELETE /api/v1/admin/certificates/{id}, normalised to the lowercase id. */
export const CertificateIdParam = z.object({
  id: sha256Param("The certificate id: SHA-256 of the DER, hex (either case)"),
});

/**
 * Path parameter of the admin CRL routes: an RFC 9562 UUID in either case (§4: case-insensitive on
 * input), normalised to lowercase like certificate ids. Lowercased before the check because
 * z.uuid() (config.json's target id validator, run as a check like the deprecated
 * z.string().uuid()) accepts the Max UUID in lowercase only. Documented as format uuid.
 */
export const TargetIdParam = z.object({
  targetId: z
    .string()
    .toLowerCase()
    .check(z.uuid())
    .openapi({ description: "The target id from config.json (UUID, either case)" }),
});

/** Path parameters of GET /api/v1/admin/crls/{targetId}/history/{sha256}. */
export const HistoryVersionParam = TargetIdParam.extend({
  sha256: sha256Param("SHA-256 of the version's DER, hex (either case)"),
});

const Downloads = z.array(z.string()).openapi({
  description:
    "The paths that serve the resource (config.json's path table), in code-unit order, each DER " +
    "path followed by its `.pem`; [] when none is configured",
});

/** A configured target that names the certificate as its issuer. */
const CertificateTarget = z
  .object({ targetId: TargetId, kind: CrlKind, label: z.string() })
  .openapi("CertificateTarget");

export const CertificateListItem = z
  .object({
    /** SHA-256 of the DER. */
    id: Sha256Hex,
    /** config.json's label; null when the certificate has none. */
    label: z.string().nullable(),
    importedAt: Timestamp,
    size: Size,
    summary: CertificateSummarySchema,
    downloads: Downloads,
    /** In targetId order. */
    targets: z.array(CertificateTarget),
  })
  .openapi("CertificateListItem");

/** A target's issuer certificate: its id, config.json label and subject CN. */
const CrlIssuer = z
  .object({ id: Sha256Hex, label: z.string().nullable(), subjectCN: z.string().nullable() })
  .openapi("CrlIssuer");

/** A target's current CRL as the catalog records it at publish time. */
const CrlCurrent = z
  .object({
    /** SHA-256 of the DER. */
    sha256: Sha256Hex,
    size: Size,
    publishedAt: Timestamp,
    /** Id of the certificate whose key verified the signature. */
    verifier: Sha256Hex,
    summary: CrlSummarySchema,
  })
  .openapi("CrlCurrent");

export const CrlTargetListItem = z
  .object({
    targetId: TargetId,
    /** From config.json, not from the CRL. */
    kind: CrlKind,
    label: z.string(),
    issuer: CrlIssuer,
    downloads: Downloads,
    // A union rather than .nullable(): the generator writes a nullable named schema as its bare $ref.
    current: z
      .union([CrlCurrent, z.null()])
      .openapi({ description: "null while nothing is published" }),
  })
  .openapi("CrlTargetListItem");
