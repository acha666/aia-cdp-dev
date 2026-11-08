import { describe, expect, it } from "vitest";
import { readState } from "../../src/core/catalog.ts";
import { downloadHeaders, resolveDownload } from "../../src/core/resources.ts";
import type { DownloadResolution, FoundDownload } from "../../src/core/resources.ts";
import { MemoryStore } from "../../src/storage/memory.ts";
import { cert, NOW } from "../fixtures/pki.ts";
import { publishFile, setupPublish } from "../helpers/publish.ts";

const HOUR = 3_600_000;
const ROOT = cert("root-ca");
const ROOT_PATH = "/ca/root-ca.crt";
const FULL_PATH = "/crl/issuing-ca-1.crl";

const store = new MemoryStore();
const setup = await setupPublish(store, {
  configure: (config) => {
    config.paths[ROOT_PATH] = { certificate: ROOT.sha256 };
  },
});
await publishFile(store, "crls/issuing-ca-1/full-01.der");
const { config, catalog } = await readState(store);
const fullTarget = setup.target("issuing-ca-1", "full");

function found(resolution: DownloadResolution): FoundDownload {
  if (resolution.status !== "found") {
    throw new Error(`expected found, got ${JSON.stringify(resolution)}`);
  }
  return resolution;
}

describe("resolveDownload", () => {
  it("reports a path entry the catalog or config.targets cannot back as inconsistent", () => {
    const { [ROOT.sha256]: _root, ...certificates } = catalog.certificates;
    expect(resolveDownload(config, { ...catalog, certificates }, `${ROOT_PATH}.pem`)).toEqual({
      status: "inconsistent",
      reference: { certificate: ROOT.sha256 },
    });
    const { [fullTarget]: _full, ...rest } = config.targets;
    expect(resolveDownload({ ...config, targets: rest }, catalog, FULL_PATH)).toEqual({
      status: "inconsistent",
      reference: { target: fullTarget },
    });
  });
});

it("counts a CRL's max-age in whole seconds until nextUpdate, within [60, 3600], 300 without", () => {
  const download = found(resolveDownload(config, catalog, FULL_PATH));
  const maxAge = (seconds: number) => `public, max-age=${seconds}, must-revalidate`;
  const nextUpdate = download.nextUpdate?.getTime() ?? Number.NaN;
  const cases: [msBefore: number, seconds: number][] = [
    [-HOUR, 60],
    [0, 60],
    [60_999, 60],
    [61_000, 61],
    [1_234_900, 1234],
    [3_600_000, 3600],
    [3_601_000, 3600],
  ];
  for (const [ms, seconds] of cases) {
    const now = new Date(nextUpdate - ms);
    expect(downloadHeaders(download, now)["Cache-Control"], `${ms} ms`).toBe(maxAge(seconds));
  }
  expect(downloadHeaders({ ...download, nextUpdate: null }, NOW)["Cache-Control"]).toBe(
    maxAge(300)
  );
});
