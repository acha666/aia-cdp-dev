import { z } from "zod";

type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

const bearerToken = z
  .string()
  .min(1, { message: "must not be empty when set", abort: true })
  .regex(
    /^[A-Za-z0-9._~+/-]+=*$/,
    "must be a bearer token: letters, digits and - . _ ~ + /, optionally ending in ="
  );

const SettingsSchema = z
  .object({
    PORT: integer(0, 65535, "must be an integer from 0 to 65535").default(8080),
    AIA_STORE: z.enum(["fs"], 'must be "fs"').default("fs"),
    AIA_DATA_DIR: nonEmpty("must not be empty").default("/data"),
    AIA_STATIC_DIR: nonEmpty("must not be empty").default("./dist/web"),
    AIA_ADMIN_TOKEN: bearerToken.optional(),
    AIA_UPLOAD_TOKEN: bearerToken.optional(),
    AIA_MAX_UPLOAD_BYTES: integer(
      1,
      Number.MAX_SAFE_INTEGER,
      "must be a positive integer (bytes)"
    ).default(1_048_576),
  })
  .transform((v) => ({
    port: v.PORT,
    store: v.AIA_STORE,
    dataDir: v.AIA_DATA_DIR,
    staticDir: v.AIA_STATIC_DIR,
    app: {
      maxUploadBytes: v.AIA_MAX_UPLOAD_BYTES,
      adminToken: v.AIA_ADMIN_TOKEN,
      uploadToken: v.AIA_UPLOAD_TOKEN,
    },
  }));

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
