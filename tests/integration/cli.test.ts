import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/cli/aia.ts";
import type { CliIo } from "../../src/cli/aia.ts";
import { CONFIG_KEY, TargetId } from "../../src/core/catalog.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { createApp } from "../../src/http/app.ts";
import { cert, crlEntry, fixture, fixturePath, fixtureText } from "../fixtures/pki.ts";
import { MINIMAL_CONFIG, putText, testDeps } from "../helpers/app.ts";
import type { TestOverrides } from "../helpers/app.ts";
import { configFor } from "../helpers/catalog.ts";
import { setupPublish } from "../helpers/publish.ts";

const TOKEN = "cli-s3cret-token";
const UPLOAD_TOKEN = "cli-upload-s3cret";
const BASE = "https://aia.test";
const ENV = { AIA_URL: BASE, AIA_ADMIN_TOKEN: TOKEN };
const EXAMPLE = fileURLToPath(new URL("../../docs/config.example.json", import.meta.url));
const ROOT_DER = fixturePath(cert("root-ca").der);
const ROOT_CRL = fixturePath("crls/root-ca/full-01.der");
const GARBAGE = fixturePath("invalid/garbage.txt");

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-cli-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function scratchFile(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, content);
  return path;
}

interface Sent {
  method: string;
  url: string;
  headers: Headers;
  bytes: Uint8Array;
}

function service(overrides: TestOverrides = {}) {
  const deps = testDeps({
    ...overrides,
    settings: { adminToken: TOKEN, ...overrides.settings },
  });
  const app = createApp(deps);
  const sent: Sent[] = [];
  const fetch: CliIo["fetch"] = async (url, init) => {
    const request = new Request(url, init);
    sent.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      bytes: new Uint8Array(await request.clone().arrayBuffer()),
    });
    return app.request(request);
  };
  const authorization = () => sent.map((request) => request.headers.get("Authorization"));
  return { deps, fetch, sent, authorization };
}

type Service = ReturnType<typeof service>;

async function publishing(overrides: TestOverrides = {}) {
  const svc = service(overrides);
  const setup = await setupPublish(svc.deps.store);
  return { svc, setup };
}

const offline: CliIo["fetch"] = () => {
  throw new Error("this command must not touch the network");
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function aia(argv: string[], io: Partial<Pick<CliIo, "fetch" | "env">> = {}): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    fetch: io.fetch ?? offline,
    env: io.env ?? {},
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    readFile: (path) => readFile(path),
    writeFile: (path, bytes) => writeFile(path, bytes),
  });
  expect(stdout + stderr).not.toContain(TOKEN);
  expect(stdout + stderr).not.toContain(UPLOAD_TOKEN);
  return { code, stdout, stderr };
}

function against(svc: Service, argv: string[], env: Record<string, string> = ENV) {
  return aia(argv, { fetch: svc.fetch, env });
}

async function configFile(name: string, config: unknown): Promise<string> {
  return scratchFile(name, `${JSON.stringify(config, null, 2)}\n`);
}

async function storedEtag(svc: Service): Promise<string> {
  const stored = await svc.deps.store.get(CONFIG_KEY);
  return `"${await sha256Hex(stored?.bytes ?? new Uint8Array())}"`;
}

describe("usage", () => {
  it.each<[string[], string, string]>([
    [["--help"], "Usage: aia ", "config"],
    [["help"], "Usage: aia ", "publish"],
    [["config", "--help"], "Usage: aia config ", "validate <file>"],
    [["config", "apply", "--help"], "Usage: aia config apply ", "If-None-Match: *"],
    [["help", "history"], "Usage: aia history ", "--out <file>"],
  ])("prints help for %j without service access", async (argv, usage, detail) => {
    const run = await aia(argv);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(usage);
    expect(run.stdout.replace(/\s+/g, " ")).toContain(detail);
    expect(run.stdout).toContain("Exit codes: 0 success, 1 failure or not healthy, 2 usage error.");
  });

  it.each<[string[], Record<string, string>, RegExp]>([
    [[], ENV, /missing command/],
    [["config"], ENV, /missing command/],
    [["config", "apply"], ENV, /missing required argument 'file'/],
    [["health", "extra"], ENV, /too many arguments/],
    [["config", "show", "extra"], ENV, /too many arguments/],
    [["health", "--url"], ENV, /argument missing/],
    [["frobnicate"], ENV, /unknown command 'frobnicate'/],
    [["import"], ENV, /missing required argument 'files'/],
    [["config", "edit"], ENV, /unknown command 'edit'/],
    [["history", "a", "b", "--json"], ENV, /history <targetId> <sha256> needs --out <file>/],
    [["health", "--out", "x"], ENV, /--out is only for history <targetId> <sha256>/],
    [["health", "--nope"], ENV, /unknown option '--nope'/],
    [["health"], { AIA_ADMIN_TOKEN: TOKEN }, /no service URL: pass --url or set AIA_URL/],
    [["import", ROOT_DER], { AIA_URL: BASE }, /no admin token: pass --token-file/],
    [
      ["config", "show"],
      { ...ENV, AIA_ADMIN_TOKEN_FILE: "/unused" },
      /set either AIA_ADMIN_TOKEN or AIA_ADMIN_TOKEN_FILE, not both/,
    ],
    [
      ["publish", ROOT_CRL],
      { AIA_URL: BASE, AIA_UPLOAD_TOKEN: `${UPLOAD_TOKEN}\nX-Injected: 1` },
      /upload token .* has characters a bearer token cannot have/,
    ],
  ])("%j → exit 2", async (argv, env, message) => {
    const run = await aia(argv, { env });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(message);
    expect(run.stderr).toMatch(/Run "aia --help" for usage\.\n$/);
  });

  it("keeps global options before or after nested commands, with no state shared between runs", async () => {
    const svc = service();
    const args = ["--url", BASE, "--json"];
    const before = await aia([...args, "health"], { fetch: svc.fetch });
    const after = await aia(["health", ...args], { fetch: svc.fetch });
    expect(before).toEqual(after);
    expect(before.code).toBe(1);
    expect(JSON.parse(before.stdout)).toMatchObject({ status: "degraded" });

    const nested = await aia(["--json", "config", "--url", BASE, "validate", EXAMPLE]);
    expect(nested.code).toBe(0);
    expect(nested.stderr).toBe("");
    expect(JSON.parse(nested.stdout)).toEqual({ ok: true });
    const text = await aia(["config", "validate", EXAMPLE]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("valid offline");
    expect((await aia(["health"])).code).toBe(2);
  });
});

describe("tokens", () => {
  it("sends a token over plain http:// only to a loopback host or with --allow-insecure-http", async () => {
    const { svc } = await publishing({ settings: { uploadToken: UPLOAD_TOKEN } });
    const at = (url: string, argv: string[]) =>
      aia(argv, {
        fetch: svc.fetch,
        env: { AIA_URL: url, AIA_ADMIN_TOKEN: TOKEN, AIA_UPLOAD_TOKEN: UPLOAD_TOKEN },
      });
    for (const [name, argv] of [
      ["admin", ["import", ROOT_DER]],
      ["upload", ["publish", ROOT_CRL]],
    ] as const) {
      expect(await at("http://pki.example:8080/aia", [...argv])).toEqual({
        code: 2,
        stdout: "",
        stderr:
          `aia: refusing to send the ${name} token over http:// to pki.example:8080: use ` +
          'https://, or pass --allow-insecure-http\nRun "aia --help" for usage.\n',
      });
    }
    expect(svc.sent).toEqual([]);

    const runs = [
      await at("http://localhost:8787", ["import", ROOT_DER]),
      await at("http://127.0.0.1:8787", ["publish", ROOT_CRL]),
      await at("http://pki.example", ["publish", "--allow-insecure-http", ROOT_CRL]),
    ];
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0]);
    expect(svc.authorization()).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${UPLOAD_TOKEN}`,
      `Bearer ${UPLOAD_TOKEN}`,
    ]);
  });

  it("checks nothing without a token: health, and publish to a service that needs none", async () => {
    const { svc } = await publishing();
    const env = { AIA_URL: "http://aia.test" };
    expect((await aia(["health"], { fetch: svc.fetch, env })).stderr).toBe("");
    expect((await aia(["publish", ROOT_CRL], { fetch: svc.fetch, env })).code).toBe(0);
    expect(svc.authorization()).toEqual([null, null]);
  });

  it("reads a token from --token-file, which wins over the variables, or <NAME>_FILE, trimmed", async () => {
    const { svc } = await publishing({ settings: { uploadToken: UPLOAD_TOKEN } });
    const admin = await scratchFile("admin-token", `  ${TOKEN}\r\n\n`);
    const upload = await scratchFile("upload-token", `${UPLOAD_TOKEN}\n`);
    const runs = [
      await against(svc, ["import", "--token-file", admin, ROOT_DER], {
        AIA_URL: BASE,
        AIA_ADMIN_TOKEN: "wrong-token",
      }),
      await against(svc, ["publish", ROOT_CRL], { AIA_URL: BASE, AIA_UPLOAD_TOKEN_FILE: upload }),
    ];
    expect(runs.map((run) => run.code)).toEqual([0, 0]);
    expect(svc.authorization()).toEqual([`Bearer ${TOKEN}`, `Bearer ${UPLOAD_TOKEN}`]);
  });
});

describe("health", () => {
  it("exits 1 when the service cannot be reached, naming the cause", async () => {
    const run = await aia(["health"], {
      env: ENV,
      fetch: () =>
        Promise.reject(
          new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") })
        ),
    });
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "aia: cannot reach https://aia.test/api/v1/health: fetch failed " +
        "(connect ECONNREFUSED 127.0.0.1:1)\n",
    });
  });
});

describe("API client", () => {
  it.each([
    [
      new Response("<html>proxy failed</html>", { status: 502, statusText: "Bad Gateway" }),
      "HTTP 502: Bad Gateway",
    ],
    [new Response("not JSON"), "HTTP 200, but the body is not JSON"],
    [
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body reset"));
          },
        })
      ),
      "cannot read the response from https://aia.test/api/v1/health: body reset",
    ],
  ])("reports response failures without exposing the body", async (response, message) => {
    const run = await aia(["health"], { env: ENV, fetch: async () => response });
    expect(run).toEqual({ code: 1, stdout: "", stderr: `aia: ${message}\n` });
  });

  it("accepts a 503 health report without sending an admin token", async () => {
    const report = { status: "unhealthy", checks: { store: "error", configuration: "unknown" } };
    const run = await aia(["health", "--json"], {
      env: ENV,
      fetch: async (_, init) => {
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        return Response.json(report, { status: 503 });
      },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual(report);
  });

  it("keeps a proxy path prefix and merges authentication with config preconditions", async () => {
    const file = await configFile("proxy-config.json", JSON.parse(MINIMAL_CONFIG));
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const etag = `"${"a".repeat(64)}"`;
    const run = await aia(["config", "apply", file], {
      env: { ...ENV, AIA_URL: `${BASE}/proxy///?ignored=1#ignored` },
      fetch: async (url, init) => {
        calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers) });
        return new Response(MINIMAL_CONFIG, { headers: { ETag: etag } });
      },
    });
    expect(run.code).toBe(0);
    expect(calls.map(({ url, method }) => [url, method])).toEqual([
      [`${BASE}/proxy/api/v1/admin/config`, "GET"],
      [`${BASE}/proxy/api/v1/admin/config`, "PUT"],
    ]);
    expect(calls.map(({ headers }) => headers.get("Authorization"))).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
    expect(calls[1]?.headers.get("If-Match")).toBe(etag);
    expect(calls[1]?.headers.get("Content-Type")).toBe("application/json");
  });

  it("does not write a config when its current ETag is missing", async () => {
    const file = await configFile("missing-etag.json", JSON.parse(MINIMAL_CONFIG));
    let requests = 0;
    const run = await aia(["config", "apply", file], {
      env: ENV,
      fetch: async () => {
        requests++;
        return new Response(MINIMAL_CONFIG);
      },
    });
    expect(requests).toBe(1);
    expect(run).toEqual({
      code: 1,
      stdout: "",
      stderr: `aia: GET ${BASE}/api/v1/admin/config answered without an ETag\n`,
    });
  });

  it("keeps damaged stored config readable as text, while --json reports a failure", async () => {
    const svc = service();
    await putText(svc.deps.store, CONFIG_KEY, "{broken");
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 0,
      stdout: "{broken\n",
      stderr: "",
    });
    const json = await against(svc, ["config", "show", "--json"]);
    expect(json).toEqual({
      code: 1,
      stdout: "",
      stderr: "aia: the stored config.json is not JSON: run without --json to see it as is\n",
    });
  });
});

describe("import", () => {
  it("imports a DER file, then its PEM is unchanged", async () => {
    const svc = service();
    const root = cert("root-ca");
    expect(await against(svc, ["import", ROOT_DER])).toEqual({
      code: 0,
      stdout:
        `created    ${root.sha256}  Example Root CA (ECC P-384)  ${ROOT_DER}\n` +
        "1 created, 0 unchanged, 0 failed\n",
      stderr: "",
    });
    const unchanged = await against(svc, ["import", fixturePath(root.pem)]);
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toMatch(new RegExp(`^unchanged  ${root.sha256}  `));
    expect(svc.authorization()).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("sends each certificate block on its own, isolates failures, and exits 1", async () => {
    const svc = service();
    const badBlock = "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n";
    const key =
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n";
    const issuing = fixtureText(cert("issuing-ca-1").pem);
    const mixed = await scratchFile("mixed.pem", `Chain\n${badBlock}${key}${issuing}`);
    const missing = join(scratch, "missing.der");
    const crlPem = fixturePath("crls/root-ca/full-01.pem");

    const run = await against(svc, ["import", GARBAGE, missing, mixed, crlPem, ROOT_DER]);
    expect(run.code).toBe(1);
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `failed     ${GARBAGE}: HTTP 422 invalid_certificate (der): Not a valid X.509 certificate`,
      expect.stringMatching(new RegExp(`^failed     ${missing}: cannot read the file: ENOENT`)),
      `failed     ${mixed} [block 1/2]: HTTP 422 invalid_certificate (pem_base64): ` +
        "Not a valid X.509 certificate",
      `failed     ${crlPem}: no CERTIFICATE PEM block`,
    ]);
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(
        new RegExp(`^created    ${cert("issuing-ca-1").sha256}  .*  ${mixed} \\[block 2/2\\]$`)
      ),
      expect.stringMatching(new RegExp(`^created    ${cert("root-ca").sha256}  `)),
      "2 created, 0 unchanged, 4 failed",
    ]);
    const pems = svc.sent
      .map((request) => new TextDecoder().decode(request.bytes))
      .filter((text) => text.startsWith("-----BEGIN "));
    expect(pems).toEqual([badBlock, issuing]);
  });
});

describe("config validate", () => {
  it("passes docs/config.example.json offline: no URL, no token, no network", async () => {
    const run = await aia(["config", "validate", EXAMPLE]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^.*config\.example\.json: valid offline \(V1-V3/);
  });

  it("lists every static violation with its rule and path, and exits 1", async () => {
    const id = cert("root-ca").sha256;
    const file = await configFile("broken.json", {
      version: 1,
      certificates: { [id]: { label: "Root" } },
      targets: {},
      paths: {
        "/ca/root.pem": { certificate: id },
        "/crl/missing.crl": { target: crypto.randomUUID() },
      },
    });
    const run = await aia(["config", "validate", file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe(`${file} is invalid (2 issues):`);
    expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
      '  V2  paths["/ca/root.pem"]',
      '  V4  paths["/crl/missing.crl"].target',
    ]);
  });
});

describe("config show", () => {
  it("exits 1 while nothing is configured, then prints the stored bytes, or { etag, config }", async () => {
    const svc = service();
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "aia: nothing has been configured yet (HTTP 404)\n",
    });
    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    expect(await against(svc, ["config", "show"])).toEqual({
      code: 0,
      stdout: `${MINIMAL_CONFIG}\n`,
      stderr: "",
    });
    const json = await against(svc, ["config", "show", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      etag: await storedEtag(svc),
      config: JSON.parse(MINIMAL_CONFIG) as unknown,
    });
  });
});

describe("config apply", () => {
  it("applies the first config with If-None-Match: *, the next with If-Match", async () => {
    const svc = service();
    await against(svc, ["import", ROOT_DER]);
    const config = configFor(["root-ca"]);
    const file = await configFile("first.json", config);

    const first = await against(svc, ["config", "apply", file]);
    expect(first.code).toBe(0);
    const etag = await storedEtag(svc);
    expect(first.stdout).toBe(`applied ${file} (ETag ${etag})\n`);
    const [get, put] = svc.sent.slice(1);
    expect(get).toMatchObject({ method: "GET", url: `${BASE}/api/v1/admin/config` });
    expect(put).toMatchObject({ method: "PUT", url: `${BASE}/api/v1/admin/config` });
    expect(put?.headers.get("If-None-Match")).toBe("*");
    expect(put?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(put?.bytes))).toEqual(config);

    const relabeled = structuredClone(config);
    for (const entry of Object.values(relabeled.certificates)) {
      entry.label = "Example Root CA";
    }
    const second = await against(svc, [
      "config",
      "apply",
      "--json",
      await configFile("second.json", relabeled),
    ]);
    expect(second.code).toBe(0);
    expect(svc.sent.at(-1)?.headers.get("If-Match")).toBe(etag);
    expect(JSON.parse(second.stdout)).toEqual({ etag: await storedEtag(svc), config: relabeled });
  });

  it("sends nothing when the file breaks a static rule", async () => {
    const svc = service();
    const file = await configFile("static.json", { version: 2 });
    const run = await against(svc, ["config", "apply", file]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`^${file} is invalid, nothing was sent \\(`));
    expect(svc.sent).toEqual([]);
  });

  it("prints every issue of a 422 from the service", async () => {
    const svc = service();
    const file = await configFile("unimported.json", configFor(["root-ca"]));
    const run = await against(svc, ["config", "apply", file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const [title, ...issues] = run.stderr.trimEnd().split("\n");
    expect(title).toBe(
      `the service rejected ${file}: HTTP 422 config_invalid: The configuration is invalid ` +
        "(3 issues):"
    );
    expect(issues.map((line) => /^ {2}V4 {2}\S+: /.test(line))).toEqual([true, true, true]);
  });

  it("reports 412 when the config changed between GET and PUT, and does not retry", async () => {
    const svc = service();
    await putText(svc.deps.store, CONFIG_KEY, MINIMAL_CONFIG);
    const racing: CliIo["fetch"] = async (url, init) => {
      const res = await svc.fetch(url, init);
      if (init.method === "GET") {
        await putText(svc.deps.store, CONFIG_KEY, `${MINIMAL_CONFIG}\n`);
      }
      return res;
    };
    const file = await configFile("race.json", JSON.parse(MINIMAL_CONFIG));
    const run = await aia(["config", "apply", file], { env: ENV, fetch: racing });
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^aia: HTTP 412 precondition_failed: /);
    expect(run.stderr).toMatch(/config\.json changed after it was read .* apply again\n$/);
    expect(svc.sent.map((request) => request.method)).toEqual(["GET", "PUT"]);
  });
});

describe("new-target-id", () => {
  it("prints a fresh target id, offline", async () => {
    const run = await aia(["new-target-id"]);
    expect(run.code).toBe(0);
    expect(TargetId.safeParse(run.stdout.replace(/\n$/, "")).success).toBe(true);
  });
});

describe("publish", () => {
  const FULL_01 = "crls/issuing-ca-1/full-01.der";
  const FULL_01_PEM = fixturePath("crls/issuing-ca-1/full-01.pem");
  const FULL_02 = "crls/issuing-ca-1/full-02.der";
  const UPLOAD_ENV = { AIA_URL: BASE };

  it("sends each file as is, with no token unless set", async () => {
    const { svc, setup } = await publishing();
    const run = await against(svc, ["publish", ROOT_CRL, FULL_01_PEM], {
      ...UPLOAD_ENV,
      AIA_ADMIN_TOKEN: TOKEN,
    });
    expect(run).toEqual({
      code: 0,
      stdout:
        `created    ${setup.target("root-ca", "full")}  ` +
        `full #${crlEntry("crls/root-ca/full-01.der").crlNumber}  ${ROOT_CRL}\n` +
        `created    ${setup.target("issuing-ca-1", "full")}  ` +
        `full #${crlEntry(FULL_01).crlNumber}  ${FULL_01_PEM}\n` +
        "2 created, 0 updated, 0 unchanged, 0 failed\n",
      stderr: "",
    });
    expect(svc.sent.map((request) => [request.method, request.url])).toEqual([
      ["POST", `${BASE}/api/v1/crls`],
      ["POST", `${BASE}/api/v1/crls`],
    ]);
    expect(svc.sent.map((request) => request.bytes)).toEqual(
      ["crls/root-ca/full-01.der", "crls/issuing-ca-1/full-01.pem"].map((file) => fixture(file))
    );
    expect(svc.authorization()).toEqual([null, null]);
  });

  it("publishes each file on its own: updated, unchanged and failures, exit 1", async () => {
    const { svc, setup } = await publishing();
    expect((await against(svc, ["publish", fixturePath(FULL_01)], UPLOAD_ENV)).code).toBe(0);
    const missing = join(scratch, "missing.crl");
    const full01 = fixturePath(FULL_01);
    const full02 = fixturePath(FULL_02);
    const run = await against(
      svc,
      ["publish", full02, full01, missing, GARBAGE, full02],
      UPLOAD_ENV
    );
    expect(run.code).toBe(1);
    const full = setup.target("issuing-ca-1", "full");
    const number = crlEntry(FULL_02).crlNumber;
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      `updated    ${full}  full #${number}  ${full02}`,
      `unchanged  ${full}  full #${number}  ${full02}`,
      "0 created, 1 updated, 1 unchanged, 3 failed",
    ]);
    const thisUpdate = new Date(crlEntry(FULL_02).thisUpdate).toISOString();
    expect(run.stderr.trimEnd().split("\n")).toEqual([
      `failed     ${full01}: HTTP 409 stale_crl: The CRL is older than the target's current CRL ` +
        `(current: CRL Number ${number}, thisUpdate ${thisUpdate})`,
      expect.stringMatching(new RegExp(`^failed     ${missing}: cannot read the file: ENOENT`)),
      `failed     ${GARBAGE}: HTTP 422 invalid_crl (der): Not a valid X.509 CRL`,
    ]);
    expect(svc.sent).toHaveLength(5);
  });

  it("reports every result as JSON with --json", async () => {
    const { svc, setup } = await publishing();
    const run = await against(svc, ["publish", "--json", ROOT_CRL, GARBAGE], UPLOAD_ENV);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      results: [
        expect.objectContaining({
          file: ROOT_CRL,
          ok: true,
          outcome: "created",
          target: setup.target("root-ca", "full"),
        }),
        {
          file: GARBAGE,
          ok: false,
          error: {
            status: 422,
            code: "invalid_crl",
            message: "HTTP 422 invalid_crl (der): Not a valid X.509 CRL",
            details: { reason: "der" },
          },
        },
      ],
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 1,
    });
  });
});

describe("batch response failures", () => {
  it("continues after a connection failure and invalid JSON, preserving JSON result order", async () => {
    const { svc } = await publishing();
    let requests = 0;
    const run = await aia(["publish", ROOT_CRL, ROOT_CRL, ROOT_CRL, "--json"], {
      env: ENV,
      fetch: (url, init) => {
        requests++;
        if (requests === 1) {
          return Promise.reject(new Error("connection reset"));
        }
        if (requests === 2) {
          return Promise.resolve(new Response("not JSON"));
        }
        return svc.fetch(url, init);
      },
    });
    expect(requests).toBe(3);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 2,
      results: [
        {
          file: ROOT_CRL,
          ok: false,
          error: { message: `cannot reach ${BASE}/api/v1/crls: connection reset` },
        },
        { file: ROOT_CRL, ok: false, error: { message: "HTTP 200, but the body is not JSON" } },
        { file: ROOT_CRL, ok: true, outcome: "created" },
      ],
    });
  });
});

describe("history", () => {
  const FILES = ["crls/issuing-ca-1/full-01.der", "crls/issuing-ca-1/full-02.der"];

  async function withHistory() {
    const { svc, setup } = await publishing();
    const run = await against(svc, ["publish", ...FILES.map(fixturePath)]);
    expect(run.code).toBe(0);
    return { svc, targetId: setup.target("issuing-ca-1", "full") };
  }

  it("lists the versions newest first, as text or as JSON", async () => {
    const { svc, targetId } = await withHistory();
    const [old, current] = FILES.map((file) => crlEntry(file));
    const line = (entry: typeof old, size: number) =>
      `${new Date(entry!.thisUpdate).toISOString()}  #${entry!.crlNumber}  ` +
      `${entry!.sha256}  ${size} B`;
    const sizes = FILES.map((file) => fixture(file).byteLength);
    expect(await against(svc, ["history", targetId])).toEqual({
      code: 0,
      stdout: `${line(current, sizes[1]!)}  current\n${line(old, sizes[0]!)}\n2 versions\n`,
      stderr: "",
    });
    const json = await against(svc, ["history", targetId, "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ targetId, configured: true });
  });

  it("writes one version's DER with --out, and fails on an unknown one", async () => {
    const { svc, targetId } = await withHistory();
    const out = join(scratch, "history-full-01.crl");
    const sha256 = crlEntry(FILES[0]!).sha256;
    const run = await against(svc, ["history", targetId, sha256, "--out", out]);
    expect(run.code).toBe(0);
    expect(new Uint8Array(await readFile(out))).toEqual(fixture(FILES[0]!));
    const unknown = await against(svc, ["history", targetId, "0".repeat(64), "--out", out]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/HTTP 404 not_found/);
  });
});

describe("delete-certificate", () => {
  it("deletes an unreferenced certificate; a referenced one fails with its references", async () => {
    const { svc, setup } = await publishing();
    const leaf = cert("leaf-min").sha256;
    expect((await against(svc, ["import", fixturePath(cert("leaf-min").der)])).code).toBe(0);
    expect(await against(svc, ["delete-certificate", leaf])).toEqual({
      code: 0,
      stdout: `deleted ${leaf}\n`,
      stderr: "",
    });
    const issuer = cert("root-ca").sha256;
    const run = await against(svc, ["delete-certificate", issuer]);
    expect(run.code).toBe(1);
    const [first, ...references] = run.stderr.trimEnd().split("\n");
    expect(first).toMatch(/^aia: HTTP 409 referenced: /);
    expect(references).toEqual([
      `  config.json targets["${setup.target("root-ca", "full")}"].issuer`,
    ]);
  });
});
