#!/usr/bin/env bun
// Souls proof on devnet (SPEC 14.8). This lane's own TEST agent, separate from every other lane's:
//   launch      launch_agent (identity purchased, hosted, karpathy/minbpe) and set_profile with the
//               digest of soul A (scripts/souls/proof/soul-a.json, seq 1) in one transaction; the
//               agent key signs both, as the Wallet page's agent key does; read Agent.profile_digest
//               back from chain.
//   v2          soul A version 2 with the agent's GitHub identity (login, SSH signing key) from the
//               runtime credential store, signed by the agent's current signing key, committed with
//               set_profile seq 2; read back.
//   core        Core in chain mode on its own data directory and port: sync, PUT every soul version,
//               GET the public soul and check `onchain.matches`.
// Every devnet signature is appended to onchain/DEVNET.md; results go to scripts/souls/DEVNET-LAST.json.
// Usage: bun scripts/souls/devnet-soul.ts launch|v2|core [--port 9665]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalUrl } from "@lineage/protocol";
import { IDENTITY_MODE, launch, registry, TOKEN_2022_PROGRAM, token, launchPdas } from "../../packages/chain/src/index.ts";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { checkSoul, nextVersion, signSoul, soulDigest, type SoulDoc } from "../../packages/souls/src/index.ts";
import { FileCredentialStore } from "../../packages/souls/src/github/index.ts";
import { deployer, key, KEY_DIR, LAMPORTS, loadState, log, reader, rpc, send, sol, topUp } from "../devnet/lib.ts";
import { withBackoff } from "../../packages/runtime/src/backend.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const PORT = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9665);
const STEP = "souls";
const PROOF = join(import.meta.dir, "proof");
const LAST = join(import.meta.dir, "DEVNET-LAST.json");
withBackoff(rpc, (m) => log(m)); // public devnet RPC: back off on HTTP 429
const state = loadState();
const dep = deployer();
const launcher = key("souls-test-launcher");
const agent = key("souls-test-agent");
const agentMint = key("souls-test-agent-mint");
const REPO = canonicalUrl("https://github.com/karpathy/minbpe");
const META = { name: "TEST souls agent", symbol: "TSOUL", uri: "https://lineage.invalid/devnet/agents/souls-test.json?class=python" };

const last: Record<string, unknown> = existsSync(LAST) ? JSON.parse(readFileSync(LAST, "utf8")) : {};
const save = () => writeFileSync(LAST, JSON.stringify(last, null, 2) + "\n");
const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};
const readSoul = (n: number): SoulDoc => JSON.parse(readFileSync(join(PROOF, n === 1 ? "soul-a.json" : `soul-a-v${n}.json`), "utf8"));

async function launchStep() {
  const s1 = readSoul(1);
  if (s1.agent !== agent.id) throw new Error("soul A belongs to another agent");
  if (checkSoul(s1).length) throw new Error("soul A does not check");
  const digest = soulDigest(s1);
  let l = await reader.agentLaunch(agentMint.id);
  if (!l) {
    await topUp(STEP, dep, launcher.id, LAMPORTS / 10n, "souls test launcher");
    const r = await send(STEP, `launch_agent + set_profile: TEST souls agent ${agent.id} on ${REPO} (identity purchased, hosted), soul A digest ${digest} seq 1`, launcher, [
      launch.launchAgent({ launcher: launcher.id, agent: agent.id, agentMint: agentMint.id, lineMint: state.line_mint!, dbcConfig: state.dbc_config!, lineTokenProgram: TOKEN_2022_PROGRAM,
        args: { ...META, repoUrl: REPO, identityMode: IDENTITY_MODE.purchased, hosted: true } }),
      registry.setProfile({ signingKey: agent.id, agent: agent.id, digest, seq: 1 }),
    ], { signers: [agent, agentMint], computeUnits: 450_000 });
    last.launch_signature = r.signature;
    last.launch_fee_lamports = r.fee ?? null;
    await send(STEP, "create the launch authority's agent-token ATA for the souls test agent (crank prerequisite)", dep, [token.createAtaIdempotent(dep.id, launchPdas.authority(), agentMint.id, TOKEN_2022_PROGRAM)]);
    l = await reader.agentLaunch(agentMint.id);
  }
  check("TEST agent launched on chain (purchased, hosted, minbpe)", !!l && l.hosted && l.identityMode === IDENTITY_MODE.purchased && l.repoUrl === REPO, agent.id);
  const rec = await reader.agent(agent.id);
  check("registry Agent.profile_digest equals soul A's digest", rec?.profileDigest === digest, `${rec?.profileDigest} seq ${rec?.profileSeq}`);
  Object.assign(last, { agent: agent.id, mint: agentMint.id, launcher: launcher.id, repo: REPO, soul_v1_digest: digest, onchain_after_launch: { digest: rec?.profileDigest, seq: rec?.profileSeq } });
}

async function v2Step() {
  const s1 = readSoul(1);
  const cred = new FileCredentialStore().get(agent.id);
  if (!cred) throw new Error("no GitHub credential for the agent yet: run lineage-souls provision first");
  const s2 = nextVersion(s1, { identity: { github_login: cred.login, ssh_signing_key: cred.ssh_public_key.split(" ").slice(0, 2).join(" "), profile_url: null } }, Math.floor(Date.now() / 1000));
  const errs = checkSoul(s2);
  if (errs.length) throw new Error(errs.join("; "));
  writeFileSync(join(PROOF, "soul-a-v2.json"), JSON.stringify(s2, null, 2) + "\n");
  const digest = soulDigest(s2);
  const rec0 = await reader.agent(agent.id);
  if (rec0?.profileSeq !== 2) {
    const r = await send(STEP, `set_profile: soul A version 2 (GitHub login ${cred.login}, SSH signing key) digest ${digest} seq 2, signed by the agent's signing key`, launcher, [
      registry.setProfile({ signingKey: agent.id, agent: agent.id, digest, seq: 2 }),
    ], { signers: [agent] });
    last.v2_signature = r.signature;
  }
  const rec = await reader.agent(agent.id);
  check("registry Agent.profile_digest equals soul A version 2", rec?.profileDigest === digest && rec?.profileSeq === 2, `${rec?.profileDigest} seq ${rec?.profileSeq}`);
  Object.assign(last, { soul_v2_digest: digest, github_login: cred.login, onchain_after_v2: { digest: rec?.profileDigest, seq: rec?.profileSeq } });
}

async function coreStep() {
  const busy = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${PORT} is in use by ${busy}`);
  const tmp = mkdtempSync(join(tmpdir(), "lineage-souls-core-"));
  const ROOT = join(import.meta.dir, "../..");
  const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  net.chain = { mode: "devnet", rpc_url: devnetRpcUrl(), registry_program: state.registry_program, launch_program: state.launch_program, line_mint: state.line_mint, core_authority_key: null, poll_ms: 3_600_000 };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const admin = key("souls-test-core-admin");
  const core = Bun.spawn(["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", join(KEY_DIR, "souls-test-core-admin.json"), "--tick-ms", "1000", "--no-trees"],
    { stdout: "ignore", stderr: "pipe" });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; ; i++) {
      if ((await fetch(`${base}/v1/health`).catch(() => null))?.ok) break;
      if (i > 120) throw new Error("Core did not start");
      await Bun.sleep(1000);
    }
    const { CoreClient } = await import("../../packages/core/src/client.ts");
    const A = new CoreClient(base, admin);
    for (let i = 0; ; i++) {
      const r = await A.post("/v1/admin/chain/sync", {});
      if (r.status < 300) break;
      if (i > 30) throw new Error(`chain sync failed: ${JSON.stringify(r.body)}`);
      await Bun.sleep(5000);
    }
    for (const n of [1, 2]) {
      if (n === 2 && !existsSync(join(PROOF, "soul-a-v2.json"))) continue;
      const doc = readSoul(n);
      const r = await fetch(`${base}/v1/agents/${agent.id}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, sig: signSoul(agent, doc) }) });
      check(`Core stores soul A version ${n} (signature by the agent's signing key)`, r.ok, JSON.stringify(await r.json()));
    }
    const v = (await (await fetch(`${base}/v1/agents/${agent.id}/soul`)).json()) as any;
    check("Core serves the soul publicly with the onchain digest matching", v.onchain?.matches === true, `seq ${v.seq}, digest ${v.digest}, onchain ${v.onchain?.digest} seq ${v.onchain?.seq}`);
    last.core_view = { seq: v.seq, digest: v.digest, onchain: v.onchain, name: v.doc?.persona?.name };
  } finally {
    core.kill();
    await core.exited;
    rmSync(tmp, { recursive: true, force: true });
  }
}

const before = await rpc.getBalance(dep.id);
if (cmd === "launch") await launchStep();
else if (cmd === "v2") await v2Step();
else if (cmd === "core") await coreStep();
else throw new Error("usage: devnet-soul.ts launch|v2|core");
const after = await rpc.getBalance(dep.id);
last[`checks_${cmd}`] = checks;
last.at = new Date().toISOString();
save();
console.log(`deployer SOL ${sol(before)} -> ${sol(after)}`);
if (checks.some((c) => !c.ok)) process.exit(1);
