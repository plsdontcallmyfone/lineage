#!/usr/bin/env bun
// Local preview of the standalone docs site, answering as the real hosts do (the Caddy site of
// scripts/docs/deploy.sh, or Vercel with apps/docs/vercel.json): clean URLs (/verification is
// verification.html, /verification.html and /verification/ redirect to it), 404.html with status 404
// for an unknown path, the page policy and the cache rules of scripts/docs/build.ts.
//
//   bun scripts/docs/serve.ts [--port 9663] [--app <app origin>] [--dir <built output>]
//
// Without --dir it builds the docs in memory (and again on every page request, so an edit shows on
// reload). The port must be free (lsof -ti :<port>); 9662 is the owner's review server.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildDocsChecked, defaultAppUrl, docsCacheFor, docsCsp, DOCS_PERMISSIONS, type DocsFile } from "./build.ts";

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8", txt: "text/plain; charset=utf-8", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", woff2: "font/woff2" };

/** The files of a built output directory, keyed like the build's own map. */
export function readDocsDir(dir: string): Map<string, DocsFile> {
  const out = new Map<string, DocsFile>();
  const walk = (rel: string) => {
    for (const f of readdirSync(join(dir, rel))) {
      const p = rel ? `${rel}/${f}` : f;
      if (statSync(join(dir, p)).isDirectory()) walk(p);
      else out.set(p, { body: new Uint8Array(readFileSync(join(dir, p))), type: TYPES[f.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" });
    }
  };
  walk("");
  return out;
}

/** One request against the files of a build, as a static host answers it. */
export function docsResponse(files: Map<string, DocsFile>, req: Request, app: string): Response {
  const url = new URL(req.url);
  const security = { "content-security-policy": docsCsp(app), "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": DOCS_PERMISSIONS };
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD", ...security } });
  const path = decodeURIComponent(url.pathname);
  const clean = /^\/(.+?)(?:\.html|\/)$/.exec(path);
  if (path === "/index" || path === "/index.html") return new Response(null, { status: 308, headers: { location: `/${url.search}`, ...security } });
  if (clean && files.has(`${clean[1]}.html`)) return new Response(null, { status: 308, headers: { location: `/${clean[1]}${url.search}`, ...security } });
  const rel = path.replace(/^\/+/, "");
  const key = rel === "" ? "index.html" : files.has(rel) && rel !== "vercel.json" ? rel : files.has(`${rel}.html`) ? `${rel}.html` : null;
  const f = key ? files.get(key)! : null;
  if (!f) return new Response(files.get("404.html")?.body as BodyInit ?? "not found", { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...security } });
  return new Response(req.method === "HEAD" ? null : (f.body as BodyInit), { headers: { "content-type": f.type, "cache-control": docsCacheFor(key!), ...security } });
}

if (import.meta.main) {
  const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
  const port = Number(arg("port") ?? 9663);
  const app = (arg("app") ?? defaultAppUrl()).replace(/\/+$/, "");
  const dir = arg("dir");
  if (port === 9662) throw new Error("port 9662 is the owner's review server");
  try {
    const busy = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    if (busy) {
      console.error(`port ${port} is in use by pid ${busy.replace(/\n/g, ", ")}; not binding`);
      process.exit(1);
    }
  } catch {
    /* lsof exits non-zero when nothing listens */
  }
  if (dir && !existsSync(join(dir, "index.html"))) throw new Error(`no index.html in ${dir}`);
  let files = dir ? readDocsDir(dir) : (await buildDocsChecked({ app })).files;
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!dir && !/\/(assets|fonts|shots|providers)\//.test(new URL(req.url).pathname)) files = (await buildDocsChecked({ app })).files;
      return docsResponse(files, req, app);
    },
  });
  console.log(`docs on http://127.0.0.1:${port} (${dir ? `files of ${dir}` : "built from the tree on every page request"}; app ${app})`);
}
