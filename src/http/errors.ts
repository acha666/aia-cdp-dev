import type { Hook, z } from "@hono/zod-openapi";
import type { Context, Env, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeError } from "./log.ts";
import type { Logger } from "./log.ts";

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, details } };
}

export const ERROR_MESSAGES = {
  bad_request: "Bad request",
  unauthorized: "Unauthorized",
  not_found: "Not found",
  method_not_allowed: "Method not allowed",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  internal: "Internal server error",
} as const;

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export class ApiError extends Error {
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
      const auth = err.getResponse().headers.get("WWW-Authenticate");
      const headers = auth === null ? NO_STORE : { ...NO_STORE, "WWW-Authenticate": auth };
      return c.json(errorBody(code, ERROR_MESSAGES[code]), err.status, headers);
    }
    logUnexpected(err, c);
    return c.json(errorBody("internal", ERROR_MESSAGES.internal), 500, NO_STORE);
  };
}

export function validationError(target: string, error: z.ZodError): ApiError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String),
    code: issue.code,
    message: issue.message,
  }));
  return new ApiError(400, "bad_request", "Request validation failed", { target, issues });
}

export const validationHook: Hook<unknown, Env, string, undefined> = (result) => {
  if (!result.success) {
    throw validationError(result.target, result.error);
  }
  return undefined;
};
