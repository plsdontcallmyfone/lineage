#!/usr/bin/env bun
// Proof run step 4, read only: watches a new agent on a repository with no unit until its self-drafted unit exists and
// its first session starts (up to --minutes, default 60): Core's lifecycle, the runtime's public report (what it waits
// on), the units on the repository and the agent's sessions, once a minute. Prints only changes.
import { appendFileSync } from "node:fs";
import { j } from "./lib.ts";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const AGENT = opt("agent")!, MINT = opt("mint")!, REPO = opt("repo")!.toLowerCase(), MIN = Number(opt("minutes", "60")), LOG = opt("log")!, T0 = Number(opt("since-ms", String(Date.now())));
let last = "";
for (;;) {
  const [a, sp, units, ss, tok] = await Promise.all([j(`/v1/agents/${AGENT}`), j(`/v1/agents/${AGENT}/spend`), j("/v1/units"), j(`/v1/sessions?agent=${AGENT}&limit=5`), j(`/market/tokens/${MINT}`)]);
  const mine = ((units.body ?? []) as any[]).filter((u) => String(u.repo).toLowerCase().includes(REPO));
  const sessions = (Array.isArray(ss.body) ? ss.body : (ss.body?.sessions ?? [])) as any[];
  const line = { minute: Math.round((Date.now() - T0) / 6000) / 10, lifecycle: a.body?.lifecycle ?? null, awake: a.body?.awake ?? null, compute_covered: a.body?.compute_covered ?? null, waiting: sp.body?.spend?.waiting ?? null, desktop: sp.body?.spend?.desktop?.state ?? null, desktop_why: sp.body?.spend?.desktop?.why ?? null,
    units: mine.map((u) => ({ unit: u.lineage_id, recipe: u.recipe_name, status: u.status, height: u.height, created_at: u.created_at })), sessions: sessions.map((s) => ({ id: String(s.session_id).slice(0, 12), state: s.state, started_at: s.started_at, recipe: s.recipe_name })),
    building: tok.body?.building ? { live: tok.body.building.live ?? null, session_id: tok.body.building.session_id ?? null } : null };
  const key = JSON.stringify({ ...line, minute: 0 });
  if (key !== last) {
    last = key;
    const out = JSON.stringify({ at: new Date().toISOString(), ...line });
    appendFileSync(LOG, out + "\n");
    console.log(out);
  }
  if (sessions.length && mine.length) break;
  if (Date.now() - T0 >= MIN * 60_000) { appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), end: "time is up", ...line }) + "\n"); break; }
  await new Promise((r) => setTimeout(r, 60_000));
}
