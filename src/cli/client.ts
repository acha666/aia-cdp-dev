/**
 * HTTP and I/O for the CLI commands.
 *
 * @packageDocumentation
 */

/** Everything the CLI touches outside itself, so tests can replace it. */
export interface CliIo {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

/** A mistake in the command line or its environment (exit code 2). */
export class UsageError extends Error {
  override name = "UsageError";
}

/** The command ran and failed (exit code 1). */
export class Failure extends Error {
  override name = "Failure";
}

export interface Context {
  io: CliIo;
  json: boolean;
  url: string | undefined;
  tokenFile: string | undefined;
  allowInsecureHttp: boolean;
}

export async function readBytes(
  io: CliIo,
  file: string,
  fail: (reason: string) => Error
): Promise<Uint8Array> {
  try {
    return await io.readFile(file);
  } catch (error) {
    throw fail(reasonOf(error));
  }
}

export function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  }
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

const REQUEST_TIMEOUT_MS = 30_000;

// Checked before sending, since fetch rejects an invalid header value with an error that quotes it.
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

function parsedServiceUrl(ctx: Context): URL {
  if (ctx.url === undefined || ctx.url === "") {
    throw new UsageError("no service URL: pass --url or set AIA_URL");
  }
  const url = URL.parse(ctx.url);
  if (url === null) {
    throw new UsageError("--url / AIA_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--url / AIA_URL must be an http:// or https:// URL");
  }
  return url;
}

// Covers the hosts whose traffic stays on this machine.
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname)
  );
}

function checkTokenTransport(ctx: Context, name: string, url: URL): void {
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !ctx.allowInsecureHttp) {
    throw new UsageError(
      `refusing to send the ${name} token over http:// to ${url.host}: use https://, ` +
        "or pass --allow-insecure-http"
    );
  }
}

/**
 * Reads the token for `name` from `--token-file`, `<VAR>_FILE` or `<VAR>`, in that order,
 * and refuses to send it over plain HTTP to another host.
 */
async function bearerToken(
  ctx: Context,
  name: "admin" | "upload",
  url: URL
): Promise<string | undefined> {
  const { env } = ctx.io;
  const variable = name === "admin" ? "AIA_ADMIN_TOKEN" : "AIA_UPLOAD_TOKEN";
  const fileVariable = `${variable}_FILE`;
  const file = ctx.tokenFile ?? env[fileVariable];
  let token: string | undefined;
  let source: string;
  if (file !== undefined && file !== "") {
    if (ctx.tokenFile === undefined && env[variable] !== undefined) {
      throw new UsageError(`set either ${variable} or ${fileVariable}, not both`);
    }
    source = `the token file ${file}`;
    const fail = (reason: string) => new UsageError(`cannot read ${source}: ${reason}`);
    token = new TextDecoder().decode(await readBytes(ctx.io, file, fail)).trim();
  } else {
    source = variable;
    token = env[variable]?.trim();
  }
  if (token === "") {
    throw new UsageError(`the ${name} token in ${source} is empty`);
  }
  if (token !== undefined && !BEARER_TOKEN.test(token)) {
    throw new UsageError(
      `the ${name} token in ${source} has characters a bearer token cannot have ` +
        "(letters, digits and - . _ ~ + / only, optionally ending in =)"
    );
  }
  if (token !== undefined) {
    checkTokenTransport(ctx, name, url);
  }
  return token;
}

/**
 * Returns a function that sends requests to the API under the service URL. An admin client
 * requires a token; an upload client sends one if it is set.
 */
export async function createClient(ctx: Context, access: "admin" | "upload" | "public" = "admin") {
  const url = parsedServiceUrl(ctx);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/v1`;
  const token = access === "public" ? undefined : await bearerToken(ctx, access, url);
  if (access === "admin" && token === undefined) {
    throw new UsageError(
      "no admin token: pass --token-file, or set AIA_ADMIN_TOKEN_FILE or AIA_ADMIN_TOKEN"
    );
  }
  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token !== undefined) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return request(ctx, `${base}${path}`, { method: "GET", ...init, headers });
  };
}

export type Api = Awaited<ReturnType<typeof createClient>>;

async function request(ctx: Context, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await ctx.io.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Failure(`cannot reach ${url}: ${reasonOf(error)}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    throw new Failure(`cannot read the response from ${url}: ${reasonOf(error)}`);
  }
  const { status, statusText, ok, headers } = res;
  return {
    url,
    status,
    statusText,
    ok,
    headers,
    bytes,
    text: new TextDecoder().decode(bytes),
    error(): HttpError {
      return httpError(this);
    },
    check(accepted = ok) {
      if (!accepted) {
        throw new Failure(describeHttp(this.error()));
      }
      return this;
    },
    json<T = unknown>(): T {
      try {
        return JSON.parse(this.text) as T;
      } catch {
        throw new Failure(`HTTP ${status}, but the body is not JSON`);
      }
    },
  };
}

export interface HttpError {
  status: number;
  code?: string;
  message: string;
  details?: unknown;
}

/** Reads the API error envelope, falling back to the HTTP status. */
function httpError(reply: Pick<Response, "status" | "statusText"> & { text: string }): HttpError {
  try {
    const { error } = JSON.parse(reply.text) as { error?: Record<string, unknown> };
    if (typeof error?.code === "string" && typeof error.message === "string") {
      return {
        status: reply.status,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
  } catch {
    // Not the API's error envelope.
  }
  return { status: reply.status, message: reply.statusText || "unexpected response" };
}

export function describeHttp(error: HttpError): string {
  const details = error.details as { reason?: unknown } | undefined;
  const reason = typeof details?.reason === "string" ? ` (${details.reason})` : "";
  const code = error.code === undefined ? "" : ` ${error.code}`;
  return `HTTP ${error.status}${code}${reason}: ${error.message}`;
}
