// Node 26 entry: FsStore on AIA_DATA_DIR, the built UI from AIA_STATIC_DIR.
// Production: node --enable-source-maps dist/server/runtime/node.js; development and tests run the
// source directly: node src/runtime/node.ts (type stripping).
import { constants, accessSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import process from "node:process";
import { serve } from "@hono/node-server";
import { createApp } from "../http/app.ts";
import { describeError } from "../http/log.ts";
import type { Logger } from "../http/log.ts";
import { FsStore } from "../storage/fs.ts";
import { createNodeUi } from "./node-ui.ts";
import { parseSettings, resolveFileVariants } from "./settings.ts";

/**
 * After SIGTERM / SIGINT: requests already running get this long, then every connection still
 * open is closed, including a slow client stuck in a partial request, which server.close() alone
 * waits for forever. Well inside `docker stop`'s 10 s.
 */
const GRACE_MS = 2_000;

async function main(): Promise<void> {
  // Settings errors go to stderr as text, one invalid variable per line.
  const resolved = resolveFileVariants(process.env, (path) => readFileSync(path, "utf8"));
  const parsed = resolved.ok ? parseSettings(resolved.value) : resolved;
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  const settings = parsed.value;
  const log: Logger = (record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  try {
    if (!statSync(settings.dataDir).isDirectory()) {
      throw new Error(`${settings.dataDir} is not a directory`);
    }
    accessSync(settings.dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    log({
      level: "error",
      msg: "data_dir_unusable",
      dataDir: settings.dataDir,
      error: describeError(error),
    });
    process.exitCode = 1;
    return;
  }

  const app = createApp({
    store: new FsStore(settings.dataDir),
    now: () => new Date(),
    settings: settings.app,
    log,
    ui: createNodeUi(settings.staticDir),
  });

  // Explicit port (@hono/node-server defaults to 3000); no hostname, so Node listens on `::`
  // (dual stack). PORT=0 picks a free port: the listening line reports the real one. Without a
  // createServer option serve() returns a node:http Server.
  const server = serve({ fetch: app.fetch, port: settings.port }, (info) => {
    log({ level: "info", msg: "listening", port: info.port });
  }) as Server;
  // EADDRINUSE and friends would otherwise crash with an unhandled 'error' event.
  server.on("error", (error) => {
    log({ level: "error", msg: "server_error", error: describeError(error) });
    process.exit(1);
  });

  // node is PID 1 in the container: without these handlers SIGTERM would not stop it.
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log({ level: "info", msg: "shutdown", signal });
    // Stops accepting, ends idle keep-alive sockets, and calls back once every connection has
    // closed.
    server.close((error) => {
      if (error) {
        log({ level: "error", msg: "closed", error: describeError(error) });
        process.exit(1);
      }
      log({ level: "info", msg: "closed" });
      process.exit(0);
    });
    // In-flight requests get GRACE_MS, then everything left goes (close() stops Node's header
    // timeout, so a socket without a request never would).
    setTimeout(() => {
      server.closeAllConnections();
    }, GRACE_MS).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

await main();
