/**
 * Fills a running development server (`AIA_URL`) with the test PKI: imports the CA
 * certificates, applies a config if there is none, and publishes some CRLs.
 *
 * @packageDocumentation
 */

import process from "node:process";
import { emptyConfig, encodeJson } from "../src/core/catalog.ts";
import type { Config } from "../src/core/catalog.ts";
import type { HealthReport } from "../src/core/health.ts";
import { main, processIo } from "../src/cli/aia.ts";
import { cert, fixturePath } from "../tests/fixtures/pki.ts";

interface Ca {
  name: string;
  label: string;
  delta: boolean;
}

const CRLS = [
  "crls/root-ca/full-01.der",
  "crls/issuing-ca-1/full-adcs.der",
  "crls/issuing-ca-1/delta-adcs.der",
  "crls/issuing-ca-2/full-01.der",
];

const CAS: Ca[] = [
  { name: "root-ca", label: "Example Root CA", delta: false },
  { name: "issuing-ca-1", label: "Example Issuing CA 01", delta: true },
  { name: "issuing-ca-2", label: "Example Issuing CA 02", delta: true },
];

function seedConfig(): Config {
  const config = emptyConfig();
  for (const ca of CAS) {
    const id = cert(ca.name).sha256;
    config.certificates[id] = { label: ca.label };
    config.paths[`/ca/${ca.name}.crt`] = { certificate: id };
    const full = crypto.randomUUID();
    config.targets[full] = { issuer: id, kind: "full", label: ca.label };
    config.paths[`/crl/${ca.name}.crl`] = { target: full };
    if (ca.delta) {
      const delta = crypto.randomUUID();
      config.targets[delta] = { issuer: id, kind: "delta", label: `${ca.label} (delta)` };
      config.paths[`/dcrl/${ca.name}.crl`] = { target: delta };
    }
  }
  return config;
}

async function seed(): Promise<number> {
  const io = processIo();

  process.stdout.write("seed-dev: importing certificates\n");
  const imported = await main(
    ["import", ...CAS.map((ca) => fixturePath(`certs/${ca.name}.der`))],
    io
  );
  if (imported !== 0) {
    return imported;
  }

  const res = await fetch(new URL("/api/v1/health", process.env.AIA_URL));
  const { checks } = (await res.json()) as HealthReport;
  if (checks.configuration === "missing") {
    const generated = "<seed-dev config>";
    const bytes = encodeJson(seedConfig());
    process.stdout.write("seed-dev: applying a configuration\n");
    const applied = await main(["config", "apply", generated], {
      ...io,
      readFile: (path) => (path === generated ? Promise.resolve(bytes) : io.readFile(path)),
    });
    if (applied !== 0) {
      return applied;
    }
  } else if (checks.configuration === "ok") {
    process.stdout.write("seed-dev: config.json exists, not applied (pnpm run reset:dev)\n");
  } else {
    process.stderr.write(
      `seed-dev: health reports store ${checks.store}, configuration ${checks.configuration}\n`
    );
    return 1;
  }

  process.stdout.write("seed-dev: publishing CRLs\n");
  return main(["publish", ...CRLS.map((file) => fixturePath(file))], io);
}

process.exitCode = await seed();
