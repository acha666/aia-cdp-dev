/**
 * Runs the built Worker (`dist/worker`) locally with wrangler and checks configuration,
 * downloads (`scripts/smoke.sh`) and CRL uploads against it.
 *
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { main, processIo } from "../src/cli/aia.ts";
import { encodeJson } from "../src/core/catalog.ts";
import { cert, crlEntry, fixture, fixturePath } from "../tests/fixtures/pki.ts";
import { configFor } from "../tests/helpers/catalog.ts";

process.env.WRANGLER_SEND_METRICS = "false";
process.env.WRANGLER_HIDE_BANNER = "true";
const { createTestHarness } = await import("wrangler");

const root = fileURLToPath(new URL("..", import.meta.url));

const ADMIN_TOKEN = `smoke-${crypto.randomUUID()}`;
const UPLOAD_TOKEN = `smoke-upload-${crypto.randomUUID()}`;

let failed = false;

function check(ok: boolean, description: string): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${description}`);
  failed ||= !ok;
}

async function json(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: { text: text.slice(0, 300) } };
  }
}

async function configure(base: URL): Promise<string> {
  const config = configFor(["root-ca", "issuing-ca-1"]);

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
  const smoke = spawn("bash", [`${root}scripts/smoke.sh`, base.origin], {
    stdio: "inherit",
    env: { ...process.env, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
  });
  const [code] = (await once(smoke, "close")) as [number | null];
  check(code === 0, `scripts/smoke.sh ${base.origin}`);
}

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
