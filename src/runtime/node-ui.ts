import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { hasFileExtension } from "../http/ui.ts";

export function createNodeUi(staticDir: string): (req: Request) => Response | Promise<Response> {
  const root = resolve(staticDir);
  const inner = new Hono();
  inner.use(serveStatic({ root }));
  const spaIndex = serveStatic({ root, path: "index.html" });
  inner.use((c, next) => (hasFileExtension(c.req.path) ? next() : spaIndex(c, next)));
  return (req) => inner.fetch(req);
}
