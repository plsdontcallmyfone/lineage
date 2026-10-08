// Identity lane proof (FINISH.md W5; identity plan I3, I6), against a local chain-mode Core on devnet.
//
//   1. Core in chain mode on its own data directory (port 9667), synced from the devnet registry, so
//      it knows the souls lane's TEST agent 6C8N2z5L... (launched, purchased GitHub identity).
//   2. Gist proof on that agent's pool account (owunqwxs): a public gist holding the agent-signed
//      link statement; Core verifies it. The gist is then deleted and Core's own recheck job (the
//      tick, link_recheck_s set short for the run) marks the link broken.
//   3. A second gist is posted and verified; it stays as the live proof.
//   4. Domain proof: a local test server (port 9668) serves /.well-known/lineage-agent.json; Core
//      verifies it (the test host is allowed over http by LINEAGE_LINK_HTTP_HOSTS, tests only).
//   5. ERC-8004 registration file: every field the EIP lists, and its registrations entry resolves
//      on devnet to the agent's registry PDA (owned by the registry program, decoding to the agent).
//
// Usage: bun scripts/identity/proof.ts [--live-gist <url of the live proof gist, reused instead of posting a new one>]
// The pool token is read from ~/.config/lineage/github-pool.json and never printed or stored.
// Output: scripts/identity/PROOF-LAST.json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addressBytes, ChainReader, pda, Rpc } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { CoreClient } from "../../packages/core/src/client.ts";
import { domainProofJson, linkStatement, proofText, signLink } from "../../packages/core/src/links.ts";
import { keyFromSolanaJson } from "../../packages/core/src/protocol.ts";
import { key, KEY_DIR, loadState } from "../devnet/lib.ts";
import { signSoul } from "../../packages/souls/src/doc.ts";

const ROOT = join(import.meta.dir, "../..");
const CORE_PORT = 9667;
const DOMAIN_PORT = 9668;
const LOGIN = "owunqwxs";
const AGENT_FILE = join(KEY_DIR, "souls-test-agent.json");
const RECHECK_S = 15;
const OUT = join(import.meta.dir, "PROOF-LAST.json");

const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};
const out: Record<string, unknown> = { at: new Date().toISOString() };

function poolToken(login: string): string {
  const pool = JSON.parse(readFileSync(join(homedir(), ".config/lineage/github-pool.json"), "utf8"));
  const items: any[] = Array.isArray(pool) ? pool : pool.accounts ?? Object.values(pool);
  const a = items.find((x) => x?.login === login);
  if (!a?.token) throw new Error(`pool account ${login} has no token`);
  return a.token as string;
}
const TOKEN = poolToken(LOGIN);
const gh = (method: string, path: string, body?: unknown) =>
  fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "lineage-identity-proof", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function createGist(text: string, note: string): Promise<{ id: string; url: string }> {
  const r = await gh("POST", "/gists", { description: `Lineage agent link proof (${note})`, public: true, files: { "lineage-agent-proof.md": { content: text } } });
  if (r.status !== 201) throw new Error(`gist create answered ${r.status}`);
  const g = (await r.json()) as { id: string; html_url: string };
  return { id: g.id, url: g.html_url };
}

function portFree(p: number) {
  const busy = Bun.spawnSync(["lsof", "-ti", `:${p}`]).stdout.toString().trim();
  if (busy) throw new Error(`port ${p} is in use by ${busy}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  portFree(CORE_PORT);
  portFree(DOMAIN_PORT);
  const agent = keyFromSolanaJson(JSON.parse(readFileSync(AGENT_FILE, "utf8")));
  const state = loadState() as any;
  const rpcUrl = devnetRpcUrl();
  out.agent = agent.id;
  out.github_login = LOGIN;

  // ---- Core (chain mode, devnet) ----
  const tmp = mkdtempSync(join(tmpdir(), "lineage-identity-core-"));
  const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
  net.chain = { mode: "devnet", rpc_url: rpcUrl, registry_program: state.registry_program, launch_program: state.launch_program, line_mint: state.line_mint, core_authority_key: null, poll_ms: 3_600_000 };
  writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
  const admin = key("identity-test-core-admin");
  const core = Bun.spawn(
    ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(CORE_PORT), "--config", join(tmp, "network.json"), "--admin-key", join(KEY_DIR, "identity-test-core-admin.json"), "--tick-ms", "1000", "--no-trees"],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env, LINEAGE_LINK_RECHECK_S: String(RECHECK_S), LINEAGE_LINK_HTTP_HOSTS: `127.0.0.1:${DOMAIN_PORT}`, LINEAGE_DEVNET_RPC: rpcUrl } },
  );
  let domainBody: string | null = null;
  const domain = Bun.serve({
    port: DOMAIN_PORT,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname === "/.well-known/lineage-agent.json" && domainBody ? new Response(domainBody, { headers: { "content-type": "application/json" } }) : new Response("not found", { status: 404 })),
  });
  const base = `http://127.0.0.1:${CORE_PORT}`;
  const A = new CoreClient(base, admin as any);
  const me = new CoreClient(base, agent);
  const anon = new CoreClient(base, null);
  const testGists: string[] = [];
  try {
    for (let i = 0; ; i++) {
      if ((await fetch(`${base}/v1/health`).catch(() => null))?.ok) break;
      if (i > 120) throw new Error("Core did not start");
      await sleep(1000);
    }
    for (let i = 0; ; i++) {
      const r = await A.post("/v1/admin/chain/sync", {});
      if (r.status < 300) break;
      if (i > 20) throw new Error(`chain sync failed: ${JSON.stringify(r.body)}`);
      await sleep(5000);
    }
    const av = await anon.get(`/v1/agents/${agent.id}`);
    check("Core (chain mode) knows the TEST agent from the devnet registry", av.status === 200 && av.body.kind === "launched", `kind ${av.body.kind}, identity ${av.body.identity_mode}, signing key ${av.body.identity?.signing_key}`);

    // ---- gist proof, then delete it and let the recheck job mark it broken ----
    const st1 = signLink(agent, linkStatement(agent.id, "github", LOGIN, Date.now() / 1000));
    const g1 = await createGist(proofText(st1), "test, deleted after the check");
    testGists.push(g1.id);
    out.test_gist = g1.url;
    let r = await me.post(`/v1/agents/${agent.id}/links`, { service: "github", handle: LOGIN, proof_url: g1.url });
    check("gist proof on the pool account verifies", r.status === 200 && r.body.status === "verified", `${g1.url}: HTTP ${r.status} ${r.body.status ?? r.body.message}`);
    const d = await gh("DELETE", `/gists/${g1.id}`);
    check("test gist deleted on GitHub", d.status === 204, `HTTP ${d.status}`);
    if (d.status === 204) testGists.splice(testGists.indexOf(g1.id), 1);
    const t0 = Date.now();
    let after: any = null;
    for (;;) {
      await sleep(3000);
      const l = await anon.get(`/v1/agents/${agent.id}/links`);
      after = l.body.find((x: any) => x.service === "github");
      if (after?.status === "broken" || Date.now() - t0 > 120_000) break;
    }
    check("Core's recheck job (tick) marks the link broken after the gist is gone", after?.status === "broken", `status ${after?.status} after ${Math.round((Date.now() - t0) / 1000)} s: ${after?.detail}`);
    out.broken_link = after;

    // ---- the live proof gist (stays) ----
    const reuse = process.argv.includes("--live-gist") ? process.argv[process.argv.indexOf("--live-gist") + 1]! : null;
    const g2 = reuse ? { id: reuse.split("/").pop()!, url: reuse } : await createGist(proofText(signLink(agent, linkStatement(agent.id, "github", LOGIN, Date.now() / 1000))), "live");
    out.live_gist = g2.url;
    r = await me.post(`/v1/agents/${agent.id}/links`, { service: "github", handle: LOGIN, proof_url: g2.url });
    check("live gist proof verifies (this gist stays)", r.status === 200 && r.body.status === "verified", `${g2.url}`);
    out.github_link = r.body;

    // ---- domain proof on a local test server ----
    const host = `127.0.0.1:${DOMAIN_PORT}`;
    domainBody = domainProofJson([signLink(agent, linkStatement(agent.id, "domain", host, Date.now() / 1000))]);
    r = await me.post(`/v1/agents/${agent.id}/links`, { service: "domain", handle: host });
    check("domain proof served at /.well-known/lineage-agent.json verifies", r.status === 200 && r.body.status === "verified", `${r.body.proof_url ?? r.body.message}`);
    out.domain_link = r.body;
    out.domain_file = JSON.parse(domainBody);

    // ---- the agent's profile: its soul versions (souls lane, digests on chain), so the file is generated from it ----
    for (const f of ["soul-a.json", "soul-a-v2.json"]) {
      const doc = JSON.parse(readFileSync(join(ROOT, "scripts/souls/proof", f), "utf8"));
      const p = await fetch(`${base}/v1/agents/${agent.id}/soul`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, sig: signSoul(agent, doc) }) });
      if (!p.ok) throw new Error(`soul ${f}: HTTP ${p.status}`);
    }
    const soul = await anon.get(`/v1/agents/${agent.id}/soul`);
    check("profile (soul) stored and its digest matches the registry's profile_digest", soul.body.onchain?.matches === true, `${soul.body.doc?.persona?.name}, seq ${soul.body.seq}, ${soul.body.digest}`);

    // ---- card and ERC-8004 registration file ----
    const card = await anon.get(`/v1/agents/${agent.id}/card`);
    out.card = card.body;
    check("agent card lists both verified links", card.status === 200 && card.body.lineage?.links?.length === 2, card.body.lineage?.links?.map((l: any) => `${l.service}:${l.handle}`).join(", "));
    const reg = await anon.get(`/v1/agents/${agent.id}/registration.json`);
    out.registration = reg.body;
    check("registration file is generated from the profile (name, digest)", reg.body.name === soul.body.doc?.persona?.name && reg.body.lineage?.profile_digest === soul.body.digest, `${reg.body.name}, ${reg.body.lineage?.profile_digest}`);
    const fields = ["type", "name", "description", "image", "services", "x402Support", "active", "registrations", "supportedTrust"];
    const missing = fields.filter((f) => !(f in (reg.body ?? {})));
    check("registration file has every field ERC-8004 lists", reg.status === 200 && !missing.length && reg.body.type === "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", missing.length ? `missing ${missing.join(", ")}` : fields.join(", "));
    const e = reg.body.registrations?.[0] ?? {};
    const okEntry = typeof e.agentId === "string" && typeof e.agentRegistry === "string";
    check("registrations entry has agentId and agentRegistry", okEntry, `${e.agentRegistry} / ${e.agentId}`);
    const [ns, ref, program] = String(e.agentRegistry).split(":");
    const rpc = Rpc.http(rpcUrl, "confirmed");
    const genesis = await rpc.call<string>("getGenesisHash", []).catch(() => null as string | null);
    check("agentRegistry chain is the cluster Core reads (devnet genesis)", ns === "solana" && !!genesis && genesis.startsWith(ref!), `${ns}:${ref}, getGenesisHash ${genesis}`);
    const derived = pda(program!, "agent", addressBytes(e.agentId));
    const acct = await rpc.getAccountInfo(derived);
    const rec = await new ChainReader(rpc, program!).agent(e.agentId);
    check(
      "registrations entry resolves on devnet to the agent's registry PDA",
      derived === e.agentAccount && !!acct && acct.owner === program && rec?.agent === agent.id,
      `PDA ${derived} (file says ${e.agentAccount}), owner ${acct?.owner}, decoded agent ${rec?.agent}, profile seq ${rec?.profileSeq}`,
    );
    out.pda = { address: derived, owner: acct?.owner, lamports: String(acct?.lamports ?? ""), agent: rec?.agent, profile_seq: rec?.profileSeq, profile_digest: rec?.profileDigest };
    out.links = (await anon.get("/v1/links")).body;
  } finally {
    for (const id of testGists) await gh("DELETE", `/gists/${id}`).catch(() => undefined);
    domain.stop(true);
    core.kill();
    await core.exited;
    rmSync(tmp, { recursive: true, force: true });
  }
  out.checks = checks;
  writeFileSync(OUT, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed; ${OUT}`);
  process.exit(failed ? 1 : 0);
}

await main();
