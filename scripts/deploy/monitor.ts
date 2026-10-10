#!/usr/bin/env bun
// Lineage site monitor (plan M4). units-monitor.timer runs it every 5 minutes as the unprivileged
// user lineage-monitor; `remote.sh monitor` starts it once and prints every check.
//
//   bun scripts/deploy/monitor.ts [--state /var/lib/lineage-monitor/state.json]
//
// Checks: every enabled lineage unit and Caddy active; Core, gate and public HTTPS health; epochs close
// on time and each closed epoch is posted on chain; the site's verifiers heartbeat; the hosted
// runtime's model spend and the soul drafter's spend against their caps; the Core authority's, owner's
// and faucet's balances; free disk; the age of the newest Core snapshot.
//
// Alerts go out when a check turns warn or fail, when it recovers, and every 6 hours while it stays
// failing: to ALERT_WEBHOOK_URL (POST {"text": ...}, e.g. Slack or Discord style) and/or Telegram
// (ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID), both from /etc/lineage/alert.env, which only the
// owner writes. Without either, alerts go to the journal only (`journalctl -u units-monitor -p warning`).
// Nothing secret is read or printed: health endpoints, unit states, public keys and file ages.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  level: Level;
  msg: string;
}

export interface Inputs {
  now: number;
  /** unit name -> { enabled, active } for units-* (and pre-rebrand lineage-*) units and caddy */
  units: Record<string, { enabled: boolean; active: string }>;
  coreHealth: { ok: boolean; err?: string };
  gateHealth: { ok: boolean; err?: string };
  publicHealth: { ok: boolean; err?: string } | null;
  /** /v1/epochs (newest first) and /v1/chain */
  epochs: { n: number; status: string; end_ms: number; closed_at?: number | null }[] | null;
  chain: { mode?: string; core_signing?: boolean; last_epoch?: string | null } | null;
  expectSigning: boolean;
  /** /v1/heartbeats */
  heartbeats: { agent_id: string; last_seen: number }[] | null;
  verifiers: { name: string; id: string }[];
  /** runtime spend window and cap (extracted by the unit's root pre-step) */
  spend: {
    window?: { start: number; window_s: number; usd: number } | null;
    cap_usd?: number;
    /** "subsidized" (default since 2026-10-10: the window counts only usage the vaults could not pay) or "all" */
    scope?: string | null;
    /** OpenRouter's balance as the runtime last read it (plan MODELS-AND-SELF-FUNDING) */
    provider?: { openrouter?: { usd: number | null; source: string | null; read_at: number | null; error: string | null; floor_usd: number; configured: boolean } | null } | null;
  } | null;
  runtimeEnabled: boolean;
  souls: { enabled?: boolean; daily_usd?: number; spent_today_usd?: number } | null;
  /** name -> lamports (null when the read failed) */
  balances: { name: string; lamports: number | null }[];
  faucet: { enabled?: boolean; sol_lamports?: string; line_base_units?: string; amount?: string } | null;
  disk: { path: string; freeBytes: number; totalBytes: number }[];
  /** mtime of the newest snapshot, or null when there is none */
  newestBackupMs: number | null;
  backupsExpected: boolean;
  /** secrets+state snapshots (backup.sh secrets): newest mtime per part, or null when no age recipient
   * is configured on the server (then nothing of the runtime keys, site keys or identity data is kept) */
  secretsBackups?: { part: string; newestMs: number | null }[] | null;
}

export const LIMITS = {
  heartbeatStaleMs: 10 * 60_000,
  epochOverdueMs: 60 * 60_000,
  epochPostGraceMs: 2 * 3600_000,
  spendWarn: 0.8,
  diskWarnFrac: 0.2,
  diskFailFrac: 0.1,
  diskFailBytes: 5 * 2 ** 30,
  coreAuthorityWarn: 0.05e9,
  coreAuthorityFail: 0.01e9,
  ownerWarn: 0.05e9,
  faucetSolWarn: 0.02e9,
  faucetDripsWarn: 10,
  backupStaleMs: 2 * 3600_000,
  repeatMs: 6 * 3600_000,
} as const;

const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
const sol = (l: number) => `${(l / 1e9).toFixed(4)} SOL`;
const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;

/** Every check from one set of readings. Pure: the tests drive it with fixed inputs. */
export function evaluate(i: Inputs): Check[] {
  const out: Check[] = [];
  const add = (id: string, level: Level, msg: string) => out.push({ id, level, msg });

  // units
  const down = Object.entries(i.units).filter(([, u]) => u.enabled && u.active !== "active");
  add("units", down.length ? "fail" : "ok", down.length ? `not active: ${down.map(([n, u]) => `${n} (${u.active})`).join(", ")}` : `${Object.values(i.units).filter((u) => u.enabled).length} enabled units active`);

  // health
  add("core", i.coreHealth.ok ? "ok" : "fail", i.coreHealth.ok ? "Core /v1/health ok" : `Core /v1/health: ${i.coreHealth.err ?? "failed"}`);
  add("gate", i.gateHealth.ok ? "ok" : "fail", i.gateHealth.ok ? "gate /gate/health ok" : `gate: ${i.gateHealth.err ?? "failed"}`);
  if (i.publicHealth) add("public", i.publicHealth.ok ? "ok" : "fail", i.publicHealth.ok ? "public HTTPS /v1/health ok" : `public HTTPS: ${i.publicHealth.err ?? "failed"}`);

  // epochs
  if (!i.epochs || !i.chain) add("epochs", "fail", "could not read /v1/epochs or /v1/chain");
  else {
    const open = i.epochs.find((e) => e.status === "open");
    const closed = i.epochs.filter((e) => e.status === "closed").sort((a, b) => b.n - a.n)[0];
    const problems: string[] = [];
    let level: Level = "ok";
    if (open && i.now - open.end_ms > LIMITS.epochOverdueMs) {
      problems.push(`epoch ${open.n} should have closed ${mins(i.now - open.end_ms)} ago`);
      level = "fail";
    }
    if (i.chain.mode && i.chain.mode !== "sim") {
      if (i.expectSigning && !i.chain.core_signing) {
        problems.push("Core holds no authority key (epochs are not posted)");
        level = "fail";
      }
      const posted = i.chain.last_epoch == null ? -1 : Number(i.chain.last_epoch);
      if (closed && posted < closed.n) {
        const since = i.now - (closed.closed_at ?? closed.end_ms);
        if (since > LIMITS.epochPostGraceMs) {
          problems.push(`epoch ${closed.n} closed ${mins(since)} ago, chain has ${posted < 0 ? "none" : `up to ${posted}`}`);
          level = "fail";
        }
      }
    }
    add("epochs", level, problems.length ? problems.join("; ") : `open epoch ${open?.n ?? "?"} ends in ${open ? mins(open.end_ms - i.now) : "?"}; last closed ${closed?.n ?? "none"}${i.chain.mode !== "sim" ? `, on chain ${i.chain.last_epoch ?? "none"}` : ""}`);
  }

  // verifiers
  if (i.verifiers.length) {
    if (!i.heartbeats) add("verifiers", "fail", "could not read /v1/heartbeats");
    else {
      const by = new Map(i.heartbeats.map((h) => [h.agent_id, h.last_seen]));
      const stale = i.verifiers.filter((v) => !by.has(v.id) || i.now - by.get(v.id)! > LIMITS.heartbeatStaleMs);
      add("verifiers", stale.length ? "fail" : "ok", stale.length ? `no heartbeat for ${mins(LIMITS.heartbeatStaleMs)}: ${stale.map((v) => `${v.name}${by.has(v.id) ? ` (last ${mins(i.now - by.get(v.id)!)} ago)` : " (never)"}`).join(", ")}` : `${i.verifiers.length} verifiers heartbeating`);
    }
  }

  // spend
  if (i.runtimeEnabled) {
    const w = i.spend?.window;
    const cap = i.spend?.cap_usd;
    if (!i.spend || cap == null) add("spend", "warn", "runtime spend not readable");
    else {
      const current = w && i.now < w.start + w.window_s * 1000 ? w.usd : 0;
      const f = cap > 0 ? current / cap : 0;
      const all = i.spend.scope === "all";
      add("spend", f >= LIMITS.spendWarn ? "warn" : "ok", `runtime ${all ? "model" : "subsidized"} spend ${current.toFixed(4)} of ${cap} USD this window${f >= 1 ? (all ? " (cap reached: hosted agents pause until the window resets)" : " (cap reached: vault-funded agents keep running)") : ""}`);
    }
    // OpenRouter's prepaid balance (routed models): below the floor, routed attempts wait for a top-up
    const o = i.spend?.provider?.openrouter;
    if (o?.configured) {
      if (o.usd === null) add("provider:openrouter", o.error ? "warn" : "ok", o.error ? `OpenRouter balance not readable: ${o.error}` : "OpenRouter balance unknown (key without a credit limit and no management key)");
      else add("provider:openrouter", o.usd < o.floor_usd ? "warn" : "ok", `OpenRouter balance ${o.usd.toFixed(2)} USD (floor ${o.floor_usd})${o.usd < o.floor_usd ? ": routed attempts wait; top up with USDC or card at openrouter.ai/settings/credits" : ""}`);
    }
  }
  if (i.souls?.enabled && i.souls.daily_usd) {
    const f = (i.souls.spent_today_usd ?? 0) / i.souls.daily_usd;
    add("souls", f >= LIMITS.spendWarn ? "warn" : "ok", `soul drafts ${(i.souls.spent_today_usd ?? 0).toFixed(4)} of ${i.souls.daily_usd} USD today`);
  }

  // balances
  for (const b of i.balances) {
    if (b.lamports == null) {
      add(`balance:${b.name}`, "warn", `${b.name} balance not readable`);
      continue;
    }
    const [warn, fail] = b.name === "core-authority" ? [LIMITS.coreAuthorityWarn, LIMITS.coreAuthorityFail] : [LIMITS.ownerWarn, 0];
    const level: Level = b.lamports < fail ? "fail" : b.lamports < warn ? "warn" : "ok";
    add(`balance:${b.name}`, level, `${b.name} ${sol(b.lamports)}`);
  }
  if (i.faucet?.enabled) {
    const solL = Number(i.faucet.sol_lamports ?? 0);
    const drips = i.faucet.amount && BigInt(i.faucet.amount) > 0n ? Number(BigInt(i.faucet.line_base_units ?? "0") / BigInt(i.faucet.amount)) : 0;
    const level: Level = solL < LIMITS.faucetSolWarn || drips < LIMITS.faucetDripsWarn ? "warn" : "ok";
    add("faucet", level, `faucet ${sol(solL)}, ${drips} drips of tLINE left`);
  }

  // disk
  for (const d of i.disk) {
    const frac = d.totalBytes ? d.freeBytes / d.totalBytes : 0;
    const level: Level = frac < LIMITS.diskFailFrac || d.freeBytes < LIMITS.diskFailBytes ? "fail" : frac < LIMITS.diskWarnFrac ? "warn" : "ok";
    add(`disk:${d.path}`, level, `${d.path} ${gib(d.freeBytes)} free of ${gib(d.totalBytes)} (${Math.round(frac * 100)}%)`);
  }

  // backups
  if (i.backupsExpected) {
    if (i.newestBackupMs == null) add("backup", "fail", "no Core snapshot in /var/lib/lineage/core-backups");
    else {
      const age = i.now - i.newestBackupMs;
      add("backup", age > LIMITS.backupStaleMs ? "fail" : "ok", `newest Core snapshot ${mins(age)} old`);
    }
    if (i.secretsBackups === null) add("backup:secrets", "warn", `no age recipient in ${SECRETS_RECIPIENT}: runtime keys, site keys and identity data are not backed up`);
    for (const b of i.secretsBackups ?? []) {
      if (b.newestMs == null) add(`backup:${b.part}`, "fail", `no ${b.part} snapshot in ${SECRETS_DIRS[b.part] ?? "its directory"}`);
      else {
        const age = i.now - b.newestMs;
        add(`backup:${b.part}`, age > LIMITS.backupStaleMs ? "fail" : "ok", `newest ${b.part} snapshot (encrypted) ${mins(age)} old`);
      }
    }
  }
  return out;
}

export interface AlertState {
  [id: string]: { level: Level; since: number; sent: number };
}

/** Which checks to announce now, and the next state. Transitions always; a fail repeats every 6 hours. */
export function decide(prev: AlertState, checks: Check[], now: number): { send: (Check & { recovered?: boolean })[]; next: AlertState } {
  const next: AlertState = {};
  const send: (Check & { recovered?: boolean })[] = [];
  for (const c of checks) {
    const p = prev[c.id];
    if (!p) {
      next[c.id] = { level: c.level, since: now, sent: c.level === "ok" ? 0 : now };
      if (c.level !== "ok") send.push(c);
      continue;
    }
    if (p.level !== c.level) {
      next[c.id] = { level: c.level, since: now, sent: now };
      send.push(c.level === "ok" ? { ...c, recovered: true } : c);
    } else if (c.level === "fail" && now - p.sent >= LIMITS.repeatMs) {
      next[c.id] = { ...p, sent: now };
      send.push(c);
    } else next[c.id] = p;
  }
  // a check that disappeared (unit removed, runtime turned off) is dropped silently
  return { send, next };
}

// ------------------------------------------------------------------------------------------------ IO

async function getJson<T>(url: string, ms = 8000): Promise<{ ok: boolean; body?: T; err?: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { ok: false, err: `HTTP ${r.status}` };
    return { ok: true, body: (await r.json()) as T };
  } catch (e) {
    return { ok: false, err: (e as Error).message.slice(0, 120) };
  }
}

function sh(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

function readUnits(): Inputs["units"] {
  const units: Inputs["units"] = {};
  const lines = sh(["systemctl", "list-units", "--all", "--plain", "--no-legend", "--type=service,timer", "units-*", "lineage-*", "caddy.service"]).split("\n").filter(Boolean);
  for (const l of lines) {
    const name = l.split(/\s+/)[0]!;
    if (name.endsWith(".service") && /^(units|lineage)-(identity-cycle|backup|backup-state|backup-identity|monitor)\.service$/.test(name)) continue; // timer-run oneshots
    const enabled = sh(["systemctl", "is-enabled", name]) === "enabled";
    units[name] = { enabled, active: sh(["systemctl", "is-active", name]) || "unknown" };
  }
  return units;
}

async function balance(rpc: string, id: string): Promise<number | null> {
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [id, { commitment: "confirmed" }] }), signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { result?: { value?: number } };
    return typeof j.result?.value === "number" ? j.result.value : null;
  } catch {
    return null;
  }
}

function disk(path: string): { path: string; freeBytes: number; totalBytes: number } | null {
  const l = sh(["df", "-Pk", path]).split("\n")[1];
  if (!l) return null;
  const f = l.split(/\s+/);
  return { path, totalBytes: Number(f[1]) * 1024, freeBytes: Number(f[3]) * 1024 };
}

export const SECRETS_RECIPIENT = "/etc/lineage/backup-recipient.txt";
export const SECRETS_DIRS: Record<string, string> = { state: "/var/lib/lineage/state-backups", identity: "/var/lib/lineage/identity-backups" };

function newestBackup(dir: string, re = /^core-.*\.tar\.zst$/): number | null {
  try {
    const ms = readdirSync(dir).filter((f) => re.test(f)).map((f) => statSync(join(dir, f)).mtimeMs);
    return ms.length ? Math.max(...ms) : null;
  } catch {
    return null;
  }
}

async function notify(text: string): Promise<string[]> {
  const sent: string[] = [];
  const hook = process.env.ALERT_WEBHOOK_URL;
  if (hook) {
    const r = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    sent.push(`webhook ${r?.status ?? "error"}`);
  }
  const tok = process.env.ALERT_TELEGRAM_BOT_TOKEN, chat = process.env.ALERT_TELEGRAM_CHAT_ID;
  if (tok && chat) {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    sent.push(`telegram ${r?.status ?? "error"}`);
  }
  return sent;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
  const statePath = opt("state", "/var/lib/lineage-monitor/state.json");
  const env = process.env;
  const CORE = env.MONITOR_CORE ?? "http://127.0.0.1:9660";
  const WEB = env.MONITOR_WEB ?? "http://127.0.0.1:9661";
  const GATE = env.MONITOR_GATE ?? "http://127.0.0.1:9662";
  const dry = env.MONITOR_DRY_RUN === "1";
  const now = Date.now();

  const [core, gate, pub, epochs, chain, hb, souls, faucet] = await Promise.all([
    getJson<{ ok: boolean }>(`${CORE}/v1/health`),
    getJson<{ ok: boolean }>(`${GATE}/gate/health`),
    env.MONITOR_SITE && !dry ? getJson<{ ok: boolean }>(`${env.MONITOR_SITE}/v1/health`, 15_000) : Promise.resolve(null),
    getJson<Inputs["epochs"]>(`${CORE}/v1/epochs`),
    getJson<Inputs["chain"]>(`${CORE}/v1/chain`),
    getJson<Inputs["heartbeats"]>(`${CORE}/v1/heartbeats`),
    getJson<Inputs["souls"]>(`${WEB}/souls/config`),
    getJson<Inputs["faucet"]>(`${WEB}/chain/faucet`),
  ]);
  const verifiers = (env.MONITOR_VERIFIERS ?? "").split(",").filter(Boolean).map((id, k) => ({ name: ["verifier-ref", "verifier-v1", "verifier-v2"][k] ?? `verifier-${k}`, id }));
  const rpc = env.MONITOR_RPC ?? "https://api.devnet.solana.com";
  const balances = dry
    ? []
    : await Promise.all((env.MONITOR_BALANCES ?? "").split(",").filter((s) => /:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)).map(async (s) => {
        const [name, id] = s.split(":") as [string, string];
        return { name, lamports: await balance(rpc, id) };
      }));
  const spendFile = env.MONITOR_SPEND ?? "/run/lineage-monitor/spend.json";
  let spend: Inputs["spend"] = null;
  try {
    spend = JSON.parse(readFileSync(spendFile, "utf8"));
  } catch {
    spend = null;
  }
  const inputs: Inputs = {
    now,
    units: readUnits(),
    coreHealth: { ok: core.ok && core.body?.ok === true, err: core.err },
    gateHealth: { ok: gate.ok && gate.body?.ok === true, err: gate.err },
    publicHealth: pub ? { ok: pub.ok && pub.body?.ok === true, err: pub.err } : null,
    epochs: epochs.ok ? epochs.body! : null,
    chain: chain.ok ? chain.body! : null,
    expectSigning: env.MONITOR_CORE_SIGNING === "1",
    heartbeats: hb.ok ? hb.body! : null,
    verifiers: dry ? [] : verifiers,
    spend,
    runtimeEnabled: env.MONITOR_RUNTIME === "1",
    souls: souls.ok ? souls.body! : null,
    balances,
    faucet: faucet.ok ? faucet.body! : null,
    disk: ["/", ...(existsSync("/var/lib/docker") ? ["/var/lib/docker"] : [])].map(disk).filter((d): d is NonNullable<typeof d> => !!d).filter((d, k, a) => a.findIndex((x) => x.totalBytes === d.totalBytes && x.freeBytes === d.freeBytes) === k),
    newestBackupMs: newestBackup(env.MONITOR_BACKUPS ?? "/var/lib/lineage/core-backups"),
    backupsExpected: env.MONITOR_BACKUPS_EXPECTED !== "0",
    secretsBackups: existsSync(env.MONITOR_SECRETS_RECIPIENT ?? SECRETS_RECIPIENT)
      ? Object.entries(SECRETS_DIRS).map(([part, dir]) => ({ part, newestMs: newestBackup(dir, new RegExp(`^${part}-.*\\.tar\\.zst\\.age$`)) }))
      : null,
  };
  const checks = evaluate(inputs);

  let prev: { alerts?: AlertState } = {};
  try {
    prev = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    prev = {};
  }
  const { send, next } = decide(prev.alerts ?? {}, checks, now);
  const host = env.MONITOR_SITE?.replace(/^https?:\/\//, "") ?? "lineage site";
  let delivered: string[] = [];
  if (send.length) {
    const text = [`lineage monitor (${host})`, ...send.map((c) => `${c.recovered ? "RECOVERED" : c.level.toUpperCase()} ${c.id}: ${c.msg}`)].join("\n");
    delivered = await notify(text);
  }
  // journal: <3> err, <4> warning, <6> info (systemd reads the prefix as the priority)
  for (const c of checks) console.log(`${c.level === "fail" ? "<3>" : c.level === "warn" ? "<4>" : "<6>"}${c.level.padEnd(4)} ${c.id}: ${c.msg}`);
  if (send.length) console.log(`<5>alerts: ${send.map((c) => `${c.recovered ? "recovered" : c.level} ${c.id}`).join(", ")} -> ${delivered.length ? delivered.join(", ") : "journal only (no /etc/lineage/alert.env sink)"}`);
  const summary = { at: new Date(now).toISOString(), worst: checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok", checks, alerts: next };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(summary, null, 2) + "\n");
}
