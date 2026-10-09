#!/usr/bin/env bun
// Static build of the dashboard for Vercel: client bundles, public assets, the Garage snapshot and a
// vercel.json whose rewrites proxy the API paths (/api, /live, /chain, /souls) to the public site, which
// runs Core and the full dashboard server. Vercel serves only static files here; nothing stateful.
//
//   bun scripts/deploy/vercel/build.ts [--site https://157-245-71-188.sslip.io] [--out apps/web/dist]
//   cd apps/web/dist && vercel deploy --prod
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainBrowserPlugin } from "../../../packages/chain/src/browser/plugin.ts";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const ROOT = join(import.meta.dir, "../../..");
const WEB = join(ROOT, "apps/web");
const SITE = arg("site", "https://157-245-71-188.sslip.io").replace(/\/+$/, "");
const OUT = arg("out", join(WEB, "dist"));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "assets"), { recursive: true });

async function bundle(entry: string, extra: Partial<Parameters<typeof Bun.build>[0]> = {}) {
  const out = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, sourcemap: "none", ...extra });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return out.outputs[0]!.text();
}
writeFileSync(join(OUT, "assets/app.js"), await bundle(join(WEB, "src/main.ts")));
writeFileSync(join(OUT, "assets/wallet.js"), await bundle(join(WEB, "wallet/main.ts"), { format: "esm", plugins: [chainBrowserPlugin] }));
cpSync(join(WEB, "public/app.css"), join(OUT, "assets/app.css"));
cpSync(join(WEB, "public/favicon.svg"), join(OUT, "favicon.svg"));
cpSync(join(WEB, "public/index.html"), join(OUT, "index.html"));
cpSync(join(WEB, "public/garage"), join(OUT, "garage"), { recursive: true });
cpSync(join(WEB, "public/garage/_next"), join(OUT, "_next"), { recursive: true });

const garagePages = ["aura", "core-motion", "google", "pixelagent", "showcase"];
const vercel = {
  cleanUrls: true,
  trailingSlash: false,
  rewrites: [
    ...["api", "live", "chain", "souls"].map((p) => ({ source: `/${p}/:path*`, destination: `${SITE}/${p}/:path*` })),
    { source: "/garage", destination: "/garage/index.html" },
    ...garagePages.map((p) => ({ source: `/${p}`, destination: `/garage/${p}/index.html` })),
    { source: "/contact-fold-3d.html", destination: "/garage/contact-fold-3d.html" },
    { source: "/:path*", destination: "/" },
  ],
  headers: [
    { source: "/assets/(.*)", headers: [{ key: "cache-control", value: "public, max-age=60" }] },
    { source: "/(api|live|chain|souls)/(.*)", headers: [{ key: "cache-control", value: "no-store" }] },
  ],
};
writeFileSync(join(OUT, "vercel.json"), JSON.stringify(vercel, null, 2));
writeFileSync(join(OUT, ".vercelignore"), "");
console.log(`built ${OUT} (api -> ${SITE})`);
