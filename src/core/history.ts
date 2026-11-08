import { z } from "zod";
import { CrlSummarySchema, readState, Sha256Hex, Size, TargetId } from "./catalog.ts";
import type { CrlSummary } from "./catalog.ts";
import { formatGeneralizedTime } from "./pki/asn1.ts";
import { readBlob } from "./store.ts";
import type { ObjectStore } from "./store.ts";

export function crlVersionName(
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  const time = formatGeneralizedTime(new Date(summary.thisUpdate));
  return `${time}-${summary.crlNumber ?? "none"}-${sha256}`;
}

const VERSION_NAME =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z-(0|[1-9][0-9]*|none)-([0-9a-f]{64})$/;

function parseCrlVersionName(
  name: string
): { thisUpdate: string; crlNumber: string | null; sha256: string } | undefined {
  const match = VERSION_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, crlNumber, sha256 = ""] = match;
  return {
    thisUpdate: `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`,
    crlNumber: crlNumber === "none" || crlNumber === undefined ? null : crlNumber,
    sha256,
  };
}

const BLOB_EXTENSION = ".der";
const MARKER_EXTENSION = ".json";

const crlBlobPrefix = (targetId: string) => `blobs/crls/${targetId}/`;
const crlHistoryPrefix = (targetId: string) => `history/${targetId}/`;

export function crlBlobKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `${crlBlobPrefix(targetId)}${crlVersionName(summary, sha256)}${BLOB_EXTENSION}`;
}

export function crlHistoryKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `${crlHistoryPrefix(targetId)}${crlVersionName(summary, sha256)}${MARKER_EXTENSION}`;
}

function versionName(key: string, prefix: string, extension: string): string {
  return key.endsWith(extension) ? key.slice(prefix.length, -extension.length) : "";
}

const CrlHistoryEntry = z
  .object({
    sha256: Sha256Hex,
    crlNumber: CrlSummarySchema.shape.crlNumber,
    thisUpdate: CrlSummarySchema.shape.thisUpdate,
    size: Size,
    current: z
      .boolean()
      .describe("The version the target serves: its current CRL, while it is in config.json"),
  })
  .meta({ id: "CrlHistoryEntry" });

export const CrlHistory = z
  .object({
    targetId: TargetId,
    configured: z
      .boolean()
      .describe("false once the target was removed from config.json: nothing serves it"),
    entries: z.array(CrlHistoryEntry).describe("Newest first: by thisUpdate, then CRL Number"),
  })
  .meta({ id: "CrlHistory" });

export type HistoryEntry = z.infer<typeof CrlHistoryEntry>;
export type TargetHistory = z.infer<typeof CrlHistory>;

type StoredEntry = HistoryEntry & { key: string };

function numberOrder(crlNumber: string | null): bigint {
  return crlNumber === null ? -1n : BigInt(crlNumber);
}

function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
  if (a.thisUpdate !== b.thisUpdate) {
    return a.thisUpdate < b.thisUpdate ? 1 : -1;
  }
  const [x, y] = [numberOrder(a.crlNumber), numberOrder(b.crlNumber)];
  return x === y ? 0 : x < y ? 1 : -1;
}

async function storedHistory(
  store: ObjectStore,
  targetId: string
): Promise<{ configured: boolean; entries: StoredEntry[] } | undefined> {
  const blobPrefix = crlBlobPrefix(targetId);
  const markerPrefix = crlHistoryPrefix(targetId);
  const { config, catalog } = await readState(store);
  const [blobs, markers] = await Promise.all([store.list(blobPrefix), store.list(markerPrefix)]);
  const configured = config.targets[targetId] !== undefined;
  const current = catalog.targets[targetId]?.current ?? null;
  const marked = new Set(
    markers.map(({ key }) => versionName(key, markerPrefix, MARKER_EXTENSION))
  );

  const entries: StoredEntry[] = [];
  for (const { key, size } of blobs) {
    const version = versionName(key, blobPrefix, BLOB_EXTENSION);
    const fields = parseCrlVersionName(version);
    const isCurrent = key === current?.key;
    if (fields !== undefined && (isCurrent || marked.has(version))) {
      entries.push({ ...fields, size, current: isCurrent && configured, key });
    }
  }
  if (current !== null && !entries.some((entry) => entry.key === current.key)) {
    throw new Error(`The store has no blob ${current.key}`);
  }
  if (!configured && entries.length === 0) {
    return undefined;
  }
  return { configured, entries: entries.sort(newestFirst) };
}

export async function listHistory(
  deps: { store: ObjectStore },
  targetId: string
): Promise<TargetHistory | { error: "not_found" }> {
  const history = await storedHistory(deps.store, targetId);
  if (history === undefined) {
    return { error: "not_found" };
  }
  const entries = history.entries.map(({ key: _key, ...entry }) => entry);
  return { targetId, configured: history.configured, entries };
}

export async function getHistoryBlob(
  deps: { store: ObjectStore },
  targetId: string,
  sha256: string
): Promise<{ entry: HistoryEntry; der: Uint8Array<ArrayBuffer> } | { error: "not_found" }> {
  const found = (await storedHistory(deps.store, targetId))?.entries.find(
    (entry) => entry.sha256 === sha256
  );
  if (found === undefined) {
    return { error: "not_found" };
  }
  const { key, ...entry } = found;
  return { entry, der: await readBlob(deps.store, key) };
}
