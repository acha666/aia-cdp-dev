/**
 * The CLI subcommands. Each returns its exit code and prints text, or JSON with `--json`.
 *
 * @packageDocumentation
 */

import type { z } from "zod";
import { validateConfig } from "../core/admin.ts";
import type { ConfigIssue } from "../core/admin.ts";
import { decodeJson } from "../core/catalog.ts";
import type { CertificateReference } from "../core/certificates.ts";
import type { HealthReport } from "../core/health.ts";
import type { TargetHistory } from "../core/history.ts";
import { isDerSequence, splitPemBlocks } from "../core/pki/pem.ts";
import type { ImportedCertificate, PublishedCrl } from "../http/schemas.ts";
import { createClient, describeHttp, Failure, readBytes, reasonOf } from "./client.ts";
import type { Api, CliIo, Context, HttpError } from "./client.ts";

function output(ctx: Context, value: unknown, text: string): void {
  ctx.io.stdout(ctx.json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

/** Formats a JSON path like `paths["/ca/root.crt"].certificate`. */
function pathText(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "(document)";
  }
  return path
    .map((key, index) => {
      if (typeof key === "string" && /^[A-Za-z]+$/.test(key)) {
        return index === 0 ? key : `.${key}`;
      }
      return `[${JSON.stringify(key)}]`;
    })
    .join("");
}

function issuesText(title: string, issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => `  ${issue.rule}  ${pathText(issue.path)}: ${issue.message}`);
  const count = `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
  return `${title} (${count}):\n${lines.join("\n")}\n`;
}

interface Where {
  file: string;
  block?: number;
}

type ItemFailure = Where & { ok: false; error: { message: string } & Partial<HttpError> };

type Uploaded = z.infer<typeof ImportedCertificate> | z.infer<typeof PublishedCrl>;
type ItemResult = (Where & { ok: true } & Uploaded) | ItemFailure;

function failedItem(where: Where, error: unknown): ItemFailure {
  if (!(error instanceof Failure)) {
    throw error;
  }
  return { ...where, ok: false, error: { message: error.message } };
}

type UploadBody = Uint8Array | string;

/** Formats error details for one line of output; `reason` is already in the message. */
function detailsText(details: unknown): string {
  if (typeof details !== "object" || details === null) {
    return "";
  }
  const parts = Object.entries(details).flatMap(([key, value]) => {
    if (key === "reason") {
      return [];
    }
    const current = value as { crlNumber?: unknown; thisUpdate?: unknown } | null;
    if (key === "current" && typeof current?.thisUpdate === "string") {
      const number =
        typeof current.crlNumber === "string" ? `CRL Number ${current.crlNumber}` : "no CRL Number";
      return [`current: ${number}, thisUpdate ${current.thisUpdate}`];
    }
    return [`${key} ${typeof value === "string" ? value : JSON.stringify(value)}`];
  });
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

async function postItem(
  api: Api,
  path: string,
  where: Where,
  body: UploadBody
): Promise<ItemResult> {
  try {
    const reply = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    if (reply.status !== 200 && reply.status !== 201) {
      const error = reply.error();
      const message = `${describeHttp(error)}${detailsText(error.details)}`;
      return { ...where, ok: false, error: { ...error, message } };
    }
    return { ...where, ok: true, ...reply.json<Uploaded>() };
  } catch (error) {
    return failedItem(where, error);
  }
}

/**
 * Imports certificates or publishes CRLs, one request per certificate or CRL. A failure
 * does not stop the remaining files.
 *
 * @returns 0 if every upload succeeded, else 1.
 */
export async function uploadFiles(
  ctx: Context,
  files: readonly string[],
  kind: "certificate" | "crl"
): Promise<number> {
  const importing = kind === "certificate";
  const api = await createClient(ctx, importing ? "admin" : "upload");
  const path = importing ? "/admin/certificates" : "/crls";
  const outcomes = importing ? ["created", "unchanged"] : ["created", "updated", "unchanged"];
  const results: ItemResult[] = [];
  const summary = Object.fromEntries([...outcomes, "failed"].map((key) => [key, 0]));
  const report = (result: ItemResult, source: string) => {
    const outcome = result.ok ? result.outcome : "failed";
    summary[outcome] = (summary[outcome] ?? 0) + 1;
    if (ctx.json) {
      results.push(result);
    } else if (result.ok) {
      const text =
        "id" in result
          ? `${result.id}  ${result.summary.subjectCN ?? "(no CN)"}`
          : `${result.target}  ${result.kind} ${result.crlNumber === null ? "(no CRL Number)" : `#${result.crlNumber}`}`;
      ctx.io.stdout(`${outcome.padEnd(10)} ${text}  ${source}\n`);
    } else {
      ctx.io.stderr(`failed     ${source}: ${result.error.message}\n`);
    }
  };
  for (const file of files) {
    let bodies: UploadBody[];
    try {
      const bytes = await readBytes(
        ctx.io,
        file,
        (reason) => new Failure(`cannot read the file: ${reason}`)
      );
      bodies = importing ? certificateBodies(bytes) : [bytes];
    } catch (error) {
      report(failedItem({ file }, error), file);
      continue;
    }
    for (const [index, body] of bodies.entries()) {
      const where = { file, ...(typeof body === "string" ? { block: index + 1 } : {}) };
      const source = bodies.length > 1 ? `${file} [block ${index + 1}/${bodies.length}]` : file;
      report(await postItem(api, path, where, body), source);
    }
  }
  const counts = Object.entries(summary).map(([outcome, count]) => `${count} ${outcome}`);
  output(ctx, { results, ...summary }, `${counts.join(", ")}\n`);
  return summary.failed === 0 ? 0 : 1;
}

/** The API takes one certificate per request, so a PEM bundle is split into its blocks. */
function certificateBodies(bytes: Uint8Array): UploadBody[] {
  const text = new TextDecoder().decode(bytes);
  if (isDerSequence(bytes) || !text.includes("-----BEGIN ")) {
    return [bytes];
  }
  let blocks: string[];
  try {
    blocks = splitPemBlocks(text, "certificate");
  } catch (error) {
    throw new Failure(reasonOf(error));
  }
  if (blocks.length === 0) {
    throw new Failure("no CERTIFICATE PEM block");
  }
  return blocks;
}

export async function configShow(ctx: Context): Promise<number> {
  const api = await createClient(ctx);
  const reply = await api("/admin/config");
  if (reply.status === 404) {
    throw new Failure("nothing has been configured yet (HTTP 404)");
  }
  const { headers, text } = reply.check();
  const etag = headers.get("ETag");
  let config: unknown = null;
  if (ctx.json) {
    try {
      config = JSON.parse(text);
    } catch {
      throw new Failure("the stored config.json is not JSON: run without --json to see it as is");
    }
  }
  output(ctx, { etag, config }, text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

async function loadConfigFile(io: CliIo, file: string): Promise<unknown> {
  const fail = (reason: string) => new Failure(`cannot read ${file}: ${reason}`);
  const bytes = await readBytes(io, file, fail);
  try {
    return decodeJson(bytes);
  } catch (error) {
    throw new Failure(`${file} is not JSON: ${reasonOf(error)}`);
  }
}

/** Runs the checks that need no service; the rest happen on apply. */
export async function configValidate(ctx: Context, file: string): Promise<number> {
  const checked = validateConfig(await loadConfigFile(ctx.io, file));
  if (!ctx.json && !checked.ok) {
    ctx.io.stderr(issuesText(`${file} is invalid`, checked.issues));
  } else {
    output(
      ctx,
      checked.ok ? { ok: true } : { ok: false, issues: checked.issues },
      `${file}: valid offline (V1-V3, static parts of V4 / V6); ` +
        "the service checks the catalog and current-config rules (V4-V9) on apply\n"
    );
  }
  return checked.ok ? 0 : 1;
}

/** Validates locally, then replaces the stored config conditionally on its current ETag. */
export async function configApply(ctx: Context, file: string): Promise<number> {
  const checked = validateConfig(await loadConfigFile(ctx.io, file));
  if (!checked.ok) {
    ctx.io.stderr(issuesText(`${file} is invalid, nothing was sent`, checked.issues));
    return 1;
  }
  const api = await createClient(ctx);
  const current = await api("/admin/config");
  let precondition: Record<string, string>;
  if (current.status === 404) {
    precondition = { "If-None-Match": "*" };
  } else if (current.ok) {
    const etag = current.headers.get("ETag");
    if (etag === null) {
      throw new Failure(`GET ${current.url} answered without an ETag`);
    }
    precondition = { "If-Match": etag };
  } else {
    throw new Failure(`cannot read the current configuration: ${describeHttp(current.error())}`);
  }

  const reply = await api("/admin/config", {
    method: "PUT",
    headers: { ...precondition, "Content-Type": "application/json" },
    body: JSON.stringify(checked.config),
  });
  if (reply.status === 200) {
    const etag = reply.headers.get("ETag");
    const config = reply.json();
    output(ctx, { etag, config }, `applied ${file} (ETag ${etag ?? "missing"})\n`);
    return 0;
  }
  const error = reply.error();
  if (reply.status === 412) {
    throw new Failure(
      `${describeHttp(error)}\nconfig.json changed after it was read (another apply?): ` +
        'review it with "aia config show" and apply again'
    );
  }
  if (reply.status === 422 && error.code === "config_invalid") {
    const { issues } = error.details as { issues: ConfigIssue[] };
    ctx.io.stderr(issuesText(`the service rejected ${file}: ${describeHttp(error)}`, issues));
    return 1;
  }
  throw new Failure(describeHttp(error));
}

function historyPath(targetId: string): string {
  return `/admin/crls/${encodeURIComponent(targetId)}/history`;
}

export async function listHistory(ctx: Context, targetId: string): Promise<number> {
  const api = await createClient(ctx);
  const reply = await api(historyPath(targetId));
  const history = reply.check().json<TargetHistory>();
  const numbers = history.entries.map((entry) =>
    entry.crlNumber === null ? "(no CRL Number)" : `#${entry.crlNumber}`
  );
  const width = Math.max(0, ...numbers.map((number) => number.length));
  const lines = history.entries.map((entry, index) => {
    const line = [
      entry.thisUpdate,
      (numbers[index] ?? "").padEnd(width),
      entry.sha256,
      `${entry.size} B`,
      entry.current ? "current" : "",
    ];
    return `${line.join("  ").trimEnd()}\n`;
  });
  const count = `${history.entries.length} version${history.entries.length === 1 ? "" : "s"}`;
  const removed = history.configured ? "" : "; the target is not in config.json (retired)";
  output(ctx, history, `${lines.join("")}${count}${removed}\n`);
  return 0;
}

export async function historyVersion(
  ctx: Context,
  targetId: string,
  sha256: string,
  file: string
): Promise<number> {
  const api = await createClient(ctx);
  const reply = await api(`${historyPath(targetId)}/${encodeURIComponent(sha256)}`);
  const der = reply.check().bytes;
  try {
    await ctx.io.writeFile(file, der);
  } catch (error) {
    throw new Failure(`cannot write ${file}: ${reasonOf(error)}`);
  }
  output(ctx, { file, size: der.byteLength }, `wrote ${file} (${der.byteLength} B)\n`);
  return 0;
}

export async function deleteCertificate(ctx: Context, id: string): Promise<number> {
  const api = await createClient(ctx);
  const reply = await api(`/admin/certificates/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (reply.status === 204) {
    output(ctx, { deleted: id }, `deleted ${id}\n`);
    return 0;
  }
  const error = reply.error();
  if (error.code === "referenced") {
    const { references } = error.details as { references: CertificateReference[] };
    const lines = references.map(
      (reference) => `  ${reference.object} ${pathText(reference.path)}`
    );
    ctx.io.stderr(`aia: ${describeHttp(error)}\n${lines.join("\n")}\n`);
    return 1;
  }
  throw new Failure(describeHttp(error));
}

export function newTargetId(ctx: Context): number {
  const id = crypto.randomUUID();
  output(ctx, { id }, `${id}\n`);
  return 0;
}

/** @returns 0 only if the service reports `healthy`. */
export async function health(ctx: Context): Promise<number> {
  const api = await createClient(ctx, "public");
  const reply = await api("/health");
  const hasReport = reply.status === 200 || reply.status === 503;
  const report = reply.check(hasReport).json<HealthReport>();
  const { store, configuration } = report.checks;
  output(ctx, report, `${report.status}: store ${store}, configuration ${configuration}\n`);
  return report.status === "healthy" ? 0 : 1;
}
