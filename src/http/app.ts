// The one HTTP application behind both runtimes; it never sees a runtime env, only AppDeps.
//
// Every route is registered here, before the first request (SmartRouter freezes then). Never
// `app.get("*")`: methodNotAllowed would turn every unknown-path POST into 405, so the UI fallback
// lives in notFound.
import { OpenAPIHono } from "@hono/zod-openapi";
import { methodNotAllowed } from "hono/method-not-allowed";
import { securityHeaders } from "./csp.ts";
import { createErrorHandler, validationHook } from "./errors.ts";
import { requestLog } from "./log.ts";
import { adminRoutes } from "./routes/admin.ts";
import { certificateRoutes } from "./routes/certificates.ts";
import { crlRoutes } from "./routes/crls.ts";
import { downloadRoutes } from "./routes/downloads.ts";
import { healthRoutes } from "./routes/health.ts";
import type { AppDeps } from "./types.ts";
import { onMethodNotAllowed, uiFallback } from "./ui.ts";

const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: { title: "aia-cdp API", version: "1" },
  // Every operation carries one of these (tests/http/openapi.test.ts).
  tags: [
    { name: "health", description: "Service health" },
    { name: "certificates", description: "Imported CA certificates" },
    { name: "crls", description: "CRL targets: their current CRLs, and the upload" },
    {
      name: "blobs",
      description: "The DER of certificates and current CRLs, for the UI to decode",
    },
    { name: "admin", description: "Certificate import and config.json (AIA_ADMIN_TOKEN)" },
  ],
};

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.onError(createErrorHandler(deps.log));
  app.notFound(uiFallback(deps));

  // The admin and upload routes add their own auth and bodyLimit after these (routes/admin.ts,
  // routes/crls.ts). secureHeaders covers every response, the UI's too (ui.ts copies the deps.ui
  // answer first); its CSP is the UI's (csp.ts) and changes nothing for JSON or downloads.
  app.use(securityHeaders);
  app.use(requestLog(deps.log));
  app.use(methodNotAllowed({ app, onMethodNotAllowed }));

  // Kept for the life of this app (one per process / isolate). This route is not in the document.
  let openapiJson: string | undefined;
  app.get("/api/v1/openapi.json", (c) => {
    openapiJson ??= JSON.stringify(app.getOpenAPI31Document(OPENAPI_CONFIG));
    return c.body(openapiJson, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "public, max-age=300",
    });
  });

  // AppType (hc<AppType>) is inferred from the chained value, so only the public routes join it.
  // The admin routes are served and documented but stay out of the web client's types; the
  // download routes are a plain Hono app, neither in AppType nor in the OpenAPI document.
  const routes = app
    .route("/api/v1", healthRoutes(deps))
    .route("/api/v1", certificateRoutes(deps))
    .route("/api/v1", crlRoutes(deps));
  app.route("/api/v1", adminRoutes(deps));
  app.route("/", downloadRoutes(deps));
  return routes;
}

export type AppType = ReturnType<typeof createApp>;
