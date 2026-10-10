#!/usr/bin/env bun
// Agent journal local network run (SPEC 17.6). A real Core (simulated mode) on --port (default 9663),
// fixture-b58 calibrated by a real reference runner, two bonded verifiers replaying in the docker
// sandbox, and one launched agent with a soul authoring with real Claude through the worker
// (journal on). Session 1 ends with a journal entry; once its candidate (if any) is final, session 2
// starts with session 1's entry in its system prompt as the agent's own notes. The run records the
// requests (to show the notes reached the model), session 2's notes (the model's text between tool
// calls) and both entries, and checks the sealing on the way. Claude spend is capped at --cap USD
// (default 1) over the whole run, metered from the API's usage fields; logged in scripts/journal/RUNS.md.
//
//   bun scripts/journal/local-run.ts [--port 9663] [--attempt-usd 0.4] [--cap 1]
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, journalEntryId, verifyJournal, type AgentKey } from "@lineage/protocol";
import { loadRecipe, prepareDeps } from "@lineage/sandbox";
import { CoreClient } from "../../packages/core/src/client.ts";
import { loadModelEnv } from "../../packages/runtime/src/config.ts";
import { newSoul, signSoul } from "../../packages/souls/src/doc.ts";
import { persona, SEED } from "../../packages/souls/test/fixtures.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { AnthropicProposer } from "../../packages/worker/src/proposers/anthropic.ts";
import { check, child, log, ok, portFree, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9663"));
const ATTEMPT_USD = Number(opt("attempt-usd", "0.4"));
const CAP_USD = Number(opt("cap", "1"));
const CORE = `http://127.0.0.1:${PORT}`;
const RUNS = join(ROOT, "scripts/journal/RUNS.md");
portFree(PORT);

const tmp = mkdtempSync(join(tmpdir(), "lineage-journal-run-"));
const keys = { admin: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), a: generateAgentKey(), launcher: generateAgentKey() };
const kp: Record<string, string> = {};
for (const n of ["admin", "ref", "v1", "v2"] as const) {
  kp[n] = join(tmp, `${n}.json`);
  writeFileSync(kp[n]!, JSON.stringify(Array.from(keys[n].secret)), { mode: 0o600 });
}
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 900, replay_window_min_s: 900, epoch_length_s: 86400, qualify_retry_s: 60 });
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);
const ONE = 10n ** BigInt(net.token_decimals);

let usd = 0;
const requests: { kind: string; system: string }[] = [];

/** The real client, with every request's system prompt recorded. */
function recordingClient(real: any): any {
  return {
    beta: {
      messages: {
        stream: (req: any, o?: any) => (requests.push({ kind: "turn", system: String(req.system) }), real.beta.messages.stream(req, o)),
        create: (req: any, o?: any) => (requests.push({ kind: "journal", system: String(req.system) }), real.beta.messages.create(req, o)),
      },
    },
  };
}

async function main() {
  if (!loadModelEnv()) throw new Error("no model key in ~/.config/lineage/model.env");
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--tick-ms", "500"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);

  const loaded = loadRecipe(join(ROOT, "recipes/fixture-b58"));
  const deps = await prepareDeps(loaded);
  await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
  const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
  const caps = doctor().capabilities;
  for (const n of ["ref", "v1", "v2"] as const) {
    await ok(admin.post("/v1/admin/faucet", { agent: keys[n].id, amount: (BigInt(net.register_burn) + BigInt(net.min_bond) * 2n).toString() }), "faucet");
    await ok(as(keys[n]).post("/v1/agents", { capabilities: caps }), `register ${n}`);
    if (n !== "ref") await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: String(net.min_bond) }), `bond ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  log("reference runner calibrating fixture-b58 in the sandbox");
  await new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) }).submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
  const L = (await ok<any[]>(anon.get("/v1/lineages"), "lineages"))[0].lineage_id as string;
  for (const n of ["ref", "v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => v.qualified_lineages.includes(L));
  });
  check("verifiers qualified on fixture-b58", true, L.slice(0, 12));

  await ok(admin.post("/v1/admin/launches", { agent: keys.a.id, mint: generateAgentKey().id, launcher: keys.launcher.id, target_repo: loaded.recipe.repo, hosted: false, identity_mode: "app" }), "launch");
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.a.id, amount: ((4n * ONE * 10_000n + 6999n) / 7000n).toString() }), "fees");
  const doc = newSoul({ agent: keys.a.id, seed: SEED, persona: persona(), created_at: Math.floor(Date.now() / 1000), origin: { by: "launcher", model: null, prompt_version: null } });
  await ok(anon.request("PUT", `/v1/agents/${keys.a.id}/soul`, { doc, sig: signSoul(keys.a, doc) }), "soul");
  check("agent launched with a soul", true, `${keys.a.id.slice(0, 8)} (${doc.persona.name})`);

  const lines: string[] = [];
  const proposer = new AnthropicProposer({ max_usd: ATTEMPT_USD, effort: "medium" });
  (proposer as any).client = recordingClient((proposer as any).client);
  const w = new Worker({
    core: CORE,
    key: keys.a,
    proposer,
    lineages: [L],
    stateDir: join(tmp, "agent"),
    journal: true,
    collab: "off",
    log: (m) => (lines.push(m), console.log(`   A    ${m}`)),
    attempt: () => {
      const left = CAP_USD - usd;
      if (left < 0.15) return null;
      return { maxUsd: Math.min(ATTEMPT_USD, left), meter: { model: (u) => (usd += u.usd), sandbox: () => {} } };
    },
  });
  await w.telemetry.start();

  const sessionOf = async (n: number) =>
    waitFor(`session ${n} with its journal entry`, async () => {
      const own = await ok<any>(as(keys.a).get(`/v1/agents/${keys.a.id}/journal`, true), "own journal");
      return own.entries.length >= n ? own.entries[0] : null;
    }, 60_000, 1000);

  // session 1
  log("session 1");
  const c1 = await w.authorOnce();
  await w.telemetry.flush();
  const e1 = await sessionOf(1).catch(() => null);
  check("session 1 wrote a signed journal entry", !!e1 && verifyJournal(keys.a.id, e1.sig, e1.statement) && journalEntryId(e1.statement) === e1.entry_id, e1 ? `${e1.text.length} chars` : lines.filter((l) => l.startsWith("journal")).join(" | "));
  if (!e1) throw new Error("no entry from session 1");
  check("the entry was written with a small call inside the attempt cap", requests.some((r) => r.kind === "journal"), `${usd.toFixed(4)} USD so far`);
  if (c1) {
    const pub = await ok<any>(anon.get(`/v1/agents/${keys.a.id}/journal`), "public journal");
    check("while session 1's candidate is open its entry is not public", pub.entries.length === 0, `candidate ${c1.slice(0, 10)}`);
    await waitFor("session 1's candidate final", async () => {
      const own = await ok<any[]>(as(keys.a).get(`/v1/candidates?lineage=${L}&author=${keys.a.id}&limit=10`, true), "cands");
      return own.find((c) => c.commit_id === c1 && ["accepted", "rejected", "expired"].includes(c.status)) ?? null;
    }, 20 * 60_000, 3000);
  }
  const pub1 = await ok<any>(anon.get(`/v1/agents/${keys.a.id}/journal`), "public journal");
  check("session 1's entry is public after its verdict (or at once without a candidate)", pub1.entries.length === 1 && pub1.entries[0].entry_id === e1.entry_id, pub1.entries[0]?.candidate ? `candidate ${pub1.entries[0].candidate.status}` : "no candidate");

  // session 2: session 1's entry is in its system prompt
  log("session 2");
  const before = requests.length;
  const c2 = await w.authorOnce();
  await w.telemetry.flush();
  const turns2 = requests.slice(before).filter((r) => r.kind === "turn");
  const firstSys = turns2[0]?.system ?? "";
  check("session 2's system prompt carries session 1's entry, labelled as its own notes", firstSys.includes("Your own notes (your journal)") && e1.text.split(/\n+/).every((l: string) => firstSys.includes(l.trim())), `${turns2.length} turns`);
  const e2 = await sessionOf(2).catch(() => null);
  check("session 2 wrote its own entry", !!e2 && e2.entry_id !== e1.entry_id, e2 ? `${e2.text.length} chars` : "none");
  const sessions = await ok<any[]>(as(keys.a).get(`/v1/sessions?agent=${keys.a.id}&limit=10`, true), "sessions");
  const s2 = sessions[0];
  const v2 = await ok<any>(as(keys.a).get(`/v1/sessions/${s2.session_id}`, true), "session 2");
  const notes2 = v2.event_list.filter((x: any) => x.kind === "note").map((x: any) => x.text as string);
  const quotes = notes2.filter((t: string) => /journal|notes?\b|last session|previous session|earlier session|last time/i.test(t));
  check("session 2's reasoning refers to its notes", quotes.length > 0, quotes[0]?.slice(0, 300) ?? `${notes2.length} notes`);
  check("Claude spend within the cap", usd <= CAP_USD, `${usd.toFixed(4)} of ${CAP_USD} USD`);

  const out = {
    at: new Date().toISOString(),
    agent: keys.a.id,
    lineage: L,
    usd: Number(usd.toFixed(4)),
    session1: { candidate: c1, entry: e1.text, entry_id: e1.entry_id, verdict: pub1.entries[0]?.candidate?.status ?? null },
    session2: { candidate: c2, notes: notes2, entry: e2?.text ?? null },
    results,
  };
  writeFileSync(join(ROOT, "scripts/journal/LOCAL-LAST.json"), JSON.stringify(out, null, 2));
  if (!existsSync(RUNS)) writeFileSync(RUNS, "# Agent journal runs (SPEC 17.6)\n\nClaude spend of each real run, metered from the API's usage fields at the published per-token prices.\n\n| When (UTC) | Run | Claude USD | Note |\n|---|---|---|---|\n");
  appendFileSync(RUNS, `| ${out.at.replace("T", " ").slice(0, 19)} | local network, 2 sessions | ${usd.toFixed(4)} | ${results.filter((r) => r.ok).length}/${results.length} checks; session 1 ${c1 ? `candidate ${pub1.entries[0]?.candidate?.status}` : "no candidate"}, session 2 ${c2 ? "candidate" : "no candidate"} |\n`);
  await w.telemetry.stop();
}

try {
  await main();
} catch (e) {
  console.error(e);
  check("run completed", false, (e as Error).message);
} finally {
  await stopAll();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed; Claude ${usd.toFixed(4)} USD`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.check}${r.detail ? `: ${r.detail}` : ""}`);
  process.exit(pass === results.length ? 0 : 1);
}
