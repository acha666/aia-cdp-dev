// The environment settings of both runtimes, and the `_FILE` variants that the Node
// entry resolves first.
import { describe, expect, it } from "vitest";
import { parseSettings, resolveFileVariants } from "../../src/runtime/settings.ts";

describe("parseSettings", () => {
  it("applies the defaults and reads every variable", () => {
    expect(parseSettings({})).toEqual({
      ok: true,
      value: {
        port: 8080,
        store: "fs",
        dataDir: "/data",
        staticDir: "./dist/web",
        app: { maxUploadBytes: 1_048_576 },
      },
    });
    const env = {
      PORT: "0",
      AIA_STORE: "fs",
      AIA_DATA_DIR: "/srv/aia",
      AIA_STATIC_DIR: "web",
      AIA_ADMIN_TOKEN: "admin.Token_1~",
      AIA_UPLOAD_TOKEN: "dXBsb2Fk+/==",
      AIA_MAX_UPLOAD_BYTES: "2048",
    };
    expect(parseSettings(env)).toEqual({
      ok: true,
      value: {
        port: 0,
        store: "fs",
        dataDir: "/srv/aia",
        staticDir: "web",
        app: { maxUploadBytes: 2048, adminToken: "admin.Token_1~", uploadToken: "dXBsb2Fk+/==" },
      },
    });
  });

  it.each([
    [{ PORT: "abc" }, "PORT: must be an integer from 0 to 65535"],
    [{ PORT: "65536" }, "PORT: must be an integer from 0 to 65535"],
    [{ AIA_STORE: "r2" }, 'AIA_STORE: must be "fs"'],
    [{ AIA_DATA_DIR: "" }, "AIA_DATA_DIR: must not be empty"],
    [{ AIA_ADMIN_TOKEN: "" }, "AIA_ADMIN_TOKEN: must not be empty when set"],
    [{ AIA_MAX_UPLOAD_BYTES: "0" }, "AIA_MAX_UPLOAD_BYTES: must be a positive integer (bytes)"],
  ])("rejects %j", (env, line) => {
    expect(parseSettings(env)).toEqual({ ok: false, error: `Invalid settings:\n  ${line}` });
  });

  it("lists every invalid variable, one per line, without echoing a token", () => {
    const parsed = parseSettings({ PORT: "-1", AIA_UPLOAD_TOKEN: "s3cret token!" });
    expect(parsed).toEqual({
      ok: false,
      error: [
        "Invalid settings:",
        "  PORT: must be an integer from 0 to 65535",
        "  AIA_UPLOAD_TOKEN: must be a bearer token: letters, digits and - . _ ~ + /, " +
          "optionally ending in =",
      ].join("\n"),
    });
  });
});

describe("resolveFileVariants", () => {
  const files: Record<string, string> = { "/run/admin": "s3cret\r\n", "/run/blank": "\n" };
  const read = (path: string) => {
    const text = files[path];
    if (text === undefined) {
      throw new Error("ENOENT: no such file");
    }
    return text;
  };

  it("replaces <NAME>_FILE with the file's content minus one trailing newline", () => {
    expect(resolveFileVariants({ AIA_ADMIN_TOKEN_FILE: "/run/admin", PORT: "1" }, read)).toEqual({
      ok: true,
      value: { AIA_ADMIN_TOKEN: "s3cret", PORT: "1" },
    });
    // The newline goes before validation: a file holding only a newline is an empty token.
    const blank = resolveFileVariants({ AIA_UPLOAD_TOKEN_FILE: "/run/blank" }, read);
    expect(blank.ok && parseSettings(blank.value)).toEqual({
      ok: false,
      error: "Invalid settings:\n  AIA_UPLOAD_TOKEN: must not be empty when set",
    });
  });

  it.each([
    [
      { AIA_ADMIN_TOKEN: "x", AIA_ADMIN_TOKEN_FILE: "/run/admin" },
      "AIA_ADMIN_TOKEN: set either AIA_ADMIN_TOKEN or AIA_ADMIN_TOKEN_FILE, not both",
    ],
    [
      { AIA_UPLOAD_TOKEN_FILE: "/run/missing" },
      'AIA_UPLOAD_TOKEN_FILE: cannot read "/run/missing": ENOENT: no such file',
    ],
  ])("rejects %j", (env, line) => {
    expect(resolveFileVariants(env, read)).toEqual({
      ok: false,
      error: `Invalid settings:\n  ${line}`,
    });
  });
});
