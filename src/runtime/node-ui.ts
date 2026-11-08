// Node's deps.ui: files from the built UI, and index.html for history routes. The reserved
// prefixes, the extension rule and Cache-Control are applied by the app (src/http/ui.ts), exactly
// as for the Workers ASSETS binding.
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { hasFileExtension } from "../http/ui.ts";

export function createNodeUi(staticDir: string): (req: Request) => Response | Promise<Response> {
  const root = resolve(staticDir);
  const inner = new Hono();
  // serveStatic answers GET / HEAD only, rejects `..`, `%` and `\` in the path, and sets
  // Content-Length (HEAD included).
  inner.use(serveStatic({ root }));
  // SPA fallback only where the last segment has no extension: a missing /assets/x.js stays 404.
  const spaIndex = serveStatic({ root, path: "index.html" });
  inner.use((c, next) => (hasFileExtension(c.req.path) ? next() : spaIndex(c, next)));
  // Anything else falls through to Hono's 404, which the app turns into its text 404.
  return (req) => inner.fetch(req);
}
