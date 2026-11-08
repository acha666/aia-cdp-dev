// CRL targets: the list and the upload. Failures are thrown, so onError writes every envelope
// (no-store). HEAD of the list is Hono's automatic HEAD of its GET.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { readState } from "../../core/catalog.ts";
import { publishCrl } from "../../core/publish.ts";
import type { PublishErrorCode, PublishFailure } from "../../core/publish.ts";
import { crlTargetList } from "../../core/views.ts";
import { ApiError, NO_STORE } from "../errors.ts";
import { mediaTypeGate } from "../media.ts";
import {
  ErrorResponse,
  CRL_MEDIA_TYPES,
  CrlTargetListItem,
  INTERNAL_ERROR,
  jsonContent,
  jsonResponse,
  PAYLOAD_TOO_LARGE,
  PublishedCrl,
  rawBody,
} from "../schemas.ts";
import type { AppDeps, AppSettings } from "../types.ts";

const SECURITY_SCHEME = "uploadBearer";

// Anonymous (`{}`) while AIA_UPLOAD_TOKEN is unset, the bearer token once it is set. Typed: an
// inferred union of the two element shapes would make createRoute lose the route's literal types.
const security: Record<string, string[]>[] = [{}, { [SECURITY_SCHEME]: [] }];

const TAGS = ["crls"];

const crlMediaType = mediaTypeGate(
  CRL_MEDIA_TYPES,
  "Send the CRL as application/pkix-crl, application/x-pem-file or application/octet-stream"
);

function uploadCrlRoute(settings: AppSettings) {
  return createRoute({
    method: "post",
    path: "/crls",
    operationId: "uploadCrl",
    summary: "Publish a CRL",
    description:
      "One CRL, DER or a single X509 CRL PEM block, as the request body; the format is " +
      "recognized from the bytes. It goes to the target that the configuration binds to its issuer (found by the Authority Key " +
      "Identifier) and its kind (full or delta), once the extension policy, the issuer's " +
      "signature and the comparison with the target's current CRL accept it. " +
      "`Authorization: Bearer <AIA_UPLOAD_TOKEN>` is needed only while that token is set.",
    tags: TAGS,
    security,
    // Auth first: an anonymous client never gets its body read, nor a 413 that tells it the limit.
    // bodyLimit also stops a streamed body without Content-Length.
    middleware: [
      ...(settings.uploadToken === undefined ? [] : [bearerAuth({ token: settings.uploadToken })]),
      crlMediaType,
      bodyLimit({ maxSize: settings.maxUploadBytes }),
    ],
    request: { body: rawBody(CRL_MEDIA_TYPES) },
    responses: {
      200: jsonResponse(
        "Updated; or `unchanged`: the same bytes are current, nothing was written",
        PublishedCrl
      ),
      201: jsonResponse("Published to a target without a current CRL", PublishedCrl),
      400: jsonResponse("A malformed Authorization header, or an empty body", ErrorResponse),
      401: {
        description: "AIA_UPLOAD_TOKEN is set, and the token is missing or wrong",
        headers: z.object({ "WWW-Authenticate": z.string() }),
        content: jsonContent(ErrorResponse),
      },
      409: jsonResponse(
        "Not newer than the target's current CRL (`details.current`): stale_crl, conflict " +
          "(other bytes for the same CRL Number and thisUpdate) or non_orderable (a CRL Number " +
          "on one side only); or concurrent_update (the catalog kept changing: retry)",
        ErrorResponse
      ),
      413: PAYLOAD_TOO_LARGE,
      415: jsonResponse(
        "The Content-Type is missing or not one of the request body's media types",
        ErrorResponse
      ),
      422: jsonResponse(
        "Not a CRL this service publishes: the code and `details` say why",
        ErrorResponse
      ),
      500: INTERNAL_ERROR,
    },
  });
}

// Reads -----------------------------------------------------------------------------------------

const listCrlTargetsRoute = createRoute({
  method: "get",
  path: "/crls",
  operationId: "listCrlTargets",
  summary: "List CRL targets",
  description:
    "Every target config.json defines, in targetId order, with its kind, label, issuer, download " +
    "paths and current CRL summary (`current: null` while nothing is published). The whole " +
    "list: no pagination.",
  tags: TAGS,
  responses: {
    200: jsonResponse("The targets", CrlTargetListItem.array()),
    500: INTERNAL_ERROR,
  },
});

// Failures --------------------------------------------------------------------------------------

/** The public message for each publish failure. */
const FAILURES = {
  invalid_crl: "Not a valid X.509 CRL",
  not_yet_valid: "The CRL's thisUpdate is more than 5 minutes ahead of the service's clock",
  scoped_crl_unsupported: "Scoped and indirect CRLs are not supported",
  unsupported_algorithm: "The CRL's signature algorithm is not supported",
  issuer_not_found:
    "No imported certificate has the CRL's Authority Key Identifier as its Subject Key Identifier",
  target_not_configured: "No configured target of the CRL's kind names its issuer",
  invalid_signature: "The CRL's signature does not verify with the issuer's key",
  stale_crl: "The CRL is older than the target's current CRL",
  conflict: "The target's current CRL has other bytes for the same CRL Number and thisUpdate",
  non_orderable: "Only one of the CRL and the target's current CRL has a CRL Number",
  concurrent_update: "The catalog kept changing concurrently: retry the upload",
} as const satisfies Record<PublishErrorCode, string>;

/** Status and message; details as publishCrl gives them (concurrent_update has none). */
function publishError(failure: PublishFailure): ApiError {
  const message =
    failure.error === "issuer_not_found" && "reason" in failure.details
      ? "The CRL has no Authority Key Identifier keyIdentifier"
      : FAILURES[failure.error];
  const status =
    failure.error === "stale_crl" ||
    failure.error === "conflict" ||
    failure.error === "non_orderable" ||
    failure.error === "concurrent_update"
      ? 409
      : 422;
  return new ApiError(
    status,
    failure.error,
    message,
    "details" in failure ? failure.details : undefined
  );
}

// Sub-app ---------------------------------------------------------------------------------------

export function crlRoutes(deps: AppDeps) {
  const crls = new OpenAPIHono();

  crls.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEME, {
    type: "http",
    scheme: "bearer",
    description: "AIA_UPLOAD_TOKEN (optional: while it is unset, uploads need no token)",
  });

  return crls
    .openapi(listCrlTargetsRoute, async (c) => {
      const { config, catalog } = await readState(deps.store);
      return c.json(crlTargetList(config, catalog), 200, NO_STORE);
    })
    .openapi(uploadCrlRoute(deps.settings), async (c) => {
      const bytes = await c.req.bytes();
      if (bytes.byteLength === 0) {
        throw new ApiError(400, "bad_request", "Expected a CRL, but the upload is empty");
      }
      // Logs the call's one `publish` line, also when it throws (then onError's 500).
      const result = await publishCrl(deps, bytes);
      if ("error" in result) {
        throw publishError(result);
      }
      const { outcome, targetId, kind, issuer, current, downloads } = result;
      const { crlNumber, baseCrlNumber, thisUpdate, nextUpdate } = current.summary;
      const body = {
        outcome,
        target: targetId,
        kind,
        sha256: current.sha256,
        crlNumber,
        baseCrlNumber,
        thisUpdate,
        nextUpdate,
        issuer,
        downloads,
      };
      return outcome === "created" ? c.json(body, 201, NO_STORE) : c.json(body, 200, NO_STORE);
    });
}
