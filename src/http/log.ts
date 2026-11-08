import { createMiddleware } from "hono/factory";

type LogLevel = "info" | "warn" | "error";

/** A structured log record; runtimes print it as one JSON line. */
export interface LogRecord {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

export type Logger = (record: LogRecord) => void;

/** Makes an error loggable as JSON. */
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

/** Logs one record per request. */
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
