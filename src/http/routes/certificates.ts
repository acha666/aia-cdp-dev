// Public reads: the certificate list and the blobs the UI decodes. Each request reads config.json
// and catalog.json once. The SHA-256 is never a store key (an archive-style one is a 400).
//
// Failures are thrown (a blob the catalog names but the store lacks is a 500), so onError writes
// every envelope (no-store). HEAD is Hono's automatic HEAD of each GET.
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { readState } from "../../core/catalog.ts";
import { IMMUTABLE } from "../../core/resources.ts";
import { readBlob } from "../../core/store.ts";
import { certificateList, findBlob } from "../../core/views.ts";
import { ApiError, NO_STORE } from "../errors.ts";
import {
  binary,
  BlobParam,
  CertificateListItem,
  ErrorResponse,
  INTERNAL_ERROR,
  jsonResponse,
} from "../schemas.ts";
import type { AppDeps } from "../types.ts";

const TAGS = ["certificates"];

const listCertificatesRoute = createRoute({
  method: "get",
  path: "/certificates",
  operationId: "listCertificates",
  summary: "List certificates",
  description:
    "Every imported certificate, in id order, with its catalog summary, config.json label, " +
    "download paths and the targets it issues CRLs for. The whole list: no pagination.",
  tags: TAGS,
  responses: {
    200: jsonResponse("The certificates", CertificateListItem.array()),
    500: INTERNAL_ERROR,
  },
});

const getBlobRoute = createRoute({
  method: "get",
  path: "/blobs/{sha256}",
  operationId: "getBlob",
  summary: "Get a certificate or CRL",
  description:
    "The DER of the imported certificate with this id, or of a configured target's current CRL " +
    "with this SHA-256, as stored. The bytes never change, so the response may be cached for good.",
  tags: ["blobs"],
  request: { params: BlobParam },
  responses: {
    200: {
      description: "The DER",
      content: {
        "application/pkix-cert": { schema: binary },
        "application/pkix-crl": { schema: binary },
      },
    },
    400: jsonResponse("The SHA-256 is not 64 hex digits", ErrorResponse),
    404: jsonResponse("No certificate or current CRL has this SHA-256", ErrorResponse),
    500: INTERNAL_ERROR,
  },
});

export function certificateRoutes(deps: AppDeps) {
  return new OpenAPIHono()
    .openapi(listCertificatesRoute, async (c) => {
      const { config, catalog } = await readState(deps.store);
      return c.json(certificateList(config, catalog), 200, NO_STORE);
    })
    .openapi(getBlobRoute, async (c) => {
      const { sha256 } = c.req.valid("param");
      const { config, catalog } = await readState(deps.store);
      const blob = findBlob(config, catalog, sha256);
      if (blob === undefined) {
        throw new ApiError(404, "not_found", "No certificate or current CRL has this SHA-256");
      }
      const der = await readBlob(deps.store, blob.key);
      return c.body(der, 200, {
        "Content-Type": blob.kind === "crl" ? "application/pkix-crl" : "application/pkix-cert",
        "Content-Length": String(der.byteLength),
        "Cache-Control": IMMUTABLE,
      });
    });
}
