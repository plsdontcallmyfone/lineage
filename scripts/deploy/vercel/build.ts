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
// The Garage snapshot is the landing page: its files sit at the dist root (its index.html is "/"),
// and the dashboard's shell is app.html, the rewrite target for every client-side route.
cpSync(join(WEB, "public/garage"), OUT, { recursive: true });
cpSync(join(WEB, "public/index.html"), join(OUT, "app.html"));
// the landing page's sticky notes (hidden by garage-overrides.css) ask /api/stickies; a static empty
// answer keeps that off the proxied Core, which has no such route
mkdirSync(join(OUT, "api"), { recursive: true });
writeFileSync(join(OUT, "api/stickies"), "[]");

const vercel = {
  cleanUrls: true,
  trailingSlash: false,
  rewrites: [
    ...["api", "live", "chain", "souls", "market", "embed"].map((p) => ({ source: `/${p}/:path*`, destination: `${SITE}/${p}/:path*` })),
    { source: "/garage", destination: "/" },
    { source: "/garage/:path*", destination: "/:path*" },
    { source: "/:path*", destination: "/app" },
  ],
  headers: [
    { source: "/assets/(.*)", headers: [{ key: "cache-control", value: "public, max-age=60" }] },
    { source: "/(api|live|chain|souls|market|embed)/(.*)", headers: [{ key: "cache-control", value: "no-store" }] },
    // audit A2: no CSP here (the Garage pages are a static Next.js export with inline scripts); the
    // dashboard's own policy is set by Caddy on the site. These hold for every page.
    {
      source: "/(.*)",
      headers: [
        { key: "x-content-type-options", value: "nosniff" },
        { key: "x-frame-options", value: "DENY" },
        { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
        { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()" },
      ],
    },
  ],
};
writeFileSync(join(OUT, "vercel.json"), JSON.stringify(vercel, null, 2));
writeFileSync(join(OUT, ".vercelignore"), "");
console.log(`built ${OUT} (api -> ${SITE})`);
