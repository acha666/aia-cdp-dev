/**
 * The `aia` command line client for the admin API and CRL uploads.
 *
 * @packageDocumentation
 */

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { Command, CommanderError } from "commander";
import { Failure, UsageError } from "./client.ts";
import type { CliIo, Context } from "./client.ts";
import {
  configApply,
  configShow,
  configValidate,
  deleteCertificate,
  health,
  historyVersion,
  listHistory,
  newTargetId,
  uploadFiles,
} from "./commands.ts";

export type { CliIo } from "./client.ts";

interface Options {
  url?: string;
  tokenFile?: string;
  allowInsecureHttp?: boolean;
  out?: string;
  json?: boolean;
}

/**
 * Runs the CLI with `argv` (without the node and script arguments).
 *
 * @returns The exit code: 0 success, 1 failure, 2 usage error.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let code = 0;
  const program = new Command()
    .name("aia")
    .description("Manage CA certificates, configuration and CRLs")
    .option("--url <url>", "Service base URL (default: $AIA_URL)")
    .option(
      "--token-file <file>",
      "Token file; overrides $AIA_ADMIN_TOKEN_FILE / $AIA_ADMIN_TOKEN, or " +
        "$AIA_UPLOAD_TOKEN_FILE / $AIA_UPLOAD_TOKEN for publish (optional)"
    )
    .option(
      "--allow-insecure-http",
      "Allow sending a token over plain HTTP beyond localhost, 127.0.0.0/8 or [::1]"
    )
    .option("--out <file>", "history <targetId> <sha256>: write the DER to this file")
    .option("--json", "Print results as JSON (errors stay text on stderr)")
    .addHelpText("afterAll", "\nExit codes: 0 success, 1 failure or not healthy, 2 usage error.")
    .configureHelp({ showGlobalOptions: true })
    .configureOutput({
      writeOut: io.stdout,
      writeErr: () => {
        // Errors are reported once, as the usage message below.
      },
    })
    .exitOverride()
    .hook("preAction", (_, command) => {
      if (
        program.opts<Options>().out !== undefined &&
        (command.name() !== "history" || command.args.length !== 2)
      ) {
        throw new UsageError("--out is only for history <targetId> <sha256>");
      }
    });

  const action =
    <Args extends unknown[]>(run: (ctx: Context, ...args: Args) => number | Promise<number>) =>
    async (...args: Args): Promise<void> => {
      const options = program.opts<Options>();
      code = await run(
        {
          io,
          json: options.json === true,
          url: options.url ?? io.env.AIA_URL,
          tokenFile: options.tokenFile,
          allowInsecureHttp: options.allowInsecureHttp === true,
        },
        ...args
      );
    };

  program
    .command("import <files...>")
    .description(
      "Import CA certificates (DER or PEM; each certificate block is imported separately)"
    )
    .action(action((ctx, files: string[]) => uploadFiles(ctx, files, "certificate")));

  const config = program.command("config").description("Read, validate or replace config.json");
  config.command("show").description("Print the stored config.json").action(action(configShow));
  config
    .command("validate <file>")
    .description("Validate a config file offline; apply also checks it against the stored state")
    .action(action(configValidate));
  config
    .command("apply <file>")
    .summary("Validate, then replace config.json as a whole")
    .description(
      "Validate, then replace config.json as a whole, overwriting any change made since you " +
        "last read it. A removed target is no longer served; its history is kept."
    )
    .action(action(configApply));

  program
    .command("new-target-id")
    .description("Print a new target id (a random UUID)")
    .action(action(newTargetId));
  program
    .command("publish <files...>")
    .description(
      "Publish CRLs (DER or PEM): one upload per file; failed files do not stop the rest"
    )
    .action(action((ctx, files: string[]) => uploadFiles(ctx, files, "crl")));
  program
    .command("history <targetId> [sha256]")
    .description("List CRL history newest first, or download one version with --out <file>")
    .action(
      action(async (ctx, targetId: string, sha256: string | undefined) => {
        if (sha256 === undefined) {
          return listHistory(ctx, targetId);
        }
        const { out } = program.opts<Options>();
        if (out === undefined) {
          throw new UsageError("history <targetId> <sha256> needs --out <file>");
        }
        return historyVersion(ctx, targetId, sha256, out);
      })
    );
  program
    .command("delete-certificate <id>")
    .description("Delete a certificate that nothing references")
    .action(action(deleteCertificate));
  program
    .command("health")
    .description("Exit 0 only if the service reports healthy")
    .action(action(health));

  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (cause) {
    let error = cause;
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        return 0;
      }
      error = new UsageError(
        error.code === "commander.help" ? "missing command" : error.message.replace(/^error: /, "")
      );
    }
    if (error instanceof UsageError) {
      io.stderr(`aia: ${error.message}\nRun "aia --help" for usage.\n`);
      return 2;
    }
    if (error instanceof Failure) {
      io.stderr(`aia: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** The real process environment, console and file system. */
export function processIo(): CliIo {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    readFile: (path) => readFile(path),
    writeFile: (path, bytes) => writeFile(path, bytes),
  };
}

if (import.meta.main) {
  // A closed pipe (`aia ... | head`) is not an error.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
    process.exit(process.exitCode ?? 0);
  });
  process.exitCode = await main(process.argv.slice(2), processIo());
}
