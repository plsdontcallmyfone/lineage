#!/usr/bin/env bun
// Lineage site status, read only. Runs on the server (deploy.sh status calls it).
//
//   bun scripts/deploy/site-status.ts [--core http://127.0.0.1:9660] [--web http://127.0.0.1:9661] [--gate http://127.0.0.1:9662]
//
// Prints: Core health and epoch, the chain view Core last read (slot, epochs posted, whether Core
// signs as the Core authority, registry vault balances), the site's verifiers as Core sees them
// (bond read from chain, qualified lineages, eligibility), lineages and their heights, the
// faucet's state from the dashboard, SOL of the Core authority and the site owner, and the gate.
// Public keys only.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSolanaJson } from "@lineage/protocol";
import { Rpc } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const CORE = arg("core", "http://127.0.0.1:9660");
const WEB = arg("web", "http://127.0.0.1:9661");
const GATE = arg("gate", "http://127.0.0.1:9662");
const SITE = join(homedir(), ".config", "lineage", "site");
const get = async (u: string): Promise<any> => {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : { _status: r.status };
  } catch (e) {
    return { _error: (e as Error).message };
  }
};
const line = (base: string | undefined, dec = 6) => (base === undefined || base === null ? "?" : `${(Number(base) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 6 })} tLINE`);
const pub = (n: string) => {
  const p = join(SITE, `${n}.json`);
  return existsSync(p) ? keyFromSolanaJson(JSON.parse(readFileSync(p, "utf8"))).id : null;
};

const health = await get(`${CORE}/v1/health`);
console.log(`core      ${health.ok ? `ok, epoch ${health.epoch}` : `DOWN ${JSON.stringify(health)}`}`);
const chain = await get(`${CORE}/v1/chain`);
if (chain.read_at) {
  const ageS = Math.round((Date.now() - chain.read_at) / 1000);
  console.log(`chain     slot ${chain.slot}, read ${ageS} s ago, epochs posted ${chain.epochs_posted} (last ${chain.last_epoch}), Core signs as authority: ${chain.core_signing ? "yes" : "no (read only)"}`);
  const b = chain.balances ?? {};
  console.log(`vaults    treasury ${line(b.treasury)}, reserve ${line(b.reserve)}, pool ${line(b.pool)}, payable ${line(b.payable)}, bonds ${line(b.bond_vault)}`);
} else console.log(`chain     not read yet ${JSON.stringify(chain).slice(0, 120)}`);
const lineages = await get(`${CORE}/v1/lineages`);
if (Array.isArray(lineages)) {
  console.log(`lineages  ${lineages.length}`);
  for (const l of lineages) console.log(`          ${l.recipe_name ?? l.name ?? "?"} ${String(l.lineage_id).slice(0, 12)}... height ${l.height ?? "?"} ${l.status ?? ""}`);
}
for (const n of ["verifier-ref", "verifier-v1", "verifier-v2"]) {
  const id = pub(n);
  if (!id) continue;
  const v = await get(`${CORE}/v1/agents/${id}`);
  console.log(
    `${n.padEnd(13)} ${id}: ${v._status === 404 ? "not in Core (not registered on chain yet)" : `bond ${line(v.bond)}, qualified ${v.qualified_lineages?.length ?? 0}, eligible ${v.eligible}, suspended ${v.suspended}, strikes ${v.strikes_total}`}`,
  );
}
const faucet = await get(`${WEB}/chain/faucet`);
console.log(`faucet    ${faucet.enabled ? "enabled" : `disabled (${faucet.reason ?? JSON.stringify(faucet).slice(0, 80)})`}${faucet.address ? `, ${faucet.address}` : ""}${faucet.sol_lamports !== undefined ? `, ${(Number(faucet.sol_lamports) / 1e9).toFixed(6)} SOL` : ""}${faucet.line_base_units !== undefined ? `, ${line(faucet.line_base_units)}` : ""}`);
const rpc = Rpc.http(devnetRpcUrl());
for (const [label, id] of [["core auth", chain.core_authority], ["site owner", pub("owner")]] as const) {
  if (!id) continue;
  const bal = await rpc.getBalance(id).catch(() => null);
  console.log(`${label.padEnd(9)} ${id}: ${bal === null ? "?" : (Number(bal) / 1e9).toFixed(6)} SOL`);
}
const gate = await get(`${GATE}/gate/health`);
console.log(`gate      ${gate.ok ? `ok, ${gate.streams} open streams, ${gate.buckets} rate buckets` : `DOWN ${JSON.stringify(gate)}`}`);
const web = await get(`${WEB}/live/status`);
console.log(`web       ${web.upstream ? `Core stream ${web.upstream}, ${web.held} events held` : `DOWN ${JSON.stringify(web)}`}`);
