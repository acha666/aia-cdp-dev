// Smoke test of the Worker exactly as `wrangler deploy --dry-run --outdir dist/worker` built it,
// served in-process by wrangler's createTestHarness (random port, isolated storage). Part of
// `pnpm run ci:worker`, which builds dist/web and dist/worker first.
//
//   node scripts/worker-smoke.ts          (pnpm run smoke:worker)
//
// Health is "degraded" on the empty store. The CLI's main, as seed-dev and docker-smoke use it
// (both tokens are harness secrets), imports certs/root-ca.der and certs/issuing-ca-1.der and
// applies the configuration configFor builds: each CA at /ca/<name>.crt, with a full CRL target
// at /crl/<name>.crl. Then scripts/smoke.sh runs against it (health "healthy",
// downloads, the root's ECDSA P-384 CRL upload, the reads, the UI). The uploads after it verify
// signatures on workerd's WebCrypto, not only Node's: RSA PKCS#1 v1.5, RSASSA-PSS and SHA-1
// (issuing-ca-1) and a broken RSA signature (422 invalid_signature); without the upload token an
// upload is 401. Last, issuing-ca-1's target detail shows what the uploads left.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { main, processIo } from "../src/cli/aia.ts";
import { encodeJson } from "../src/core/catalog.ts";
import { cert, crlEntry, fixture, fixturePath } from "../tests/fixtures/pki.ts";
import { configFor } from "../tests/helpers/catalog.ts";

// Before wrangler is loaded: no telemetry, no banner or update check.
process.env.WRANGLER_SEND_METRICS = "false";
process.env.WRANGLER_HIDE_BANNER = "true";
const { createTestHarness } = await import("wrangler");

const root = fileURLToPath(new URL("..", import.meta.url));

// Fresh for every run and never printed; letters, digits and `-` satisfy the b64token rule.
const ADMIN_TOKEN = `smoke-${crypto.randomUUID()}`;
const UPLOAD_TOKEN = `smoke-upload-${crypto.randomUUID()}`;

let failed = false;

function check(ok: boolean, description: string): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${description}`);
  failed ||= !ok;
}

/** The status and the JSON body of a response ({ text: its first 300 characters } if not JSON). */
async function json(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: { text: text.slice(0, 300) } };
  }
}

/** Imports the two CAs and applies the configuration; returns issuing-ca-1's target id. */
async function configure(base: URL): Promise<string> {
  const config = configFor(["root-ca", "issuing-ca-1"]);

  // As in seed-dev, the CLI reads the configuration as a file that never touches the disk. The
  // harness listens on a loopback host, so the admin token may go over http://.
  const file = "<worker-smoke config>";
  const io = processIo();
  const cli = {
    ...io,
    env: { AIA_URL: base.origin, AIA_ADMIN_TOKEN: ADMIN_TOKEN },
    readFile: (path: string) =>
      path === file ? Promise.resolve(encodeJson(config)) : io.readFile(path),
  };
  const ders = ["root-ca", "issuing-ca-1"].map((name) => fixturePath(cert(name).der));
  check((await main(["import", ...ders], cli)) === 0, "aia import (root-ca, issuing-ca-1)");
  check((await main(["config", "apply", file], cli)) === 0, "aia config apply");
  const path = config.paths["/crl/issuing-ca-1.crl"];
  return path !== undefined && "target" in path ? path.target : "";
}

async function smokeScript(base: URL): Promise<void> {
  // Not spawnSync: a blocked event loop never sees workerd close the idle keep-alive connection
  // of the health request, and the next fetch would be sent on it ("other side closed").
  const smoke = spawn("bash", [`${root}scripts/smoke.sh`, base.origin], {
    stdio: "inherit",
    env: { ...process.env, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
  });
  const [code] = (await once(smoke, "close")) as [number | null];
  check(code === 0, `scripts/smoke.sh ${base.origin}`);
}

// In order: each row expects the state the rows before it left.
const UPLOADS = [
  { file: "crls/issuing-ca-1/full-01.der", status: 201, result: "created" },
  { file: "crls/issuing-ca-1/full-pss.der", status: 200, result: "updated" },
  { file: "crls/issuing-ca-1/full-sha1.der", status: 200, result: "updated" },
  { file: "crls/issuing-ca-1/full-broken-sig.der", status: 422, result: "invalid_signature" },
];

async function publish(base: URL, target: string): Promise<void> {
  const url = new URL("/api/v1/crls", base);
  const upload = (file: string, headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/pkix-crl", ...headers },
      body: fixture(file),
    });

  const anonymous = await upload("crls/issuing-ca-1/full-01.der", {});
  await anonymous.arrayBuffer();
  check(
    anonymous.status === 401 && anonymous.headers.get("WWW-Authenticate") !== null,
    `POST /api/v1/crls without the upload token: ${anonymous.status}`
  );

  for (const { file, status, result } of UPLOADS) {
    const res = await json(await upload(file, { Authorization: `Bearer ${UPLOAD_TOKEN}` }));
    const error = res.body.error as { code?: unknown } | undefined;
    const ok =
      res.status === status &&
      (status === 422
        ? error?.code === result
        : res.body.outcome === result &&
          res.body.target === target &&
          res.body.sha256 === crlEntry(file).sha256);
    const got = ok ? result : JSON.stringify(res.body).slice(0, 300);
    check(ok, `POST /api/v1/crls ${file}: ${res.status} ${got}`);
  }

  // The target's current CRL after the uploads: crls/issuing-ca-1/full-sha1, as stored.
  const crl = crlEntry("crls/issuing-ca-1/full-sha1.der");
  const res = await fetch(new URL(`/api/v1/blobs/${crl.sha256}`, base));
  const bytes = new Uint8Array(await res.arrayBuffer());
  check(
    res.status === 200 && bytes.byteLength === fixture(crl.file).byteLength,
    `GET /api/v1/blobs/${crl.sha256}: ${res.status}, ${bytes.byteLength} bytes of ${crl.file}`
  );
}

const server = createTestHarness({
  root,
  workers: [
    {
      configPath: "./wrangler.jsonc",
      prebuiltWorkerDir: "./dist/worker",
      secrets: { AIA_ADMIN_TOKEN: ADMIN_TOKEN, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
    },
  ],
});
try {
  const { url } = await server.listen();
  console.log(`worker-smoke: dist/worker listening on ${url.origin}`);
  // Each harness gets fresh storage, so the configuration is always missing here.
  const health = await json(await fetch(new URL("/api/v1/health", url)));
  check(
    health.status === 200 && health.body.status === "degraded",
    `health is degraded: ${health.status}`
  );
  const target = await configure(url);
  await smokeScript(url);
  await publish(url, target);
} finally {
  await server.close();
}
process.exitCode = failed ? 1 : 0;
