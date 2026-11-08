import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { hasFileExtension } from "../http/ui.ts";

/**
 * Serves the built web UI from `staticDir`; paths without a file extension get `index.html`
 * for client-side routing.
 */
export function createNodeUi(staticDir: string): (req: Request) => Response | Promise<Response> {
  const root = resolve(staticDir);
  const inner = new Hono();
  inner.use(serveStatic({ root }));
  const spaIndex = serveStatic({ root, path: "index.html" });
  inner.use((c, next) => (hasFileExtension(c.req.path) ? next() : spaIndex(c, next)));
  return (req) => inner.fetch(req);
}
