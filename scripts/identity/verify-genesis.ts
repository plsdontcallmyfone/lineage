#!/usr/bin/env bun
// Verifies a GitHub genesis proof (docs/plans/GITHUB-GENESIS.md 3): lineage-proof.json from an agent's
// profile repository <login>/<login>.
//
//   bun scripts/identity/verify-genesis.ts <proof.json | https://github.com/<login>/<login> | raw URL>
//       [--core <Lineage site or Core base URL>]   also check the signer against the agent's key history
//       [--chain]                                   also check the signer is the agent's current registry key (devnet RPC)
//
// Offline (a local file, no flags): shape and signature only. Exit 0 when every check run passes.
import { readFileSync } from "node:fs";
import { genesisStatementOf, verifyGenesis, GENESIS_FILES } from "../../packages/identity/src/genesis-proof.ts";

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--core");
const core = argv.includes("--core") ? argv[argv.indexOf("--core") + 1]!.replace(/\/+$/, "") : null;
if (!src) {
  console.error("usage: verify-genesis.ts <proof.json | https://github.com/<login>/<login> | raw URL> [--core <url>] [--chain]");
  process.exit(2);
}

const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};

let text: string;
let urlOwner: string | null = null;
if (/^https?:\/\//.test(src)) {
  let raw = src;
  const repo = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(src);
  const blob = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/blob\/([^/]+)\/(.+)$/.exec(src);
  if (repo) {
    // the units file name first, then the pre-rebrand one (docs/plans/REBRAND-UNITS.md 3.9)
    raw = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/${GENESIS_FILES[0]}`;
    if ((await fetch(raw, { method: "HEAD", redirect: "error" }).catch(() => null))?.status !== 200) raw = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/${GENESIS_FILES[1]}`;
  }
  else if (blob) raw = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  const m = /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\//.exec(raw);
  if (m) {
    urlOwner = m[1]!.toLowerCase();
    check("the repository is the account's profile repository <login>/<login>", m[1]!.toLowerCase() === m[2]!.toLowerCase(), `${m[1]}/${m[2]}`);
  }
  const r = await fetch(raw, { redirect: "error" });
  if (!r.ok) {
    check("fetch the proof", false, `HTTP ${r.status} for ${raw}`);
    process.exit(1);
  }
  text = await r.text();
} else {
  text = readFileSync(src, "utf8");
}

const v = verifyGenesis(text);
check("shape and signature (ed25519 by signer, purpose github-genesis, over the canonical statement)", v.ok, v.ok ? "" : v.reason);
if (!v.ok && !v.file) process.exit(1);
const f = v.ok ? v.file : v.file!;
console.log(JSON.stringify(genesisStatementOf(f), null, 2));
if (urlOwner) check("github_login is the repository owner", f.github_login === urlOwner, f.github_login);

if (core && f.signer) {
  const base = core.includes("/v1") ? core : `${core}/v1`;
  const h: any = await fetch(`${base}/agents/${f.agent}/keys`).then((r) => r.json()).catch(() => null);
  const t = f.issued_at * 1000;
  const keys: { signing_key: string | null; valid_from: number | null; valid_to: number | null }[] = h?.keys ?? [];
  const at = keys.filter((k) => (k.valid_from ?? 0) <= t && (k.valid_to === null || k.valid_to > t)).pop();
  check("signer was the agent's signing key at issued_at (Lineage key history)", !!at && at.signing_key === f.signer, at ? `key at issued_at ${at.signing_key}` : "no key history");
  const g: any = await fetch(`${base}/agents/${f.agent}/genesis`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  check("Lineage recorded this proof as verified", g?.status === "verified" && g?.handle === f.github_login, g ? `${g.status} for ${g.handle}` : "no record");
}

if (argv.includes("--chain") && f.signer) {
  const { ChainReader, Rpc } = await import("../../packages/chain/src/index.ts");
  const { devnetRpcUrl } = await import("../../packages/chain/src/endpoint.ts");
  const rec = await new ChainReader(Rpc.http(devnetRpcUrl(), "confirmed")).agent(f.agent).catch(() => null);
  check("signer is the agent's current registry signing key (chain)", rec?.signingKey === f.signer, rec ? `registry key ${rec.signingKey}` : "no registry record");
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks pass`);
process.exit(failed ? 1 : 0);
