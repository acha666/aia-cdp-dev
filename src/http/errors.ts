// Error envelope and handlers: a success body is the resource itself, a failure is one envelope
// `{ error: { code, message, details? } }`, and exception text never reaches a response.
import type { Hook, z } from "@hono/zod-openapi";
import type { Context, Env, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeError } from "./log.ts";
import type { Logger } from "./log.ts";

/** The failure envelope; an undefined `details` is left out of the JSON. */
export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, details } };
}

/** Our own fixed texts for errors raised by the framework or by unexpected failures. */
export const ERROR_MESSAGES = {
  bad_request: "Bad request",
  unauthorized: "Unauthorized",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  internal: "Internal server error",
} as const;

/** API JSON, including every error, is never cached. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Thrown by http/core code for expected failures; mapped 1:1 onto the envelope by onError. */
export class ApiError extends Error {
  // erasableSyntaxOnly: explicit fields instead of constructor parameter properties.
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Error code for an HTTPException thrown by Hono (bearerAuth: 400 / 401, bodyLimit: 413, the JSON
 * validator: 400, zod-openapi's JSON media type check: 415).
 */
const CODE_BY_STATUS: Partial<Record<number, keyof typeof ERROR_MESSAGES>> = {
  400: "bad_request",
  401: "unauthorized",
  413: "payload_too_large",
  415: "unsupported_media_type",
};

export function createErrorHandler(log: Logger): ErrorHandler {
  const logUnexpected = (err: Error, c: Context) => {
    log({
      level: "error",
      msg: "unhandled_error",
      method: c.req.method,
      path: c.req.path,
      error: describeError(err, { stack: true }),
    });
  };
  return (err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), err.status, NO_STORE);
    }
    if (err instanceof HTTPException) {
      const code = CODE_BY_STATUS[err.status] ?? (err.status >= 500 ? "internal" : "bad_request");
      if (code === "internal") {
        logUnexpected(err, c);
      }
      // bearerAuth's WWW-Authenticate survives the envelope rewrite.
      const auth = err.getResponse().headers.get("WWW-Authenticate");
      const headers = auth === null ? NO_STORE : { ...NO_STORE, "WWW-Authenticate": auth };
      // The library's message is not part of the contract: use our own text.
      return c.json(errorBody(code, ERROR_MESSAGES[code]), err.status, headers);
    }
    // Unexpected: the stack goes to the log, never to the client.
    logUnexpected(err, c);
    return c.json(errorBody("internal", ERROR_MESSAGES.internal), 500, NO_STORE);
  };
}

/** 400 bad_request for a zod validation failure, with the target and the issues. */
export function validationError(target: string, error: z.ZodError): ApiError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String),
    code: issue.code,
    message: issue.message,
  }));
  return new ApiError(400, "bad_request", "Request validation failed", { target, issues });
}

/**
 * OpenAPIHono defaultHook: a zod validation failure throws validationError, so onError writes the
 * envelope. Thrown rather than returned so that a route-level hook can delegate to it without
 * widening its typed responses.
 */
export const validationHook: Hook<unknown, Env, string, undefined> = (result) => {
  if (!result.success) {
    throw validationError(result.target, result.error);
  }
  return undefined;
};
