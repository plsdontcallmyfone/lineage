#!/usr/bin/env bun
// One TEST swarm (one coin, several agents; docs/plans/SWARMS.md) on the official mainnet site, launched
// through the real Launch wizard by a throwaway launcher key, and the read-only checks that prove it.
//
// SIMULATE-ONLY BY DEFAULT. Nothing is signed and nothing is sent without --send.
//
//   bun scripts/swarms/mainnet-test.ts [--key <launcher keypair.json>] [--seats 2] [--repo https://github.com/karpathy/minbpe]
//        [--name "Tandem"] [--symbol TNDM] [--seat-model <provider/id>] [--max-sol 0.5] [--site <url>] [--out <dir>]
//        [--no-wizard]      preflight only: no headless pass through the launch form
//        [--send]           sign and send the launch (REAL SOL). Refused unless every preflight check passed
//   bun scripts/swarms/mainnet-test.ts --phase checks [--out <dir>]     read only, repeatable: what the launch started
//
// What a run without --send does:
//   1. preflight (read only, public routes and one balance read): the site is the official mainnet
//      deployment; Core's `swarms` flag, the largest swarm, and whether THIS wallet may launch one
//      (GET /v1/swarms/config?wallet=, Core's swarm.launchers list); the repository has an active unit;
//      free screens; the credits a swarm of this size needs, from Core's own minimum and the site's SOL price.
//   2. the launch form, headless (scripts/mainnet/live-launch.ts, where the wallet refuses every
//      transaction): with swarms open to this wallet, the whole swarm launch up to the signing prompt,
//      with the page's exact total; while they are not, a one-agent pass, so the cost of everything but
//      the second agent's credits is the page's own figure of today.
//   3. the SOL the launcher needs, against what it holds.
//
// The launcher key never leaves this process and is never printed (the form sees signatures only).
// Records (public data only): <out>/SWARM-TEST.json, and the launch driver's LIVE-LAUNCH.json and
// screenshots beside it. Headless Chromium only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export interface Preflight {
  seats: number;
  site_official: boolean;
  flag: boolean;
  /** GET /v1/swarms/config?wallet=<launcher>, or null while the flag is off */
  cfg: { max_members: number; max_now: number; open: boolean; restricted: boolean; seats_free: number | null; min_usd_per_seat: number | null; seat_desktop_usd_per_h: number | null; seat_desktop_free_seats: number } | null;
  units: string[];
  balance_sol: number;
}

/** Why a swarm of `p.seats` cannot be launched from this wallet now, each reason in words; empty when it can. */
export function blockers(p: Preflight): string[] {
  const out: string[] = [];
  if (!p.site_official) out.push("the site is not the official mainnet deployment");
  if (!p.flag || !p.cfg) out.push("swarms are switched off on the site (Core features.swarms)");
  else {
    if (!p.cfg.open) out.push("swarms are not open to this launcher wallet (Core swarm.launchers)");
    if (p.cfg.max_members < p.seats) out.push(`the largest swarm is ${p.cfg.max_members} (swarm.max_members), below ${p.seats}`);
    else if (p.cfg.open && p.cfg.max_now < p.seats) out.push(`only ${p.cfg.seats_free ?? 0} screen(s) are free now, so the form offers at most ${p.cfg.max_now} agent(s)`);
  }
  if (!p.units.length) out.push("the repository has no active unit on the site");
  return out;
}

/**
 * The SOL a swarm launch needs, from a one-agent pass of the form: that pass's "must hold" figure plus
 * the further agents' credits at the same SOL price, with the purchase's slippage bound on them. The
 * larger purchase also moves the quote coin's pool a little more than the bound covers nothing of:
 * the swarm pass of the form (once it is open) is the exact figure.
 */
export function estimateSwarmSol(o: { solo_must_hold_sol: number; credits_usd_per_seat: number; seats: number; sol_usd: number; slippage_bps: number }): { extra_credits_sol: number; need_sol: number } {
  const extra = ((o.seats - 1) * o.credits_usd_per_seat) / o.sol_usd;
  const withBound = extra * (1 + o.slippage_bps / 10_000);
  return { extra_credits_sol: extra, need_sol: o.solo_must_hold_sol + withBound };
}

/** A swarm seat's stream id (packages/desktop agent-desktops.ts streamIdOf): seat 1 keeps the agent's own. */
export const seatStream = (agent: string, seat: number): string => createHash("sha256").update(`units-desktop-stream\n${seat > 1 ? `${agent}\n${seat}` : agent}`).digest("hex");

if (import.meta.main) await main();

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d);
  const PHASE = arg("phase", "launch")!;
  const SEND = argv.includes("--send");
  const NO_WIZARD = argv.includes("--no-wizard");
  const BASE = arg("site", "https://main-157-245-71-188.sslip.io")!.replace(/\/+$/, "");
  const OUT = arg("out", join(ROOT, "work", "swarm-mainnet-test"))!;
  const KEY = arg("key", join(homedir(), ".config/units/mainnet-test/launch-keys/launcher.json"))!;
  const SEATS = Number(arg("seats", "2"));
  const REPO = arg("repo", "https://github.com/karpathy/minbpe")!;
  const MAX_SOL = Number(arg("max-sol", "0.5"));
  const NAME = arg("name", "Tandem")!, SYMBOL = arg("symbol", "TNDM")!;
  const SEAT_MODEL = arg("seat-model") ?? null;
  if (!Number.isInteger(SEATS) || SEATS < 2 || SEATS > 16) throw new Error("--seats is a number of agents from 2 to 16");
  if (PHASE !== "launch" && PHASE !== "checks") throw new Error("--phase is launch (the default) or checks");
  mkdirSync(OUT, { recursive: true });
  const FILE = join(OUT, "SWARM-TEST.json");
  type Row = { phase: string; check: string; state: "pass" | "fail" | "wait"; detail: string; at: string };
  const S: Record<string, any> & { results: Row[] } = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { results: [] };
  const save = () => writeFileSync(FILE, JSON.stringify(S, null, 2) + "\n");
  const T0 = Date.now();
  const log = (m: string) => console.log(`[swarm-test ${PHASE} +${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
  const note = (name: string, state: Row["state"], detail = "") => {
    S.results = S.results.filter((r) => !(r.phase === PHASE && r.check === name));
    S.results.push({ phase: PHASE, check: name, state, detail: detail.slice(0, 900), at: new Date().toISOString() });
    save();
    log(`${state === "pass" ? "PASS" : state === "wait" ? "WAIT" : "FAIL"} ${name}${detail ? `: ${detail.slice(0, 600)}` : ""}`);
    return state === "pass";
  };
  const check = (name: string, ok: boolean, detail = "") => note(name, ok ? "pass" : "fail", detail);
  const j = async (p: string) => {
    const r = await fetch(`${BASE}${p}`, { headers: { accept: "application/json" } }).catch(() => null);
    if (!r) return { status: 0, body: null as any };
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const repoKey = (u: string) => u.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  const driver = (extra: string[], out: string) => Bun.spawnSync(["bun", join(ROOT, "scripts/mainnet/live-launch.ts"), "--official", "--site", BASE, "--out", out, ...extra], { stdout: "inherit", stderr: "inherit", env: process.env }).exitCode;
  const driverState = (out: string): Record<string, any> | null => (existsSync(join(out, "LIVE-LAUNCH.json")) ? JSON.parse(readFileSync(join(out, "LIVE-LAUNCH.json"), "utf8")) : null);

  if (PHASE === "checks") return phaseChecks();

  // ---------------------------------------------------------------- 1. preflight (read only)
  const { loadKeypair, Rpc } = await import("@units/chain");
  const { applyNetworkProfile, rpcUrlFor, stateFor } = await import("../../packages/chain/src/profile-node.ts");
  const profile = applyNetworkProfile();
  const state = stateFor(profile) as Record<string, any> | null;
  if (profile.network !== "mainnet" || !state || state.test === true) throw new Error("the active profile is not the official mainnet deployment; nothing was read or signed");
  const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
  if ((await rpc.call<string>("getGenesisHash")) !== MAINNET_GENESIS) throw new Error("the RPC endpoint is not mainnet");
  if (!existsSync(KEY)) throw new Error(`no launcher key at ${KEY} (a throwaway keypair outside the repository)`);
  const launcher = loadKeypair(KEY).id;
  const bal = Number(await rpc.getBalance(launcher)) / 1e9;
  S.site = BASE;
  S.launcher = launcher;
  S.seats = SEATS;
  S.repo = REPO;
  log(`site ${BASE}; launcher ${launcher} holds ${bal.toFixed(9)} SOL; ${SEND ? "SEND: the wallet will sign once the preflight passes" : "simulate only: nothing is signed or sent"}`);

  const cc = (await j("/chain/config")).body;
  const official = cc?.genesis === MAINNET_GENESIS && cc?.profile?.network === "mainnet" && cc.profile.programs?.registry === state.registry_program && cc.profile.programs?.launch === state.launch_program && cc.profile.quote?.mint === state.line_mint && cc.state?.test !== true;
  check("site: the official mainnet deployment (mainnet genesis, the official program ids, UNITS as the quote)", official, `registry ${cc?.profile?.programs?.registry}, launch ${cc?.profile?.programs?.launch}, quote ${cc?.profile?.quote?.mint}`);
  const net = (await j("/v1/config")).body?.network;
  const flag = net?.features?.swarms === true;
  const sc = await j(`/v1/swarms/config?wallet=${launcher}`);
  const anon = flag ? (await j("/v1/swarms/config")).body : null;
  const cfg: Preflight["cfg"] = sc.status === 200 && sc.body?.enabled === true
    ? { max_members: sc.body.settings.max_members, max_now: sc.body.max_now, open: sc.body.launch?.open !== false, restricted: sc.body.launch?.restricted === true, seats_free: sc.body.capacity?.seats_free ?? null,
        min_usd_per_seat: sc.body.min_usd_per_seat === null ? null : Number(sc.body.min_usd_per_seat), seat_desktop_usd_per_h: sc.body.settings.seat_desktop_usd_per_h, seat_desktop_free_seats: sc.body.settings.seat_desktop_free_seats }
    : null;
  check("Core: swarms are switched on (features.swarms in GET /v1/config, GET /v1/swarms/config answers)", flag && !!cfg, flag ? `largest swarm ${cfg?.max_members}` : `features.swarms ${net?.features?.swarms}; /v1/swarms/config ${sc.status} ${sc.body?.error ?? ""}`);
  if (cfg) {
    check(`Core: the largest swarm is at least ${SEATS}`, cfg.max_members >= SEATS, `swarm.max_members ${cfg.max_members}`);
    check("Core: this launcher wallet may launch a swarm", cfg.open, cfg.restricted ? `a list of launcher wallets is in force; this wallet is ${cfg.open ? "on it" : "not on it"}; a wallet that is not named gets open ${anon?.launch?.open}` : "no list of launcher wallets: every wallet may (the form shows the Agents field to everyone)");
    check(`Core: the hosted runtime reports room for ${SEATS} more screens`, cfg.max_now >= SEATS, `screens free ${cfg.seats_free ?? "not reported"}; the form offers up to ${cfg.max_now}`);
    log(`screens: the first ${cfg.seat_desktop_free_seats} free, each further one ${cfg.seat_desktop_usd_per_h === null ? "at the desktop service's rate" : `${cfg.seat_desktop_usd_per_h} USD an hour`} from the vault while it runs`);
  }
  const lineages = ((await j("/v1/lineages")).body ?? []) as any[];
  const units = (Array.isArray(lineages) ? lineages : []).filter((l) => typeof l.repo === "string" && repoKey(l.repo) === repoKey(REPO) && (l.status ?? "active") === "active").map((l) => `${l.recipe_name ?? l.name ?? "unit"} ${String(l.lineage_id).slice(0, 10)}`);
  check("Core: the repository has an active unit", units.length > 0, units.length ? `${units.length}: ${units.join(", ")}${units.length < SEATS ? `; fewer units than agents, so ${SEATS - units.length} agent(s) share a unit (stacked changes, at most ${net?.max_open_candidates_per_agent} open per unit)` : ""}` : `none for ${REPO}`);
  const pre: Preflight = { seats: SEATS, site_official: !!official, flag, cfg, units, balance_sol: bal };
  const blocked = blockers(pre);
  const per = Number(net?.prepay?.min_usd);
  const solUsd = (await j("/chain/sol-price")).body;
  const fr = (await j("/v1/launch-fronting")).body;
  S.preflight = { ...pre, blockers: blocked, credits_usd_per_seat: per, sol_usd: solUsd?.usd ?? null, at: new Date().toISOString() };
  save();
  if (!(per > 0) || !solUsd?.ok) throw new Error("Core's credits minimum or the site's SOL price could not be read");
  log(`credits: ${per} USD for each agent, ${per * SEATS} USD for ${SEATS} = ${((per * SEATS) / solUsd.usd).toFixed(6)} SOL at the site's ${solUsd.usd.toFixed(2)} USD per SOL (${solUsd.source})`);

  // ---------------------------------------------------------------- 2. the launch form, headless
  const common = ["--key", KEY, "--repo", REPO, "--name", NAME, "--symbol", SYMBOL, "--max-sol", String(MAX_SOL)];
  if (!blocked.length) {
    const out = join(OUT, SEND ? "launch" : "dry");
    log(`${SEND ? "LAUNCH" : "dry pass"} through the launch form with ${SEATS} agents (records in ${out})`);
    const code = driver([...common, "--swarm", String(SEATS), ...(SEAT_MODEL ? ["--seat-model", SEAT_MODEL] : []), ...(SEND ? ["--send"] : [])], out);
    const d = driverState(out);
    const fails = ((d?.results ?? []) as any[]).filter((r) => !r.ok);
    S[SEND ? "launch" : "dry"] = { exit: code, plan: d?.plan ?? null, swarm: d?.swarm ?? null, agent: d?.agent ?? null, mint: d?.mint ?? null, failed: fails.map((r) => r.check) };
    if (SEND && d?.agent) Object.assign(S, { agent: d.agent, mint: d.mint, launched_at: d.launch?.at ?? null });
    save();
    check(`launch form: the ${SEND ? "launch" : "dry pass"} with ${SEATS} agents ended without a failed check`, code === 0 && fails.length === 0, fails.length ? fails.map((r) => `${r.check}: ${r.detail}`).join(" | ") : `total ${d?.plan?.total_sol} SOL (${d?.plan?.total_usd} USD), the wallet must hold ${d?.plan?.must_hold_sol ?? d?.plan?.total_sol} SOL`);
    for (const r of (d?.plan?.rows ?? []) as any[]) log(`  ${r.label}: ${r.usd} ${r.sol}`);
    const need = d?.plan?.must_hold_sol ?? d?.plan?.total_sol ?? null;
    if (need !== null) check("money: the launcher holds what the form asks for (the page's exact figure for this swarm)", bal >= need, `needs ${need} SOL, holds ${bal.toFixed(9)}`);
    if (SEND && S.agent) log(`launched: agent ${S.agent}, mint ${S.mint}. Next: bun scripts/swarms/mainnet-test.ts --phase checks${OUT === join(ROOT, "work", "swarm-mainnet-test") ? "" : ` --out ${OUT}`}`);
  } else {
    for (const b of blocked) log(`not open: ${b}`);
    if (SEND) {
      check("send: every preflight check passed", false, blocked.join("; "));
      log("NOT SENT: nothing was signed");
    } else if (NO_WIZARD) log("--no-wizard: the launch form was not opened");
    else if (official) {
      // the cost of everything but the further agents' credits, from the form itself: a one-agent pass (the wallet refuses)
      const out = join(OUT, "dry-one-agent");
      log(`one-agent dry pass through the launch form for today's cost lines (records in ${out}); the Agents field cannot be exercised until swarms are open to this wallet`);
      const code = driver(common, out);
      const d = driverState(out);
      const fails = ((d?.results ?? []) as any[]).filter((r) => !r.ok);
      const hold = d?.plan?.must_hold_sol ?? d?.plan?.total_sol ?? null;
      check("launch form: the one-agent dry pass reached the signing prompt without a failed check", code === 0 && fails.length === 0 && hold !== null, fails.length ? fails.map((r) => `${r.check}: ${r.detail}`).join(" | ") : `one agent: total ${d?.plan?.total_sol} SOL (${d?.plan?.total_usd} USD), the wallet must hold ${hold} SOL`);
      for (const r of (d?.plan?.rows ?? []) as any[]) log(`  ${r.label}: ${r.usd} ${r.sol}`);
      if (hold !== null) {
        const est = estimateSwarmSol({ solo_must_hold_sol: hold, credits_usd_per_seat: per, seats: SEATS, sol_usd: d?.plan?.sol_usd?.usd ?? solUsd.usd, slippage_bps: Number(fr?.initial_buy_slippage_bps ?? 100) });
        S.estimate = { one_agent: d?.plan ?? null, ...est, basis: "the one-agent pass's must-hold figure plus the further agents' credits at the site's SOL price with the purchase's slippage bound; the larger purchase moves the pool a little more, so the swarm pass of the form is the exact figure" };
        save();
        check(`money: the launcher holds the estimate for ${SEATS} agents`, bal >= est.need_sol, `estimate ${est.need_sol.toFixed(6)} SOL (one agent ${hold} + ${est.extra_credits_sol.toFixed(6)} SOL of credits for ${SEATS - 1} more agent(s), with the slippage bound); holds ${bal.toFixed(9)}; left after ${(bal - est.need_sol).toFixed(6)}`);
      }
    }
  }
  const mine = S.results.filter((r) => r.phase === PHASE);
  log(`${mine.filter((r) => r.state === "pass").length} of ${mine.length} checks passed${blocked.length ? `; a swarm of ${SEATS} cannot be launched from this wallet yet: ${blocked.join("; ")}` : ""}`);
  if (SEND && (blocked.length || mine.some((r) => r.state === "fail"))) process.exit(1);

  // ---------------------------------------------------------------- checks (read only, repeatable)
  async function phaseChecks() {
    const agent = arg("agent", S.agent) as string | undefined, mint = arg("mint", S.mint) as string | undefined;
    if (!agent || !mint) throw new Error("no launched swarm in the state file (run with --send first), and no --agent and --mint given");
    const n = Number(S.seats ?? SEATS);
    const { ChainReader, Rpc: R } = await import("@units/chain");
    const { applyNetworkProfile: apply, rpcUrlFor: url } = await import("../../packages/chain/src/profile-node.ts");
    const reader = new ChainReader(R.http(url(apply()), "confirmed"));
    const hex64 = /^[0-9a-f]{64}$/;
    // one registered agent, one coin, one vault: the seats exist on chain only inside the soul's digest
    const [rec, la] = await Promise.all([reader.agent(agent), reader.agentLaunch(mint)]);
    const soul = await j(`/v1/agents/${agent}/soul`);
    const members = (soul.body?.doc?.swarm?.members ?? []) as any[];
    check("chain: ONE registry record and ONE AgentLaunch for the swarm (seats are not agents on chain)", !!rec && !!la && la.agent === agent, rec ? `kind ${rec.kind}, owner ${rec.owner}, hosted ${rec.hosted}; launcher ${la?.launcher}, repository ${la?.repoUrl}` : "no registry record");
    check(`soul: Core holds the signed soul with ${n} seats and exactly one lead`, soul.status === 200 && members.length === n && members.filter((m) => m.role === "lead").length === 1, members.map((m) => `${m.seat} ${m.name} ${m.role} ${m.model?.id}`).join("; ") || `HTTP ${soul.status}`);
    check("soul: the digest the launch committed on chain (set_profile) is the digest of that soul", !!rec?.profileDigest && rec.profileDigest === soul.body?.digest, `chain ${rec?.profileDigest} seq ${rec?.profileSeq}; Core ${soul.body?.digest} seq ${soul.body?.seq}`);
    const av = (await j(`/v1/agents/${agent}`)).body;
    const signing = rec?.signingKey ?? null;
    note("bound: ONE key rotation moved the agent's signing key to the hosted runtime's key (every seat signs with it)", !!signing && signing !== agent ? "pass" : "wait", `signing key ${signing}${signing === agent ? " (still the launch key: the binding has not landed)" : ""}; lifecycle ${av?.lifecycle}, awake ${av?.awake}`);
    const sw = await j(`/v1/agents/${agent}/swarm`);
    const seats = (sw.body?.seats ?? []) as any[];
    check(`Core: the agent is a swarm of ${n} (GET /v1/agents/:id/swarm)`, sw.status === 200 && sw.body?.size === n && seats.length === n, sw.status === 200 ? `size ${sw.body?.size}, lead ${sw.body?.lead}${sw.body?.seats === null ? "; Core lists it as ONE agent (its launcher is not on swarm.launchers, or Core has not read the launch yet)" : ""}` : `HTTP ${sw.status} ${sw.body?.error ?? ""}`);
    const list = ((await j("/v1/swarms?hidden=1")).body?.swarms ?? []) as any[];
    check("Core: listed once among the swarms, and as one agent in the agent list", list.filter((x) => x.agent === agent).length === 1 && list.find((x) => x.agent === agent)?.size === n, JSON.stringify(list.find((x) => x.agent === agent) ?? null));
    // every seat reported by the runtime, each with its own screen
    const rt = seats.map((s) => s.runtime);
    note("runtime: every seat is in the hosted runtime's report (state, model, screen)", rt.length === n && rt.every(Boolean) ? "pass" : "wait", seats.map((s) => `seat ${s.seat}: ${s.runtime ? `${s.runtime.state}${s.runtime.why ? ` (${s.runtime.why})` : ""}, ${s.runtime.model?.id} via ${s.runtime.via}` : "not reported yet"}`).join("; "));
    const streams = seats.map((s) => s.runtime?.desktop?.stream ?? null);
    const expected = seats.map((s) => seatStream(agent, s.seat));
    note("screens: each seat has its own screen with its own stream id (seat 1 keeps the agent's, seat k adds its number)", streams.length === n && streams.every((x, i) => typeof x === "string" && hex64.test(x) && x === expected[i]) && new Set(streams).size === n ? "pass" : "wait",
      seats.map((s, i) => `seat ${s.seat}: ${s.runtime?.desktop ? `${s.runtime.desktop.state} ${String(streams[i]).slice(0, 12)}${streams[i] === expected[i] ? "" : " (NOT the expected id)"}` : "no screen yet"}`).join("; "));
    const live = await Promise.all(streams.map(async (id) => (typeof id === "string" ? (await fetch(`${BASE}/desktops/${id}/live.m3u8`).catch(() => null))?.status ?? 0 : 0)));
    note("screens: every seat's live stream answers through the site", live.length === n && live.every((x) => x === 200) ? "pass" : "wait", seats.map((s, i) => `seat ${s.seat}: HTTP ${live[i]} (${s.runtime?.desktop?.state ?? "none"}${s.runtime?.desktop?.why ? `, ${s.runtime.desktop.why}` : ""})`).join("; "));
    const charged = seats.map((s) => s.runtime?.desktop?.charged ?? null);
    note("screens: the first seat's screen is free, seats 2 and up are charged to the vault", charged.length === n && charged[0] === false && charged.slice(1).every((x) => x === true) ? "pass" : "wait", seats.map((s, i) => `seat ${s.seat}: charged ${charged[i]}, ${s.runtime?.spend?.desktop_s ?? 0} s = ${s.runtime?.spend?.desktop_usd ?? 0} USD in closed epochs`).join("; "));
    // sessions by seat (public like any session)
    const sessions = ((await j(`/v1/sessions?agent=${agent}&limit=200`)).body ?? []) as any[];
    const bySeat = new Map<number, number>();
    for (const s of Array.isArray(sessions) ? sessions : []) bySeat.set(s.seat ?? 1, (bySeat.get(s.seat ?? 1) ?? 0) + 1);
    note("sessions: every seat has had a session of its own", Array.from({ length: n }, (_, i) => i + 1).every((k) => (bySeat.get(k) ?? 0) > 0) ? "pass" : "wait", Array.from({ length: n }, (_, i) => `seat ${i + 1}: ${bySeat.get(i + 1) ?? 0}`).join(", "));
    const targets = seats.map((s) => (s.runtime?.state === "working" && s.runtime.unit ? `${String(s.runtime.unit).slice(0, 10)} ${s.runtime.target}` : null));
    const busy = targets.filter(Boolean) as string[];
    if (busy.length > 1) check("placement: seats at work at the same moment are on different targets", new Set(busy).size === busy.length, seats.map((s, i) => `seat ${s.seat}: ${targets[i] ?? s.runtime?.state ?? "none"}`).join("; "));
    else log(`placement: ${busy.length} seat(s) at work at this moment (${seats.map((s, i) => `seat ${s.seat}: ${targets[i] ?? s.runtime?.state ?? "none"}`).join("; ")}); run again to see two at once`);
    // final candidates by seat (the seat is published only once a candidate is final)
    note("candidates: every seat has a FINAL candidate attributed to it", seats.length === n && seats.every((s) => (s.totals?.final ?? 0) > 0) ? "pass" : "wait", seats.map((s) => `seat ${s.seat} ${s.name}: ${s.totals?.accepted ?? 0} accepted of ${s.totals?.final ?? 0} final${s.last ? `, last ${s.last.status}${s.last.reason ? ` (${s.last.reason})` : ""}` : ""}`).join("; "));
    const stale = seats.filter((s) => /stale/.test(String(s.last?.reason ?? "")));
    if (seats.some((s) => s.last)) check("candidates: no seat's newest final candidate was lost to stale or stale_conflict", stale.length === 0, stale.map((s) => `seat ${s.seat}: ${s.last.reason}`).join("; ") || "none stale (another agent on the same unit can still move the tip)");
    const record = (sw.body?.record ?? []) as any[];
    note("record: accepted changes name the seat and model that wrote them", record.length > 0 && record.every((r) => Number.isInteger(r.seat) && r.name && r.model) ? "pass" : "wait", record.slice(0, 6).map((r) => `seat ${r.seat} ${r.name} (${r.model}) ratio ${r.ratio}`).join("; ") || "no accepted change yet");
    // the one vault: one debit per usage epoch with the seats inside it
    const usage = (((await j(`/v1/agents/${agent}/usage?limit=50`)).body?.records ?? []) as any[]).filter((r) => r.detail?.seats);
    note("vault: one debit per usage epoch for the whole swarm, the seats' lines inside it", usage.length > 0 ? "pass" : "wait", usage.slice(0, 3).map((r) => `epoch ${r.epoch}: ${r.amount} base units; ${Object.entries(r.detail.seats).map(([k, v]: [string, any]) => `seat ${k} ${v.usd} USD model, ${v.desktop_usd ?? 0} USD screen`).join(", ")}`).join(" | ") || "no usage epoch closed yet");
    const spend = (await j(`/v1/agents/${agent}/spend`)).body?.spend;
    log(`vault now: ${spend?.vault_usd ?? "?"} USD (${spend?.vault ?? "?"} base units), covered by network compute: ${spend?.covered ? "yes (only the first seat works, the vault is not charged)" : "no"}`);
    await pages(agent, mint, n);
    const mine = S.results.filter((r) => r.phase === PHASE);
    log(`${mine.filter((r) => r.state === "pass").length} passed, ${mine.filter((r) => r.state === "wait").length} waiting (run again later), ${mine.filter((r) => r.state === "fail").length} failed, of ${mine.length}`);
    if (mine.some((r) => r.state === "fail")) process.exit(1);
  }

  /** The coin page's swarm section and the Explorer card, headless, at 1280 and 390. */
  async function pages(agent: string, mint: string, n: number) {
    const pw = await import(join(ROOT, "node_modules/.bun/playwright-core@1.63.0/node_modules/playwright-core/index.mjs"));
    const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
    const browser = await pw.chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
    try {
      for (const width of [1280, 390]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        await page.goto(`${BASE}/tokens/${mint}`, { waitUntil: "domcontentloaded" });
        // a button per agent's computer in the centre panel's control ("Computer 1", "Computer 2"); a release before
        // that change has one "Computers" button and a tile for every agent but the large screen
        const b = page.locator('.tk-view [data-view-b="computer"]');
        await b.first().waitFor({ timeout: 60_000 }).catch(() => {});
        const buttons = await b.count();
        const labels = (await b.evaluateAll((els: HTMLElement[]) => els.map((e) => e.getAttribute("aria-label") ?? (e.textContent ?? "").trim()))) as string[];
        const perSeat = buttons === n && labels.every((l, i) => l.startsWith(`Computer ${i + 1}`));
        await b.nth(perSeat ? n - 1 : 0).click().catch(() => {});
        await page.locator("#mk-swarm #sw-seats > li").first().waitFor({ timeout: 30_000 }).catch(() => {});
        const rows = await page.locator("#mk-swarm #sw-seats > li").count();
        const tiles = await page.locator("#mk-swarm .sw-tile").count();
        const marked = ((await page.locator('#mk-swarm #sw-seats > li[aria-current="true"]').getAttribute("data-seat").catch(() => null)) as string | null) ?? "";
        const head = ((await page.locator(".mk-buildpanel h2").innerText().catch(() => "")) as string).trim();
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        await page.screenshot({ path: join(OUT, `token-${width}.png`), fullPage: true }).catch(() => {});
        const older = buttons === 1 && labels[0] === "Computers" && tiles === n - 1;
        check(`coin page at ${width} px: a toggle for each of the ${n} agents' computers, a row for each agent with the shown one marked`, (perSeat ? marked === String(n) && tiles === 0 : older) && rows === n && head === "What the swarm is building" && !wide && errors.length === 0,
          `${perSeat ? `toggles ${labels.join(" | ")}, row ${marked} marked` : older ? `the release before per-agent toggles: one "Computers" button, ${tiles} tiles` : `buttons ${JSON.stringify(labels)}, ${tiles} tiles`}, ${rows} rows, heading "${head}"${wide ? ", the page scrolls sideways" : ""}${errors.length ? `, page errors: ${errors.slice(0, 2).join(" ; ")}` : ""}`);
        if (width === 1280) {
          await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
          const card = page.locator(`.ex-card[data-agent="${agent}"]`);
          await card.first().waitFor({ timeout: 30_000 }).catch(() => {});
          const cards = await card.count();
          const badge = cards ? ((await card.first().locator(".ex-swarm").innerText().catch(() => "")) as string).trim() : "";
          note(`Explorer: one card for the coin, with the badge "${n} agents"`, cards === 1 && badge === `${n} agents` ? "pass" : cards === 0 ? "wait" : "fail", cards ? `${cards} card(s), badge "${badge}"` : "no card (a hidden launch, or the market indexer has not listed the coin yet)");
        }
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  }
}
