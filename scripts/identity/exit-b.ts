#!/usr/bin/env bun
// Exit run of the identity service (plan AUDIT-AND-IDENTITY B) against the live site. Devnet only;
// the deployer and launcher keys stay on this machine and are passed explicitly (never `solana config`).
//
//   bun scripts/identity/exit-b.ts launch --label <l> --mode purchased|token --recipe <r> --name <persona name>
//       launch_agent (+ set_profile with a hand-written TEST soul in the same transaction) by the devnet
//       launcher on the recipe's repository, fund its compute vault to the wake threshold, refresh_awake,
//       and store the signed soul in the site's Core (over ssh to 127.0.0.1:9660; the gate is read only)
//   bun scripts/identity/exit-b.ts author --label <l> --recipe <r> --candidate <name> --target <metric>
//       run a scripted author for that agent on the server (transient unit lineage-b-author-<l>) submitting
//       one prepared candidate of recipes/<r>/candidates with a single metric target
//   bun scripts/identity/exit-b.ts token --label <l> --login <pool login>
//       submit that pool account's token as the pasted token, over the site's HTTPS, bound by a statement
//       the launcher signs (the token is read from the pool file and never printed)
//   bun scripts/identity/exit-b.ts revoke --label <l>
//   bun scripts/identity/exit-b.ts status --label <l>
// Every devnet transaction is appended to scripts/deploy/SITE-DEVNET.md; results (no secrets) to
// scripts/identity/EXIT-B-LAST.json.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalUrl, signStatement } from "@lineage/protocol";
import { ata, ChainReader, IDENTITY_MODE, launch, launchPdas, loadKeypair, loadOrCreateKeypair, registry, Rpc, sendAndConfirm, token, TOKEN_2022_PROGRAM, type Signer } from "@lineage/chain";
import { DEVNET_GENESIS } from "../../packages/chain/src/browser/client.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { checkSoul, signSoul, soulDigest } from "../../packages/souls/src/doc.ts";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { persona, SEED } from "../../packages/souls/test/fixtures.ts";
import { DEFAULT_POOL, Pool } from "../../packages/souls/src/github/pool.ts";
import { PURPOSE, tokenSha256 } from "../../packages/identity/src/statement.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HOST = "157.245.71.188";
const SITE = "https://157-245-71-188.sslip.io";
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const need = (k: string) => opt(k) ?? (console.error(`--${k} is required`), process.exit(2));
const label = need("label");
const KEYS = join(homedir(), ".config", "lineage", "devnet");
const LOGMD = join(ROOT, "scripts/deploy/SITE-DEVNET.md");
const RESULTS = join(import.meta.dir, "EXIT-B-LAST.json");
const results: Record<string, any> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : {};
const save = (k: string, v: unknown) => {
  results[label] = { ...(results[label] ?? {}), [k]: v };
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
};
const log = (m: string) => console.log(`[exit-b] ${m}`);
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
const reader = new ChainReader(rpc);
const launcher = loadKeypair(join(KEYS, "launcher.json"));
const agentFile = join(KEYS, `agent-b-${label}.json`);

function ssh(script: string, input?: string): string {
  const r = spawnSync("ssh", ["-i", join(homedir(), ".ssh/lineage_site"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", `root@${HOST}`, script], { input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ssh failed: ${r.stderr.slice(0, 400)}`);
  return r.stdout.trim();
}
function logTx(what: string, signature: string, fee?: number) {
  appendFileSync(LOGMD, `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | identity B | ${what} | ${fee ?? "?"} | \`${signature}\` |\n`);
}
async function send(what: string, payer: Signer, ixs: any[], o: { signers?: Signer[]; computeUnits?: number } = {}) {
  const r = await sendAndConfirm(rpc, payer, ixs, { ...o, log: (m) => log(`  ${m}`) });
  logTx(what, r.signature, r.fee);
  log(`${what}: ${r.signature}`);
  return r.signature;
}
const repoOf = (recipe: string) => canonicalUrl(/^repo:\s*"?([^"\s]+)"?/m.exec(readFileSync(join(ROOT, "recipes", recipe, "recipe.yml"), "utf8"))![1]!);

if ((await rpc.call<string>("getGenesisHash", [])) !== DEVNET_GENESIS) throw new Error("RPC is not devnet; refusing");

if (cmd === "launch") {
  const mode = need("mode") as "purchased" | "token";
  const recipe = need("recipe");
  const dep = loadKeypair(join(homedir(), ".config", "lineage", "devnet-deployer.json"));
  const { key: agent } = loadOrCreateKeypair(agentFile);
  const { key: mint } = loadOrCreateKeypair(join(KEYS, `agent-b-${label}-mint.json`));
  const url = repoOf(recipe);
  const name = need("name");
  const doc = newSoul({ agent: agent.id, seed: SEED, persona: persona({ name, tagline: `${name} keeps hot loops boring and every change measured.` }), created_at: Math.floor(Date.now() / 1000), origin: { by: "launcher", model: null, prompt_version: null } });
  const errs = checkSoul(doc);
  if (errs.length) throw new Error(`soul: ${errs.join("; ")}`);
  if (!(await reader.agentLaunch(mint.id))) {
    const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
    const devnet = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8"));
    const sym = `TB${label.toUpperCase().replace(/[^A-Z0-9]/g, "")}`.slice(0, 10);
    const sig = await send(`launch_agent (identity ${mode}) + set_profile: TEST agent ${agent.id} on ${url}, mint ${mint.id}`, launcher, [
      launch.launchAgent({
        launcher: launcher.id, agent: agent.id, agentMint: mint.id, lineMint: devnet.line_mint, dbcConfig: devnet.dbc_config, lineTokenProgram: TOKEN_2022_PROGRAM,
        args: { name: `TEST identity ${label}`.slice(0, 32), symbol: sym, uri: `https://lineage.invalid/devnet/agents/identity-${label}.json`, repoUrl: url, identityMode: IDENTITY_MODE[mode], hosted: false },
      }),
      registry.setProfile({ signingKey: agent.id, agent: agent.id, digest: soulDigest(doc), seq: doc.seq }),
    ], { signers: [agent, mint], computeUnits: 450_000 });
    const want = BigInt(net.wake_threshold) + 500n * 10n ** 6n;
    const vault = launchPdas.computeVault(agent.id);
    await send(`send ${want} tLINE base units to identity-${label} compute vault ${vault}`, dep, [token.transferChecked(ata(dep.id, devnet.line_mint, TOKEN_2022_PROGRAM), devnet.line_mint, vault, dep.id, want, 6, TOKEN_2022_PROGRAM)]);
    await send(`refresh_awake for identity-${label} ${agent.id}`, dep, [launch.refreshAwake({ agent: agent.id, agentMint: mint.id })]);
    save("launch", { agent: agent.id, mint: mint.id, mode, repo: url, signature: sig, at: new Date().toISOString() });
  } else log(`already launched: ${agent.id}`);
  // the soul into the site's Core (public once Core's chain sync sees the launch)
  const body = JSON.stringify({ doc, sig: signSoul(agent, doc) });
  for (let i = 0; i < 30; i++) {
    const out = ssh(`curl -s -m 20 -X PUT -H 'content-type: application/json' --data-binary @- http://127.0.0.1:9660/v1/agents/${agent.id}/soul`, body);
    log(`soul PUT: ${out.slice(0, 200)}`);
    if (/"seq"/.test(out)) {
      save("soul", { digest: soulDigest(doc), name, stored: JSON.parse(out) });
      break;
    }
    await Bun.sleep(10_000);
  }
  console.log(agent.id);
} else if (cmd === "author") {
  const recipe = need("recipe");
  const cand = need("candidate");
  const target = need("target");
  const idx = JSON.parse(readFileSync(join(ROOT, "recipes", recipe, "candidates/index.json"), "utf8"))[cand];
  if (!idx) throw new Error(`no candidate ${cand}`);
  const diff = readFileSync(join(ROOT, "recipes", recipe, "candidates", `${cand}.diff`), "utf8");
  const key = readFileSync(agentFile, "utf8");
  const dir = `/var/lib/lineage/site/b-${label}`;
  const keyPath = `/home/lineage/.config/lineage/devnet/agent-b-${label}.json`;
  ssh(`set -e; umask 077; cat > ${keyPath}.tmp; chown lineage:lineage ${keyPath}.tmp; mv ${keyPath}.tmp ${keyPath}`, key);
  const index = JSON.stringify({ [cand]: { kind: idx.kind, target, note: `${idx.note} (single-metric target for the identity exit run)`, lines: idx.lines, guard: idx.guard } });
  ssh(`set -e; install -d -o lineage -g lineage -m 750 ${dir}; cat > ${dir}/${cand}.diff; chown lineage:lineage ${dir}/${cand}.diff`, diff);
  ssh(`set -e; cat > ${dir}/index.json; chown lineage:lineage ${dir}/index.json`, index);
  const unit = `lineage-b-author-${label}`;
  log(ssh(`systemctl stop ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null; systemd-run --unit ${unit} --uid lineage --gid lineage -p WorkingDirectory=/opt/lineage/current -p MemoryMax=1G -p KillSignal=SIGTERM -p TimeoutStopSec=1200 --setenv=HOME=/home/lineage --setenv=LINEAGE_HOME=/home/lineage/.lineage --setenv=PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/bun packages/worker/src/main.ts run --core http://127.0.0.1:9660 --key ${keyPath} --proposer scripted --script ${dir} --capabilities /var/lib/lineage/site/caps.json --interval 5000 2>&1; echo started ${unit}`));
  save("author", { recipe, candidate: cand, target, unit, at: new Date().toISOString() });
} else if (cmd === "token" || cmd === "revoke" || cmd === "status") {
  const agent = loadKeypair(agentFile).id;
  const mint = loadKeypair(join(KEYS, `agent-b-${label}-mint.json`)).id;
  let r: Response;
  if (cmd === "status") r = await fetch(`${SITE}/identity/agents/${agent}`);
  else if (cmd === "token") {
    const login = need("login");
    const pool = new Pool(DEFAULT_POOL);
    const a = pool.read().accounts.find((x) => x.login === login);
    if (!a || a.status !== "available") throw new Error(`${login} is not an available pool account`);
    const st = { v: 1, kind: "lineage-identity-token", agent, mint, signer: launcher.id, token_sha256: tokenSha256(a.token), created_at: Math.floor(Date.now() / 1000) };
    const check = await fetch(`${SITE}/identity/token/check`, { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ token: a.token }) });
    const cj = await check.json();
    log(`check: HTTP ${check.status} ${JSON.stringify(cj)}`);
    save("token_check", cj);
    r = await fetch(`${SITE}/identity/token`, { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ statement: st, sig: signStatement(launcher, PURPOSE, st), token: a.token }) });
    if (r.ok) pool.update(login, { status: "assigned", assigned_agent: agent, assigned_at: new Date().toISOString(), note: "pasted-token exit run of the identity service (lane B, 2026-10-09): its token was submitted as a token-mode agent's own token" });
  } else {
    const st = { v: 1, kind: "lineage-identity-revoke", agent, mint, signer: launcher.id, created_at: Math.floor(Date.now() / 1000) };
    r = await fetch(`${SITE}/identity/revoke`, { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ statement: st, sig: signStatement(launcher, PURPOSE, st) }) });
  }
  const j = await r.json();
  log(`${cmd}: HTTP ${r.status} ${JSON.stringify(j, null, 2)}`);
  save(cmd, { http: r.status, view: j, at: new Date().toISOString() });
} else {
  console.error("unknown command");
  process.exit(2);
}
