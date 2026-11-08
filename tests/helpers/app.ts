import type { ObjectStore } from "../../src/core/store.ts";
import type { LogRecord } from "../../src/http/log.ts";
import type { AppDeps, AppSettings } from "../../src/http/types.ts";
import { parseSettings } from "../../src/runtime/settings.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { NOW } from "../fixtures/pki.ts";

export const MINIMAL_CONFIG = '{"version":1,"certificates":{},"targets":{},"paths":{}}';

function defaultSettings(): AppSettings {
  const parsed = parseSettings({});
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value.app;
}

export interface TestDeps extends AppDeps {
  lines: string[];
}

export interface TestOverrides extends Partial<Omit<AppDeps, "settings">> {
  settings?: Partial<AppSettings>;
}

export function testDeps(overrides: TestOverrides = {}): TestDeps {
  const lines: string[] = [];
  return {
    store: new MemoryStore(),
    now: () => new Date(NOW),
    sleep: async () => undefined,
    log: (record) => {
      lines.push(JSON.stringify(record));
    },
    ...overrides,
    settings: { ...defaultSettings(), ...overrides.settings },
    lines,
  };
}

export function logRecords(deps: Pick<TestDeps, "lines">): LogRecord[] {
  return deps.lines.map((line) => JSON.parse(line) as LogRecord);
}

export function patchStore(patch: Partial<ObjectStore>, base: ObjectStore = new MemoryStore()) {
  return {
    get: patch.get ?? ((key) => base.get(key)),
    put: patch.put ?? ((key, bytes, opts) => base.put(key, bytes, opts)),
    list: patch.list ?? ((prefix) => base.list(prefix)),
    delete: patch.delete ?? ((key) => base.delete(key)),
  } satisfies ObjectStore;
}

export async function putText(store: ObjectStore, key: string, text: string): Promise<void> {
  await store.put(key, new TextEncoder().encode(text));
}
