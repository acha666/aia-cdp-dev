// Structured logging: deps.log writes each record as one JSON object; `msg` is an event name.
// Never log tokens, request bodies, headers or query strings.
import { createMiddleware } from "hono/factory";

type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export type Logger = (record: LogRecord) => void;

/** Loggable summary of a thrown value. The stack only when asked (unexpected errors). */
export function describeError(
  error: unknown,
  options: { stack?: boolean } = {}
): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return options.stack && error.stack !== undefined
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: error.name, message: error.message };
  }
  return { name: typeof error, message: String(error) };
}

/**
 * Exactly one `request` line per request, written after `next()`: it runs outside
 * methodNotAllowed and onError, so it records the final status (405, the 500 envelope, …).
 * `path` is `c.req.path`, without the query string.
 */
export function requestLog(log: Logger) {
  return createMiddleware(async (c, next) => {
    const start = performance.now();
    await next();
    log({
      level: "info",
      msg: "request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - start) * 10) / 10,
    });
  });
}
