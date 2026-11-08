import type { Catalog, Config, ConfigPath, CrlKind } from "./catalog.ts";
import type { PkiKind } from "./pki/errors.ts";
import { pemLength } from "./pki/pem.ts";

export type DownloadKind = "certificate" | CrlKind;

export type DownloadFormat = "der" | "pem";

export interface FoundDownload {
  status: "found";
  kind: DownloadKind;
  format: DownloadFormat;
  sha256: string;
  key: string;
  size: number;
  filename: string;
  nextUpdate: Date | null;
  lastModified: Date;
}

export type DownloadResolution =
  FoundDownload | { status: "not_found" } | { status: "inconsistent"; reference: ConfigPath };

const NOT_FOUND = { status: "not_found" } as const;

const PEM_SUFFIX = ".pem";

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

export interface DownloadHeaders {
  "Content-Type": string;
  ETag: string;
  "Content-Length": string;
  "Cache-Control": string;
  "Last-Modified": string;
  "Content-Disposition": string;
}

const DER_CONTENT_TYPES: Record<DownloadKind, string> = {
  certificate: "application/pkix-cert",
  full: "application/pkix-crl",
  delta: "application/pkix-crl",
};

const PEM_CONTENT_TYPE = "application/x-pem-file";

export const IMMUTABLE = "public, max-age=31536000, immutable";

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
