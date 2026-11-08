// Environment settings, shared by the Node and Workers entries: pure zod, no node:*.
// Node reads `*_FILE` variants first (resolveFileVariants with readFileSync); Workers pass their
// vars / secrets straight to parseSettings.
import { z } from "zod";

type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Variables that may instead be read from the file named by `<NAME>_FILE`. */
const FILE_VARIANTS = ["AIA_ADMIN_TOKEN", "AIA_UPLOAD_TOKEN"] as const;

type Env = Readonly<Record<string, string | undefined>>;

function integer(min: number, max: number, message: string) {
  return z
    .string()
    .regex(/^[0-9]{1,16}$/, message)
    .transform(Number)
    .refine((n) => n >= min && n <= max, message);
}

const nonEmpty = (message: string) => z.string().min(1, message);

// RFC 6750 b64token, the only token syntax a Bearer Authorization header carries (bearerAuth's own
// pattern): a token with any other character (`$`, `!`, a space, …) could never authenticate, as
// every request would get 400, so it is an invalid setting instead. src/cli/client.ts checks the
// CLI's tokens against the same pattern.
const bearerToken = z
  .string()
  .min(1, { message: "must not be empty when set", abort: true })
  .regex(
    /^[A-Za-z0-9._~+/-]+=*$/,
    "must be a bearer token: letters, digits and - . _ ~ + /, optionally ending in ="
  );

// Messages never echo the value: two of these variables are secrets.
const SettingsSchema = z
  .object({
    PORT: integer(0, 65535, "must be an integer from 0 to 65535").default(8080),
    AIA_STORE: z.enum(["fs"], 'must be "fs"').default("fs"),
    AIA_DATA_DIR: nonEmpty("must not be empty").default("/data"),
    AIA_STATIC_DIR: nonEmpty("must not be empty").default("./dist/web"),
    AIA_ADMIN_TOKEN: bearerToken.optional(),
    AIA_UPLOAD_TOKEN: bearerToken.optional(),
    // The largest request body the CRL upload and the admin routes read, and so the largest CRL
    // (1 MiB holds about 25 000 revoked entries).
    AIA_MAX_UPLOAD_BYTES: integer(
      1,
      Number.MAX_SAFE_INTEGER,
      "must be a positive integer (bytes)"
    ).default(1_048_576),
  })
  .transform((v) => ({
    /** 0 picks a free port (tests, smoke scripts). */
    port: v.PORT,
    store: v.AIA_STORE,
    /** fs store root; one service process per directory. */
    dataDir: v.AIA_DATA_DIR,
    /** Built UI (vite build output). */
    staticDir: v.AIA_STATIC_DIR,
    /** AppSettings (src/http/types.ts). */
    app: {
      maxUploadBytes: v.AIA_MAX_UPLOAD_BYTES,
      adminToken: v.AIA_ADMIN_TOKEN,
      uploadToken: v.AIA_UPLOAD_TOKEN,
    },
  }));

/**
 * Validates the environment and applies the defaults; `parseSettings({})` is the all-defaults
 * configuration (tests). Unknown variables are ignored. On failure `error` lists every invalid
 * variable, one per line.
 */
export function parseSettings(env: Env): SettingsResult<z.output<typeof SettingsSchema>> {
  const result = SettingsSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.map(String).join(".")}: ${issue.message}`
    );
    return { ok: false, error: ["Invalid settings:", ...lines].join("\n") };
  }
  return { ok: true, value: result.data };
}

/**
 * For each FILE_VARIANTS name: when `<NAME>_FILE` is set, `<NAME>` becomes that file's content
 * minus one trailing newline (`\n` or `\r\n`). Setting both `<NAME>` and `<NAME>_FILE` is an
 * error. Returns a copy of `env` without the `_FILE` entries; `readText` is the only I/O.
 */
export function resolveFileVariants(
  env: Env,
  readText: (path: string) => string
): SettingsResult<Record<string, string | undefined>> {
  const resolved: Record<string, string | undefined> = { ...env };
  const errors: string[] = [];
  for (const name of FILE_VARIANTS) {
    const fileVar = `${name}_FILE`;
    const path = env[fileVar];
    delete resolved[fileVar];
    if (path === undefined) {
      continue;
    }
    if (env[name] !== undefined) {
      errors.push(`  ${name}: set either ${name} or ${fileVar}, not both`);
    } else {
      try {
        resolved[name] = readText(path).replace(/\r?\n$/, "");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push(`  ${fileVar}: cannot read ${JSON.stringify(path)}: ${reason}`);
      }
    }
  }
  return errors.length > 0
    ? { ok: false, error: ["Invalid settings:", ...errors].join("\n") }
    : { ok: true, value: resolved };
}
