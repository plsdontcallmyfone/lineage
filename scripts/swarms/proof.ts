#!/usr/bin/env bun
// Swarms proof, local and simulated, with real sandboxes and real model calls (docs/plans/SWARMS.md 9,
// phase 0 item 5 run locally). A real Core with the `swarms` flag on (for this process only), a real
// reference runner and two bonded verifiers on TWO units of one repository (keis/base58: base58-py and
// base58-py-heavy), ONE hosted TEST agent whose signed soul declares three seats on three models, and
// `units-runtime run` as its own process, bound to the one key it generated. Every model call goes
// through OpenRouter (the registry's route rule; no other provider key is passed on).
//
// What is checked:
//   - the seats take different targets, on different units first;
//   - no candidate of the swarm ends `stale` or `stale_conflict` (another seat's candidate never
//     invalidates it), and a candidate committed while another one of the swarm was open on its unit
//     depends on it;
//   - at least one candidate is replayed and accepted, and its provenance names the seat that wrote it;
//   - the vault is debited one amount per usage epoch, and the seats' lines inside it add up to it;
//   - a low vault shrinks the swarm from its highest seat down, then the agent sleeps.
//
// Prices and caps are TEST values. Model spend is bounded twice: by the vault, and by the runtime's
// cap over every USD (`global_max_usd`, scope "all").
// Usage: bun scripts/swarms/proof.ts [--port 9663] [--vault-usd 4.6] [--cap-usd 4.5] [--minutes 80] [--serve]
//   --serve: after the checks, leave Core running (for the page checks) until this process is stopped.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentKey, type AgentKey } from "@units/protocol";
import { loadRecipe, prepareDeps } from "@units/sandbox";
import { buildSwarm, defaultLead, newSoul, signSoul, soulDigest } from "../../packages/souls/src/doc.ts";
import { persona, SEED } from "../../packages/souls/test/fixtures.ts";
import { CoreClient } from "../../packages/core/src/client.ts";
import { doctor } from "../../packages/worker/src/doctor.ts";
import { Worker } from "../../packages/worker/src/index.ts";
import { check, child, log, ok, portFree, results, ROOT, stopAll, waitFor } from "../runtime/lib.ts";
import { E2BBackend, loadE2BKey, type E2BApi } from "../../packages/desktop/src/e2b.ts";
import { streamIdOf } from "../../packages/desktop/src/agent-desktops.ts";
import { slotKey } from "../../packages/runtime/src/swarm.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const PORT = Number(opt("port", "9663"));
const VAULT_USD = Number(opt("vault-usd", "4.6"));
const CAP_USD = Number(opt("cap-usd", "4.5"));
const MINUTES = Number(opt("minutes", "80"));
const SERVE = argv.includes("--serve");
// --desktops: one real E2B desktop per seat (desktop_mode per_agent, this run's own owner label): the
// seats' stream ids, and the charge of seats 2 and up to the vault. Only this run's sandboxes are touched.
const DESKTOPS = argv.includes("--desktops");
const OWNER = `swarms-proof-${Date.now().toString(36)}`;
const CORE = `http://127.0.0.1:${PORT}`;
portFree(PORT);

const RUNS = join(ROOT, "scripts/swarms/RUNS.md");
const tmp = mkdtempSync(join(tmpdir(), "units-swarms-proof-"));
const writeKey = (name: string, k: AgentKey) => {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(k.secret)), { mode: 0o600 });
  return p;
};
const keys = { admin: generateAgentKey(), runtime: generateAgentKey(), ref: generateAgentKey(), v1: generateAgentKey(), v2: generateAgentKey(), agent: generateAgentKey() };
const kp = Object.fromEntries(Object.entries(keys).filter(([n]) => n !== "agent").map(([n, k]) => [n, writeKey(n, k)])) as Record<string, string>;
const net = JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8"));
Object.assign(net, { canary_rate: 0, audit_rate: 0, reveal_window_s: 900, replay_window_min_s: 900, epoch_length_s: 86400, qualify_retry_s: 60, max_open_replays: 4 });
net.features = { ...net.features, swarms: true }; // this Core only
writeFileSync(join(tmp, "network.json"), JSON.stringify(net));
const admin = new CoreClient(CORE, keys.admin);
const anon = new CoreClient(CORE, null);
const as = (k: AgentKey) => new CoreClient(CORE, k);
const ONE = 10n ** BigInt(net.token_decimals);
const stateDir = join(tmp, "runtime");

// the seats: three models, all reached through OpenRouter; the lead is the priciest (registry output price)
const registry = JSON.parse(readFileSync(join(ROOT, "config/models.json"), "utf8")) as { models: { provider: string; id: string; rate?: { output: number } }[] };
const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-5-5" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openai", id: "gpt-5-mini" },
];
const priceOf = (m: { provider: string; id: string }) => registry.models.find((x) => x.provider === m.provider && x.id === m.id)?.rate?.output ?? null;
const LEAD = defaultLead(MODELS, priceOf);

// every model call must go through OpenRouter (the registry's route rule prefers it when its key is on this host)
if (!/^OPENROUTER_API_KEY=.{8,}/m.test(readFileSync(join(process.env.HOME!, ".config/lineage/providers.env"), "utf8"))) throw new Error("no OPENROUTER_API_KEY in ~/.config/lineage/providers.env");

let spent = 0;
let note = "incomplete";
let e2bApi: E2BApi | null = null;
const e2b = async () => (e2bApi ??= await new E2BBackend({ root: tmp }).api());
if (DESKTOPS && !loadE2BKey()) throw new Error("--desktops needs the E2B key (e2b.env)");

async function main() {
  child("core", ["bun", join(ROOT, "packages/core/src/main.ts"), "--data", join(tmp, "data"), "--port", String(PORT), "--config", join(tmp, "network.json"), "--admin-key", kp.admin!, "--runtime-key", kp.runtime!, "--tick-ms", "500", "--no-trees"]);
  await waitFor("core", async () => (await fetch(`${CORE}/v1/health`).catch(() => null))?.ok);
  const sc = await ok(anon.get("/v1/swarms/config"), "swarms config");
  check("Core serves swarms with the flag on for this process", sc.enabled === true && sc.settings.max_members >= 3, `max_members ${sc.settings.max_members}, min credits per seat ${sc.min_usd_per_seat} USD (prepay.min_usd), screen of seats past ${sc.settings.seat_desktop_free_seats}: ${sc.settings.seat_desktop_usd_per_h} USD an hour`);

  // ---------------------------------------------------------------- two units of one repository, and the verifiers
  const caps = doctor().capabilities;
  for (const n of ["ref", "v1", "v2"] as const) {
    await ok(admin.post("/v1/admin/faucet", { agent: keys[n].id, amount: (BigInt(net.register_burn) + BigInt(net.min_bond) * 2n).toString() }), "faucet");
    await ok(as(keys[n]).post("/v1/agents", { capabilities: caps }), `register ${n}`);
    if (n !== "ref") await ok(as(keys[n]).post(`/v1/agents/${keys[n].id}/bond`, { amount: String(net.min_bond) }), `bond ${n}`);
  }
  await ok(admin.post(`/v1/admin/agents/${keys.ref.id}/reference`, { reference: true }), "reference");
  const units: { name: string; lineage: string; targets: string[] }[] = [];
  let repo = "";
  const refWorker = new Worker({ core: CORE, key: keys.ref, log: (m) => console.log(`   ref  ${m}`) });
  for (const name of ["base58-py", "base58-py-heavy"]) {
    const loaded = loadRecipe(join(ROOT, "recipes", name));
    const deps = await prepareDeps(loaded);
    repo = loaded.recipe.repo;
    await ok(admin.post("/v1/admin/recipes", { recipe: loaded.recipe, recipe_id: loaded.recipe_id }), "recipe");
    const snap = await ok(admin.post("/v1/admin/snapshots", { repo: loaded.recipe.repo, commit: loaded.recipe.commit, deps_digest: deps.digest }), "snapshot");
    log(`reference runner calibrating ${name} in the sandbox (3 runs)`);
    await refWorker.submitCalibration(loaded.recipe_id, snap.snapshot_id, 3);
    const all = await ok<any[]>(anon.get("/v1/lineages"), "lineages");
    const l = all.find((x) => !units.some((u) => u.lineage === x.lineage_id))!;
    const view = await ok(anon.get(`/v1/lineages/${l.lineage_id}`), "lineage");
    units.push({ name, lineage: l.lineage_id, targets: loaded.recipe.metrics.filter((m) => view.calibration?.metrics?.[m.name]?.enabled).map((m) => m.name) });
  }
  check("two active units of one repository", units.length === 2 && units.every((u) => u.targets.length >= 2), units.map((u) => `${u.name} ${u.lineage.slice(0, 10)}: ${u.targets.join(", ")}`).join("; "));
  for (const n of ["ref", "v1", "v2"]) child(n, ["bun", join(ROOT, "packages/worker/src/main.ts"), "run", "--core", CORE, "--key", kp[n]!, "--interval", "1500"]);
  await waitFor("verifiers qualified on both units", async () => {
    const vs = await Promise.all(["v1", "v2"].map((n) => ok(anon.get(`/v1/agents/${keys[n as "v1"].id}`), n)));
    return vs.every((v) => units.every((u) => v.qualified_lineages.includes(u.lineage)));
  }, 30 * 60_000);
  check("verifiers qualified on both units", true);

  // ---------------------------------------------------------------- the swarm: one agent, three seats in its signed soul
  const soul = { ...newSoul({ agent: keys.agent.id, seed: SEED, persona: persona(), created_at: Math.floor(Date.now() / 1000), origin: { by: "launcher" as const, model: null, prompt_version: null } }), model: MODELS[0]!, swarm: buildSwarm(MODELS.map((m, i) => ({ name: `Wren ${i + 1}`, model: m })), LEAD) };
  const stored = await ok(anon.request("PUT", `/v1/agents/${keys.agent.id}/soul`, { doc: soul, sig: signSoul(keys.agent, soul) }, { sign: false }), "soul");
  await ok(admin.post("/v1/admin/launches", { agent: keys.agent.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: repo, hosted: true, identity_mode: "app" }), "launch");
  const perUsd = Number(net.prepay.compute_price_line_per_usd);
  const vaultBase = BigInt(Math.round(VAULT_USD * perUsd * 1000)) * (ONE / 1000n);
  const fees = (vaultBase * 10_000n + BigInt(net.agent_compute_bps) - 1n) / BigInt(net.agent_compute_bps);
  await ok(admin.post("/v1/admin/agent-fees", { agent: keys.agent.id, amount: fees.toString() }), "fees");
  const v0 = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent");
  const sv0 = await ok(anon.get(`/v1/agents/${keys.agent.id}/swarm`), "swarm view");
  check("one registered agent, one vault, three seats from its signed soul", stored.digest === soulDigest(soul) && sv0.size === 3 && sv0.lead === LEAD && v0.awake === true,
    `soul digest ${stored.digest.slice(0, 12)} (what set_profile commits), seats ${sv0.seats.map((s: any) => `${s.seat} ${s.name} ${s.role} ${s.model.id}`).join(", ")}; vault ${v0.compute} base units (${VAULT_USD} USD at the TEST rate)`);
  const agents = await ok<any[]>(anon.get("/v1/agents"), "agents");
  check("the swarm is one agent in every list", agents.filter((a) => a.kind === "launched").length === 1);

  const cfg = {
    _note: "TEST values (prices, caps)",
    mode: "sim",
    core: CORE,
    state_dir: stateDir,
    runtime_key: kp.runtime,
    effort: "medium",
    attempt_max_usd: 0.5,
    global_max_usd: CAP_USD,
    global_cap_scope: "all",
    min_attempt_usd: 0.1,
    compute_price_line_per_usd: net.prepay.compute_price_line_per_usd,
    compute_price_line_per_sandbox_s: net.prepay.compute_price_line_per_sandbox_s,
    sandbox_reserve_s: 300,
    usage_epoch_s: 600,
    close_when_exhausted: true,
    poll_ms: 3000,
    max_concurrent: 3,
    attempt_gap_s: 20,
    efficiency: { cap_mode: "bounded", series: true, keep_alive_s: 240, pace: true, spread: true, journal_reserve_usd: 0.04, spread_intent_ttl_s: 1800 },
    lineages: units.map((u) => u.lineage),
    // posts and the follow step are other features of the runtime with their own model calls: off here, so every metered USD is a seat's
    posts: { enabled: false },
    follows: { enabled: false },
    spend_report_s: 10,
    ...(DESKTOPS
      ? { desktops_max: 0, e2b_max: 3, desktop_usd_per_day: 1, desktop_required: true, desktop_mode: "per_agent", desktop_owner: OWNER, desktop_idle_s: 1800, desktop_keepalive_s: 300, desktop_remove_after_s: 300, desktop_start_parallel: 3, desktop_mask: false, e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 3600 } }
      : {}),
  };
  writeFileSync(join(tmp, "runtime-config.json"), JSON.stringify(cfg, null, 2));
  const lines: { at: number; l: string }[] = [];
  const rt = child("rt", ["bun", join(ROOT, "packages/runtime/src/main.ts"), "run", "--config", join(tmp, "runtime-config.json")], (l) => lines.push({ at: Date.now(), l }));
  const reqFile = join(stateDir, "bind-requests", `${keys.agent.id}.json`);
  const req = await waitFor("bind request", async () => (existsSync(reqFile) ? JSON.parse(readFileSync(reqFile, "utf8")) : null), 60_000, 500);
  await ok(as(keys.agent).post(`/v1/agents/${keys.agent.id}/keys/rotate`, req.body), "rotate");
  const keysView = await ok(anon.get(`/v1/agents/${keys.agent.id}/keys`), "keys");
  check("bound with ONE signature: every seat speaks with the one runtime key", keysView.signing_key === req.body.new_key && keysView.seq === 1, `runtime key ${String(req.body.new_key).slice(0, 8)}, key seq ${keysView.seq}`);

  // ---------------------------------------------------------------- work until the vault is spent
  const placed = () => lines.map((x) => /s(\d) seat \d \((lead|builder)\): unit ([0-9a-f]{10}), target (\w+) "([^"]+)"(, on (\d+) open)?/.exec(x.l)).filter(Boolean).map((m) => ({ seat: Number(m![1]), role: m![2]!, unit: m![3]!, target: m![5]!, stacked: Number(m![7] ?? 0) }));
  await waitFor("three seats placed", async () => new Set(placed().map((p) => p.seat)).size >= 3, 10 * 60_000, 2000).catch((e) => log(String(e)));
  const first = [1, 2, 3].map((s) => placed().find((p) => p.seat === s)).filter(Boolean) as ReturnType<typeof placed>;
  check("the seats take different targets", first.length === 3 && new Set(first.map((p) => `${p.unit}:${p.target}`)).size === 3, first.map((p) => `seat ${p.seat} (${p.role}): ${units.find((u) => u.lineage.startsWith(p.unit))?.name} ${p.target}`).join("; "));
  check("units first: both units have a seat before either has two", new Set(first.slice(0, 2).map((p) => p.unit)).size === 2 || new Set(first.map((p) => p.unit)).size === 2, `${new Set(first.map((p) => p.unit)).size} units in work by ${first.length} seats`);

  let deskSeen: any[] | null = null;
  const live: Record<string, number> = {};
  let maxLive = 0;
  const seenStates = new Set<string>();
  const end = Date.now() + MINUTES * 60_000;
  let mine: any[] = [];
  for (;;) {
    const a = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent").catch(() => null);
    mine = await ok<any[]>(admin.get(`/v1/candidates?author=${keys.agent.id}&limit=200`, true), "candidates").catch(() => mine);
    const sv = await ok(anon.get(`/v1/agents/${keys.agent.id}/swarm`), "swarm").catch(() => null);
    if (sv) {
      const withSession = sv.seats.filter((s: any) => s.session);
      maxLive = Math.max(maxLive, withSession.length);
      for (const s of sv.seats) {
        if (s.session) live[s.seat] = (live[s.seat] ?? 0) + 1;
        if (s.runtime) seenStates.add(`${s.seat}:${s.runtime.state}`);
        if (s.runtime?.desktop?.state === "paused" && /vault low/i.test(s.runtime.desktop.why ?? "")) seenStates.add(`${s.seat}:desktop paused (vault low)`);
      }
    }
    if (DESKTOPS && sv && !deskSeen && sv.seats.every((s: any) => s.runtime?.desktop?.state === "running" && s.runtime.desktop.stream)) deskSeen = sv.seats.map((s: any) => ({ seat: s.seat, ...s.runtime.desktop }));
    const open = mine.filter((c) => ["committed", "waiting", "queued", "replaying", "disputed"].includes(c.status));
    if (rt.exitCode !== null) log(`runtime exited with ${rt.exitCode}`);
    if (a && (!a.awake || rt.exitCode !== null) && open.length === 0) break;
    if (Date.now() > end) {
      log(`time limit of ${MINUTES} minutes reached with ${open.length} candidate(s) open`);
      break;
    }
    await Bun.sleep(5000);
  }
  // graceful stop: the open usage epoch is closed and posted
  if (rt.exitCode === null) {
    rt.kill("SIGTERM");
    await rt.exited;
  }
  mine = await ok<any[]>(admin.get(`/v1/candidates?author=${keys.agent.id}&limit=200`, true), "candidates");
  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  spent = state.spent_usd_total as number;

  // ---------------------------------------------------------------- checks
  check("each seat held its own live session at Core (public like any session)", maxLive >= 2 && Object.keys(live).length >= 2, `seats seen in a session: ${Object.keys(live).join(", ")}; most at once: ${maxLive}`);
  const stale = mine.filter((c) => c.reason === "stale" || c.reason === "stale_conflict");
  check("no candidate of the swarm was made stale", mine.length > 0 && stale.length === 0, `${mine.length} candidate(s): ${mine.map((c) => `${c.commit_id.slice(0, 8)} ${c.status}${c.reason ? ` ${c.reason}` : ""}`).join(", ")}`);
  // every candidate committed while another of the swarm was open on its unit depends on it
  const byUnit = new Map<string, any[]>();
  for (const c of mine) (byUnit.get(c.lineage_id) ?? byUnit.set(c.lineage_id, []).get(c.lineage_id)!).push(c);
  let overlaps = 0;
  let linked = 0;
  for (const cs of byUnit.values()) {
    cs.sort((x, y) => x.committed_at - y.committed_at);
    for (const [i, c] of cs.entries()) {
      const before = cs.slice(0, i).filter((p) => (p.finalized_at ?? Infinity) > c.committed_at);
      if (!before.length) continue;
      overlaps++;
      const view = await ok(admin.get(`/v1/candidates/${c.commit_id}`, true), "candidate");
      if (view.series?.depends_on && before.some((p) => p.commit_id === view.series.depends_on)) linked++;
    }
  }
  check("a candidate committed beside an open one of the swarm on its unit depends on it (one stack per unit)", overlaps === linked, `${overlaps} such candidate(s), ${linked} stacked`);
  const final = mine.filter((c) => ["accepted", "rejected", "expired"].includes(c.status));
  const seatsOfFinal: string[] = [];
  let seatOk = final.length > 0;
  let modelOk = true;
  for (const c of final) {
    const p = await anon.get(`/v1/candidates/${c.commit_id}/provenance`);
    const seat = p.status === 200 ? p.body.record.seat : null;
    seatOk = seatOk && p.status === 200 && p.body.signer === keys.runtime.id && Number.isInteger(seat) && seat >= 1 && seat <= 3 && p.body.record.agent === keys.agent.id;
    const want = MODELS[(seat ?? 1) - 1]!;
    const ran = p.status === 200 ? p.body.record.route?.model : null;
    modelOk = modelOk && !!ran && ran.id === want.id && p.body.record.route.via === "openrouter";
    seatsOfFinal.push(`${c.commit_id.slice(0, 8)} ${c.status} by seat ${seat} (${ran?.id ?? "?"} via ${p.body?.record?.route?.via ?? "?"})`);
  }
  check("every final candidate is authored by the swarm's agent id and names its seat (attested by the runtime, published once final)", seatOk, seatsOfFinal.join("; "));
  check("each seat ran the model its soul names, through OpenRouter", final.length > 0 && modelOk, MODELS.map((m, i) => `seat ${i + 1}: ${m.id}`).join(", "));
  const acc = mine.filter((c) => c.status === "accepted");
  const sv = await ok(anon.get(`/v1/agents/${keys.agent.id}/swarm`), "swarm");
  const accSeats = sv.seats.filter((s: any) => s.totals.accepted > 0).map((s: any) => `seat ${s.seat} ${s.name}: ${s.totals.accepted} accepted of ${s.totals.final} final`);
  check("at least one candidate was replayed and accepted, with its seat on the record", acc.length > 0 && accSeats.length > 0, `${acc.length} accepted; ${accSeats.join("; ")}`);
  // still-open candidates name no seat publicly
  const stillOpen = mine.filter((c) => !["accepted", "rejected", "expired"].includes(c.status));
  let blind = true;
  for (const c of stillOpen) blind = blind && (await anon.get(`/v1/candidates/${c.commit_id}/provenance`)).status === 409;
  check("an open candidate's seat is withheld", blind, `${stillOpen.length} still open`);

  const usage = await ok(anon.get(`/v1/agents/${keys.agent.id}/usage`), "usage");
  const after = await ok(anon.get(`/v1/agents/${keys.agent.id}`), "agent");
  const debited = usage.records.reduce((s: bigint, r: any) => s + BigInt(r.amount), 0n);
  check("the vault paid exactly the posted amounts, one record per usage epoch for the whole swarm", BigInt(v0.compute) - BigInt(after.compute) === debited && debited > 0n, `vault ${v0.compute} -> ${after.compute}, ${debited} base units in ${usage.records.length} record(s)`);
  let once = usage.records.length > 0;
  const seatLines: string[] = [];
  const seatTotal: Record<string, { usd: number; sandbox_s: number; attempts: number }> = {};
  for (const r of usage.records) {
    const d = r.detail ?? {};
    const seats = (d.seats ?? {}) as Record<string, { usd: number; sandbox_s: number; desktop_usd: number; attempts: number }>;
    const sum = Object.values(seats).reduce((x, s) => ({ usd: x.usd + s.usd, sandbox_s: x.sandbox_s + s.sandbox_s, desktop_usd: x.desktop_usd + s.desktop_usd }), { usd: 0, sandbox_s: 0, desktop_usd: 0 });
    // the record's cost is the cost of the seats' lines together (the amount is that cost, or the vault's whole balance when it could not pay it)
    const whole = Math.abs(sum.usd - Number(d.usd)) < 2e-6 && Math.abs(Math.ceil(sum.sandbox_s) - Number(d.sandbox_s)) <= Object.keys(seats).length && BigInt(d.cost) >= BigInt(r.amount);
    once = once && Object.keys(seats).length > 0 && whole;
    for (const [k, s] of Object.entries(seats)) {
      const t = (seatTotal[k] ??= { usd: 0, sandbox_s: 0, attempts: 0 });
      t.usd += s.usd;
      t.sandbox_s += s.sandbox_s;
      t.attempts += s.attempts;
    }
    seatLines.push(`epoch ${d.usage_epoch}: ${r.amount} base units = ${Object.entries(seats).map(([k, s]) => `seat ${k} ${s.usd.toFixed(4)} USD + ${Math.ceil(s.sandbox_s)} s`).join(", ")}`);
  }
  check("the vault is metered once per seat: the seats' lines add up to each debit", once, seatLines.join(" | "));
  check("the runtime's meter and the seats' lines agree", Math.abs(Object.values(seatTotal).reduce((s, t) => s + t.usd, 0) - spent) < 1e-4, `${spent.toFixed(4)} USD of model spend; ${Object.entries(seatTotal).map(([k, t]) => `seat ${k}: ${t.usd.toFixed(4)} USD, ${Math.ceil(t.sandbox_s)} sandbox s, ${t.attempts} attempts`).join("; ")}`);

  if (DESKTOPS) {
    const api = await e2b();
    const boxes = await api.list({ units_desktop: "agent", owner: OWNER });
    const want = [1, 2, 3].map((k) => slotKey(keys.agent.id, k));
    check("one desktop per seat at E2B, under the one agent", want.every((k) => boxes.some((b) => b.metadata.agent === k)) && boxes.length === 3, boxes.map((b) => `${String(b.metadata.agent).replace(keys.agent.id, "agent")} ${b.state}`).join(", "));
    check("seat 1 keeps the agent's own stream id, seats 2 and 3 add their number; only they are charged", !!deskSeen && deskSeen.every((d) => d.stream === streamIdOf(slotKey(keys.agent.id, d.seat)) && d.charged === d.seat > 1) && deskSeen[0].stream === streamIdOf(keys.agent.id), deskSeen ? deskSeen.map((d) => `seat ${d.seat}: ${String(d.stream).slice(0, 10)} ${d.charged ? "charged" : "free"}`).join(", ") : "the three desktops were never all running");
    const rate = Number(sc.settings.seat_desktop_usd_per_h);
    let chargeOk = usage.records.length > 0;
    let desk = { s: 0, usd: 0 };
    const perSeat: Record<string, { s: number; usd: number }> = {};
    for (const r of usage.records) {
      for (const [k, s] of Object.entries((r.detail?.seats ?? {}) as Record<string, { desktop_s: number; desktop_usd: number }>)) {
        const t = (perSeat[k] ??= { s: 0, usd: 0 });
        t.s += s.desktop_s;
        t.usd += s.desktop_usd;
        chargeOk = chargeOk && Math.abs(s.desktop_usd - (s.desktop_s / 3600) * rate) < 1e-6 && (k !== "1" || s.desktop_usd === 0);
      }
      desk = { s: desk.s + Number(r.detail?.desktop_s ?? 0), usd: desk.usd + Number(r.detail?.desktop_usd ?? 0) };
    }
    check("the screens of seats 2 and 3 are charged to the vault at the setting's rate for the time they ran; seat 1's is free", chargeOk && (perSeat["2"]?.usd ?? 0) > 0 && (perSeat["3"]?.usd ?? 0) > 0 && (perSeat["1"]?.usd ?? 0) === 0,
      `${rate} USD an hour (Core's swarm setting): ${Object.entries(perSeat).map(([k, t]) => `seat ${k} ${Math.round(t.s)} s = ${t.usd.toFixed(4)} USD`).join(", ")}; ${desk.usd.toFixed(4)} USD in the debits`);
    check("a seat the vault no longer carries has its desktop paused with the reason", [...seenStates].some((x) => /desktop paused \(vault low\)/.test(x)), [...seenStates].filter((x) => /desktop paused/.test(x)).join(", "));
  }
  const paused = lines.filter((x) => /s\d paused: the vault carries \d of 3 seats now/.test(x.l));
  const firstPause = paused[0];
  const startsAfter = firstPause ? lines.filter((x) => x.at > firstPause.at && /s\d attempt starts/.test(x.l)).map((x) => /s(\d) attempt starts/.exec(x.l)![1]) : [];
  const pausedSeats = paused.map((x) => /s(\d) paused: the vault carries (\d)/.exec(x.l)!).map((m) => `seat ${m[1]} at ${m[2]} of 3`);
  check("a low vault shrinks the swarm, highest seat first, while lower seats keep working", paused.length > 0 && /s3 paused/.test(paused[0]!.l) && startsAfter.length > 0 && !startsAfter.includes("3"), `${[...new Set(pausedSeats)].join(", ")}; attempts started after the first pause by seats ${[...new Set(startsAfter)].join(", ") || "none"}`);
  check("then the agent sleeps with the vault below the sleep threshold", after.awake === false && BigInt(after.compute) < BigInt(net.wake_threshold), `compute ${after.compute}, sleep threshold ${net.sleep_threshold}`);
  check("model spend within the run's cap", spent <= CAP_USD + 1e-9, `${spent.toFixed(4)} of ${CAP_USD} USD`);
  const routes = lines.filter((x) => /model route: /.test(x.l));
  check("every model call was routed through OpenRouter", routes.length > 0 && routes.every((x) => /via OpenRouter/.test(x.l)) && !lines.some((x) => /lead plan skipped/.test(x.l) && /direct/.test(x.l)), `${routes.length} attempts routed`);
  check("no secret in the runtime's output", !lines.some((x) => /sk-(ant|or)-[A-Za-z0-9-]{12}/.test(x.l)), `${lines.length} lines`);
  const plans = lines.filter((x) => /lead plan:/.test(x.l)).length;
  log(`lead planning calls: ${plans}${plans ? `: ${lines.find((x) => /lead plan:/.test(x.l))!.l.slice(0, 220)}` : " (none: the first round has no units reported yet, or the call was skipped)"}`);
  log(`seat states seen in Core's view: ${[...seenStates].sort().join(", ")}`);
  note = `keis/base58 two units, ${mine.length} candidate(s): ${mine.map((c) => c.status).join(", ")}`;
  writeFileSync(join(ROOT, "scripts/swarms/PROOF-LAST.json"), JSON.stringify({
    at: new Date().toISOString(), model_usd: spent, models: MODELS, lead: LEAD, vault_usd: VAULT_USD,
    units: units.map((u) => ({ recipe: u.name, targets: u.targets })),
    placements: placed(),
    candidates: mine.map((c) => ({ commit_id: c.commit_id, unit: units.find((u) => u.lineage === c.lineage_id)?.name, kind: c.kind, target: c.target, status: c.status, reason: c.reason, committed_at: c.committed_at, finalized_at: c.finalized_at })),
    final: seatsOfFinal, seats: seatTotal, usage: usage.records.map((r: any) => ({ amount: r.amount, detail: r.detail })), lead_plans: plans, results,
  }, null, 2) + "\n");

  if (SERVE) {
    log(`--serve: Core stays up at ${CORE} with the swarm ${keys.agent.id}; stop this process to end it`);
    writeFileSync(join(tmp, "served.json"), JSON.stringify({ core: CORE, agent: keys.agent.id, tmp }));
    console.log(`SERVING ${JSON.stringify({ core: CORE, agent: keys.agent.id, tmp })}`);
    await new Promise<void>((res) => {
      process.on("SIGTERM", () => res());
      process.on("SIGINT", () => res());
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    check("run completed", false, String(e?.message ?? e));
  })
  .finally(async () => {
    await stopAll();
    if (DESKTOPS) {
      // whatever happened: nothing of this run stays at E2B (only sandboxes with this run's owner label)
      try {
        const api = await e2b();
        for (const b of await api.list({ units_desktop: "agent", owner: OWNER })) await api.kill(b.sandboxId).catch(() => false);
        const left = await api.list({ units_desktop: "agent", owner: OWNER });
        check("cleanup: none of this run's desktops is left at E2B", left.length === 0, `owner ${OWNER}`);
      } catch (e) {
        check("cleanup: none of this run's desktops is left at E2B", false, String((e as Error).message ?? e).slice(0, 200));
      }
    }
    const sf = join(stateDir, "state.json");
    if (existsSync(sf)) spent = JSON.parse(readFileSync(sf, "utf8")).spent_usd_total;
    if (!existsSync(RUNS)) writeFileSync(RUNS, "# Swarms proof runs\n\nModel spend of each real run, as metered by the runtime from the providers' usage fields (every call through OpenRouter).\n\n| When (UTC) | Model USD | Checks | Note |\n|---|---|---|---|\n");
    const failed = results.filter((r) => !r.ok);
    appendFileSync(RUNS, `| ${new Date().toISOString().replace("T", " ").slice(0, 19)} | ${spent.toFixed(4)} | ${results.length - failed.length}/${results.length} | ${note.replace(/\|/g, "/")}${failed.length ? `; failed: ${failed.map((f) => f.check).join("; ").replace(/\|/g, "/")}` : ""} |\n`);
    if (!argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
    log(`${results.length - failed.length}/${results.length} checks passed; this run's model spend ${spent.toFixed(4)} USD`);
    process.exit(failed.length ? 1 : 0);
  });
