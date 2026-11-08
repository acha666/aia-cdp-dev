// Downloads: which resource a request path names and its headers, from config.json and catalog.json
// alone, so the route reads the blob only for a GET that is not answered 304.
// The request path is never a store key, only a key of config.paths: blobs/, history/, config.json
// and catalog.json cannot be downloaded, and an entry the catalog or config cannot back is
// `inconsistent` (a 500) instead of being served from somewhere else.
import type { Catalog, Config, ConfigPath, CrlKind } from "./catalog.ts";
import type { PkiKind } from "./pki/errors.ts";
import { pemLength } from "./pki/pem.ts";

/** A certificate (/ca/) or a target's CRL (/crl/ full, /dcrl/ delta): what the headers go by. */
export type DownloadKind = "certificate" | CrlKind;

/** DER as stored, or PEM derived on read (`<path>.pem`). */
export type DownloadFormat = "der" | "pem";

export interface FoundDownload {
  status: "found";
  kind: DownloadKind;
  format: DownloadFormat;
  /** SHA-256 of the DER, from the catalog. */
  sha256: string;
  /** Store key of the DER blob. */
  key: string;
  /** DER size in bytes, from the catalog. */
  size: number;
  /**
   * Last request path segment, `.pem` included. That path is a config path (plus `.pem`), never
   * other request text, so it goes into Content-Disposition as it is.
   */
  filename: string;
  /** The CRL's nextUpdate; null for a certificate and for a CRL without one. */
  nextUpdate: Date | null;
  /** importedAt of a certificate, current.publishedAt of a CRL. */
  lastModified: Date;
}

/**
 * `inconsistent`: the path entry `reference` names a certificate not in the catalog or a target not
 * in config.targets, e.g. a certificate deleted while applyConfig ran.
 */
export type DownloadResolution =
  FoundDownload | { status: "not_found" } | { status: "inconsistent"; reference: ConfigPath };

const NOT_FOUND = { status: "not_found" } as const;

const PEM_SUFFIX = ".pem";

/**
 * The resource `path` names. `path` is Hono's `c.req.path` (decoded with decodeURI, so `%2F` and
 * malformed `%` sequences stay as they are) and is not decoded again. It matches a config path
 * exactly and case-sensitively, or one plus a single `.pem` for PEM (config paths never end in
 * `.pem`). A target never published, or with a null current, is not_found.
 */
export function resolveDownload(
  config: Config,
  catalog: Catalog,
  path: string
): DownloadResolution {
  let format: DownloadFormat = "der";
  let entry = config.paths[path];
  if (entry === undefined && path.endsWith(PEM_SUFFIX)) {
    format = "pem";
    entry = config.paths[path.slice(0, -PEM_SUFFIX.length)];
  }
  if (entry === undefined) {
    return NOT_FOUND;
  }
  const filename = path.slice(path.lastIndexOf("/") + 1);
  if ("certificate" in entry) {
    const certificate = catalog.certificates[entry.certificate];
    if (certificate === undefined) {
      return { status: "inconsistent", reference: { certificate: entry.certificate } };
    }
    return {
      status: "found",
      kind: "certificate",
      format,
      sha256: entry.certificate,
      key: certificate.key,
      size: certificate.size,
      filename,
      nextUpdate: null,
      lastModified: new Date(certificate.importedAt),
    };
  }
  const target = config.targets[entry.target];
  if (target === undefined) {
    return { status: "inconsistent", reference: { target: entry.target } };
  }
  const current = catalog.targets[entry.target]?.current ?? null;
  if (current === null) {
    return NOT_FOUND;
  }
  const { nextUpdate } = current.summary;
  return {
    status: "found",
    kind: target.kind,
    format,
    sha256: current.sha256,
    key: current.key,
    size: current.size,
    filename,
    nextUpdate: nextUpdate === null ? null : new Date(nextUpdate),
    lastModified: new Date(current.publishedAt),
  };
}

/**
 * The reverse of resolveDownload: every config path mapped to `reference`, in code-unit order, each
 * DER path followed by its `<path>.pem`.
 */
export function downloadPaths(config: Config, reference: ConfigPath): string[] {
  const matches = ([, entry]: [string, ConfigPath]) =>
    "certificate" in reference
      ? "certificate" in entry && entry.certificate === reference.certificate
      : "target" in entry && entry.target === reference.target;
  return Object.entries(config.paths)
    .filter(matches)
    .map(([path]) => path)
    .sort()
    .flatMap((path) => [path, `${path}${PEM_SUFFIX}`]);
}

// Header policy ----------------------------------------------------------------------------------

/** The headers of a found download; a 304 carries only ETag and Cache-Control of them. */
export interface DownloadHeaders {
  "Content-Type": string;
  ETag: string;
  "Content-Length": string;
  "Cache-Control": string;
  "Last-Modified": string;
  "Content-Disposition": string;
}

// By kind, not by path suffix; PEM is application/x-pem-file, never text/plain.
const DER_CONTENT_TYPES: Record<DownloadKind, string> = {
  certificate: "application/pkix-cert",
  full: "application/pkix-crl",
  delta: "application/pkix-crl",
};

const PEM_CONTENT_TYPE = "application/x-pem-file";

/**
 * Cache-Control of bytes that never change at their URL: certificate downloads (V7; a two-step
 * rebind is the operator's responsibility), blobs by SHA-256 and hashed UI assets.
 */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** CRL max-age bounds in seconds: an expired CRL still gets 60, a far one at most 3600. */
const CRL_MAX_AGE = { min: 60, max: 3600, withoutNextUpdate: 300 } as const;

export function pemKind(kind: DownloadKind): PkiKind {
  return kind === "certificate" ? "certificate" : "crl";
}

function crlMaxAge(nextUpdate: Date | null, now: Date): number {
  if (nextUpdate === null) {
    return CRL_MAX_AGE.withoutNextUpdate;
  }
  const seconds = Math.floor((nextUpdate.getTime() - now.getTime()) / 1000);
  return Math.min(CRL_MAX_AGE.max, Math.max(CRL_MAX_AGE.min, seconds));
}

function cacheControl(found: FoundDownload, now: Date): string {
  return found.kind === "certificate"
    ? IMMUTABLE
    : `public, max-age=${crlMaxAge(found.nextUpdate, now)}, must-revalidate`;
}

/**
 * Response headers of a found download, the same for GET, HEAD and a 304. ETag and Content-Length
 * come from the catalog, so neither needs the blob, and a store ETag never leaves the adapter.
 * Last-Modified is informational only: If-Modified-Since is not evaluated (one-second precision;
 * the ETag covers revalidation).
 */
export function downloadHeaders(found: FoundDownload, now: Date): DownloadHeaders {
  const pem = found.format === "pem";
  return {
    "Content-Type": pem ? PEM_CONTENT_TYPE : DER_CONTENT_TYPES[found.kind],
    ETag: pem ? `"${found.sha256}-pem"` : `"${found.sha256}"`,
    "Content-Length": String(pem ? pemLength(found.size, pemKind(found.kind)) : found.size),
    "Cache-Control": cacheControl(found, now),
    "Last-Modified": found.lastModified.toUTCString(),
    "Content-Disposition": `attachment; filename="${found.filename}"`,
  };
}

const stripWeak = (tag: string) => tag.replace(/^W\//, "");

/**
 * Whether `If-None-Match` matches the quoted download `etag`, as hono/etag's etagMatches compares,
 * plus `*`: weak comparison (RFC 9110 §13.1.2) of each trimmed comma-separated member. An unquoted
 * value never matches (the client gets a full download); a missing or empty header never does.
 */
export function ifNoneMatchHit(header: string | null | undefined, etag: string): boolean {
  if (header === null || header === undefined) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }
  const wanted = stripWeak(etag);
  return header.split(",").some((member) => stripWeak(member.trim()) === wanted);
}
