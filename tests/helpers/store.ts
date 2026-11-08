import { CATALOG_KEY } from "../../src/core/catalog.ts";
import type { ObjectStore, PutOptions, PutResult } from "../../src/core/store.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { patchStore } from "./app.ts";

export type StoreWrite =
  { op: "put"; key: string; opts: PutOptions; result: PutResult } | { op: "delete"; key: string };

export interface RecordingStore extends ObjectStore {
  writes: StoreWrite[];
}

/** A store that records every write. */
export function recordingStore(base: ObjectStore = new MemoryStore()): RecordingStore {
  const writes: StoreWrite[] = [];
  return {
    ...patchStore(
      {
        put: async (key, bytes, opts = {}) => {
          const result = await base.put(key, bytes, opts);
          writes.push({ op: "put", key, opts, result });
          return result;
        },
        delete: async (key) => {
          await base.delete(key);
          writes.push({ op: "delete", key });
        },
      },
      base
    ),
    writes,
  };
}

export function puts(store: RecordingStore): { key: string; opts: PutOptions; ok: boolean }[] {
  return store.writes.flatMap((write) =>
    write.op === "put" ? [{ key: write.key, opts: write.opts, ok: write.result.ok }] : []
  );
}

export interface FlakyOptions {
  failIfMatch?: number;
  putError?: Error;
}

/** A store whose first `failIfMatch` conditional writes fail, or whose writes all throw. */
export function flakyStore(base: ObjectStore, options: FlakyOptions): ObjectStore {
  let failures = options.failIfMatch ?? 0;
  return patchStore(
    {
      put: async (key, bytes, opts) => {
        if (options.putError !== undefined) {
          throw options.putError;
        }
        if (opts?.ifMatch !== undefined && failures > 0) {
          failures--;
          return { ok: false, reason: "precondition-failed" };
        }
        return base.put(key, bytes, opts);
      },
    },
    base
  );
}

/** A store that runs `rival` just before the first catalog write. */
export function racingStore(base: ObjectStore, rival: () => Promise<unknown>): ObjectStore {
  let raced = false;
  return patchStore(
    {
      put: async (key, bytes, opts) => {
        if (key === CATALOG_KEY && !raced) {
          raced = true;
          await rival();
        }
        return base.put(key, bytes, opts);
      },
    },
    base
  );
}

/** A store whose ETags are not content hashes, like R2's. */
export function opaqueEtagStore(base: ObjectStore = new MemoryStore()): ObjectStore {
  const wrap = (etag: string) => `store:${etag}`;
  return patchStore(
    {
      get: async (key) => {
        const object = await base.get(key);
        return object === null ? null : { ...object, etag: wrap(object.etag) };
      },
      put: async (key, bytes, opts = {}) => {
        const { ifMatch } = opts;
        const inner =
          ifMatch === undefined || ifMatch.startsWith("store:")
            ? ifMatch?.slice("store:".length)
            : `foreign:${ifMatch}`;
        const result = await base.put(key, bytes, {
          ...opts,
          ...(inner === undefined ? {} : { ifMatch: inner }),
        });
        return result.ok ? { ok: true, etag: wrap(result.etag) } : result;
      },
    },
    base
  );
}
