// CRL version keys (written by ./publish.ts) and a target's history. A version is history when it
// has a marker (a superseded current) or is the catalog's current; a blob with neither is an orphan
// of a lost publish race or a crash and is not listed. The catalog is read before the lists: a
// publish writes the blob and the marker before the catalog and nothing removes them, so the lists
// hold every version that catalog names.
import { z } from "zod";
import { CrlSummarySchema, readState, Sha256Hex, Size, TargetId } from "./catalog.ts";
import type { CrlSummary } from "./catalog.ts";
import { formatGeneralizedTime } from "./pki/asn1.ts";
import { readBlob } from "./store.ts";
import type { ObjectStore } from "./store.ts";

// Store layout ------------------------------------------------------------------------------------

/**
 * `<YYYYMMDDHHMMSSZ of thisUpdate>-<crlNumber or "none">-<sha256>`, shared by blob and marker. The
 * fixed-width time first makes a `list` sort by thisUpdate; the number spares reading the blobs.
 */
export function crlVersionName(
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  const time = formatGeneralizedTime(new Date(summary.thisUpdate));
  return `${time}-${summary.crlNumber ?? "none"}-${sha256}`;
}

const VERSION_NAME =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z-(0|[1-9][0-9]*|none)-([0-9a-f]{64})$/;

/**
 * Returns undefined for a name of another shape (only an out-of-band write makes one). `thisUpdate`
 * is in the catalog's format exactly, since CRL times are whole seconds.
 */
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

/** Store key of a published CRL's DER; current and history share it. */
export function crlBlobKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `${crlBlobPrefix(targetId)}${crlVersionName(summary, sha256)}${BLOB_EXTENSION}`;
}

/** Named like its blob, so that a `list` of both prefixes pairs them without reading either. */
export function crlHistoryKey(
  targetId: string,
  summary: Pick<CrlSummary, "thisUpdate" | "crlNumber">,
  sha256: string
): string {
  return `${crlHistoryPrefix(targetId)}${crlVersionName(summary, sha256)}${MARKER_EXTENSION}`;
}

// Returns "" (which is no version name) for a key with another extension.
function versionName(key: string, prefix: string, extension: string): string {
  return key.endsWith(extension) ? key.slice(prefix.length, -extension.length) : "";
}

// History -----------------------------------------------------------------------------------------

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

/** GET /api/v1/admin/crls/{targetId}/history. */
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

/** An entry with the key of its blob, which never leaves this module. */
type StoredEntry = HistoryEntry & { key: string };

// A CRL without a number sorts below any number.
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

/**
 * The history of a target, also of one removed from config.json; not_found for a target that is
 * neither configured nor has a history. Throws when the catalog's current has no blob.
 */
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

/**
 * The DER of the target's history entry `sha256` as stored, like a download (the key is
 * content-addressed); not_found when its history has no such entry.
 */
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
