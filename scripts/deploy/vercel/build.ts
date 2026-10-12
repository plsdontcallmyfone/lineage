#!/usr/bin/env bun
// Static build of the dashboard for Vercel: client bundles, public assets, the dashboard at "/",
// self-hosted fonts, and a vercel.json whose rewrites proxy the API paths
// (/api, /live, /chain, /souls, /market, /embed, /coin, /social) to the public site, which runs Core and the full
// dashboard server. Vercel serves only static files here; nothing stateful. The docs are a web site
// of their own, built and deployed from their own repository (units-docs; docs/DEPLOY-SITE.md "Docs site"):
// /docs and /docs/<page> redirect to the same page there (UNITS_DOCS_URL, else config/sites.json
// docs_url; temporary unless UNITS_DOCS_REDIRECT=301).
//
//   bun scripts/deploy/vercel/build.ts [--site <backend, default the mainnet site>] [--out apps/web/dist]
//   cd apps/web/dist && vercel deploy --prod
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sites from "../../../config/sites.json" with { type: "json" };
import profileConfig from "../../../config/profile.json" with { type: "json" };
import { chainBrowserPlugin } from "../../../packages/chain/src/browser/plugin.ts";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const ROOT = join(import.meta.dir, "../../..");
const WEB = join(ROOT, "apps/web");
// the backend the static site proxies to: --site, else UNITS_SITE (set it in the Vercel project), else the site of
// the repository's default network (config/profile.json `network`, mainnet: config/sites.json mainnet_site_url,
// the deployed mainnet deployment). The devnet backend is config/sites.json devnet_site_url: pass it as --site or UNITS_SITE.
const DEFAULT_SITE = (profileConfig as { network: string }).network === "devnet" ? sites.devnet_site_url : sites.mainnet_site_url;
const SITE = arg("site", process.env.UNITS_SITE || DEFAULT_SITE).replace(/\/+$/, "");
const OUT = arg("out", join(WEB, "dist"));

const DOCS_URL = (process.env.UNITS_DOCS_URL || sites.docs_url).replace(/\/+$/, "");
const DOCS_PERMANENT = process.env.UNITS_DOCS_REDIRECT === "301";
// the bundles link to the docs through apps/web/src/docs-url.ts
const DOCS_DEFINE = { __UNITS_DOCS_URL__: JSON.stringify(DOCS_URL) };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "assets"), { recursive: true });

async function bundle(entry: string, extra: Partial<Parameters<typeof Bun.build>[0]> = {}) {
  const out = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, sourcemap: "none", ...extra, define: { ...DOCS_DEFINE, ...(extra.define ?? {}) } });
  if (!out.success) throw new Error(out.logs.map(String).join("\n"));
  return out.outputs[0]!.text();
}
writeFileSync(join(OUT, "assets/app.js"), await bundle(join(WEB, "src/main.ts")));
writeFileSync(join(OUT, "assets/wallet.js"), await bundle(join(WEB, "wallet/main.ts"), { format: "esm", plugins: [chainBrowserPlugin] }));
// the Privy login island (React), loaded on demand by the Connect button
writeFileSync(join(OUT, "assets/privy.js"), await bundle(join(WEB, "privy/main.tsx"), { format: "esm", define: { "process.env.NODE_ENV": JSON.stringify("production"), global: "globalThis" } }));
cpSync(join(WEB, "public/app.css"), join(OUT, "assets/app.css"));
cpSync(join(WEB, "public/favicon.png"), join(OUT, "favicon.png"));
cpSync(join(WEB, "public/logo.png"), join(OUT, "logo.png"));
cpSync(join(WEB, "public/fonts"), join(OUT, "fonts"), { recursive: true });
cpSync(join(WEB, "public/doodles"), join(OUT, "doodles"), { recursive: true });
cpSync(join(WEB, "public/providers"), join(OUT, "providers"), { recursive: true });
// The dashboard's shell is the page for "/" and the rewrite target for every client-side route.
cpSync(join(WEB, "public/index.html"), join(OUT, "index.html"));
cpSync(join(WEB, "public/index.html"), join(OUT, "app.html"));

// the same page policy Caddy sets on the site (one source: the Caddyfile template); both pages carry
// only the inline theme script it allows by hash (gate.test.ts checks)
const CSP = /Content-Security-Policy "([^"]+)"/.exec(readFileSync(join(ROOT, "scripts/deploy/caddy/Caddyfile.tmpl"), "utf8"))?.[1];
if (!CSP) throw new Error("no Content-Security-Policy in scripts/deploy/caddy/Caddyfile.tmpl");

const vercel = {
  cleanUrls: true,
  trailingSlash: false,
  // pages removed by the app consolidation go to what replaced them
  redirects: Object.entries({ "/network": "/", "/live": "/", "/explorer": "/", "/tokens": "/", "/wallet": "/profile", "/spawn": "/launch", "/manual": `${DOCS_URL}/`, "/trading": "/" }).map(([source, destination]) => ({ source, destination, permanent: false })).concat([
    { source: "/docs", destination: `${DOCS_URL}/`, permanent: DOCS_PERMANENT },
    { source: "/docs/:page", destination: `${DOCS_URL}/:page`, permanent: DOCS_PERMANENT },
  ]),
  rewrites: [
    // every path the pages call on the site: /runtime (binding a launched agent to the hosted runtime) and
    // /identity (the units account) were missing, so a launch from this build could not finish
    ...["api", "live", "chain", "souls", "market", "embed", "desktops", "runtime", "identity", "coin", "social"].map((p) => ({ source: `/${p}/:path*`, destination: `${SITE}/${p}/:path*` })),
    { source: "/:path*", destination: "/app" },
  ],
  headers: [
    { source: "/assets/(.*)", headers: [{ key: "cache-control", value: "public, max-age=60" }] },
    { source: "/(api|live|chain|souls|market|embed|runtime|identity)/(.*)", headers: [{ key: "cache-control", value: "no-store" }] },
    { source: "/fonts/(.*)", headers: [{ key: "cache-control", value: "public, max-age=86400" }] },
    // audit A2: the page policy and the usual headers hold for every page
    {
      source: "/(.*)",
      headers: [
        { key: "content-security-policy", value: CSP },
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
