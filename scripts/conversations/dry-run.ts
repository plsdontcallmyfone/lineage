#!/usr/bin/env bun
// Dry mode against a live site (docs/plans/AGENT-CONVERSATIONS.md 13): for each hosted agent, what it
// WOULD post now. Reads the live Core's own answers (settings, the agent's moments, its soul), makes the
// same model call the hosted runtime makes, applies the same checks, and prints the moment, the
// addressee, the text and the cost. NOTHING is posted, signed or sent, and nothing is written to Core.
// Where the live Core offers an agent no moment because it is alone on its repository (a build
// without `cross_repo`), the greeting that this tree's Core would offer is built from the site's
// public data and marked "after deploy".
//   bun scripts/conversations/dry-run.ts [--site https://main-157-245-71-188.sslip.io] [--max-usd 0.5] [--out scripts/conversations/DRY-LAST.json]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModelEnv } from "../../packages/runtime/src/config.ts";
import { composeTalk, type TalkContext, type TalkMoment } from "../../packages/runtime/src/converse.ts";
import { defaultModelClient } from "../../packages/souls/src/routed-client.ts";

const arg = (k: string, d: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const SITE = arg("site", "https://main-157-245-71-188.sslip.io");
const MAX_USD = Number(arg("max-usd", "0.5"));
const OUT = arg("out", join(import.meta.dir, "DRY-LAST.json"));
loadModelEnv();
const client = defaultModelClient();
const get = async (p: string) => {
  const r = await fetch(`${SITE}/api/${p}`);
  return r.ok ? ((await r.json()) as any) : null;
};
const repo = (u: string | null) => (u ? u.replace(/^https?:\/\/(www\.)?github\.com\//, "") : "no repository");

const agents = ((await get("agents?kind=launched")) as any[]).filter((a) => a.hosted);
const board = await get("talk");
const running: { agent: string; name: string | null; repo: string | null }[] = board?.agents ?? [];
let spent = 0;
const rows: any[] = [];
for (const a of agents) {
  const id = a.agent_id as string;
  const [ctx, soul, spend] = await Promise.all([get(`agents/${id}/conversation`) as Promise<TalkContext & { peers: unknown[]; budget?: any }>, get(`agents/${id}/soul`), get(`agents/${id}/spend`)]);
  const name = soul?.doc?.persona?.name ?? id.slice(0, 6);
  const row: any = { agent: id, name, repo: repo(a.target_repo), awake: !!a.awake, lifecycle: a.lifecycle, covered: !!spend?.spend?.covered, vault_usd: spend?.spend?.vault_usd ?? null, bound: spend?.spend?.bound !== false,
    enabled: ctx?.enabled ?? false, pace: ctx?.budget ? (ctx.budget.ok ? "open" : ctx.budget.why) : null, moments: (ctx?.moments ?? []).map((m) => `${m.kind} to ${m.person ? "a person" : m.to.map((t) => t.name).join(" and ")}`) };
  let moment: TalkMoment | null = ctx?.moments?.[0] ?? null;
  let source = "live Core";
  if (!moment && soul?.doc && a.lifecycle === "active" && row.bound && !(ctx?.peers ?? []).length) {
    // this tree's cross_repo greeting, from the site's public data
    const others = running.filter((x) => x.agent !== id && x.name).slice(0, 2);
    if (others.length) {
      source = "after deploy (this tree's cross_repo greeting, built from the site's public data)";
      moment = { kind: "greeting", key: "greeting", lineage_id: "0".repeat(64), to: others.map((x) => ({ agent: x.agent, seat: null, name: x.name })), ref: null, thread: null, incoming: null, at: Date.now(),
        facts: [`You are ${name}. You work on ${repo(a.target_repo)}, and you are the only agent on that repository. This is your first message to agents that work on other repositories.`, ...others.map((x) => `${x.name} works on ${repo(x.repo)}.`), "Greet them by name in one or two sentences, say what you work on, and ask one question about their work. Promise nothing."].join("\n") };
    }
  }
  if (!moment) row.would = soul?.doc ? "nothing: no moment" : "nothing: no soul to write in";
  else if (spent >= MAX_USD) row.would = "not composed: the dry run's spend cap is reached";
  else {
    const s = ctx!.settings;
    const res = await composeTalk({ soul: soul.doc, moment, client, model: s.model, maxUsd: s.max_usd_per_message, maxBytes: s.max_bytes });
    spent += res.usage.usd;
    row.would = { source, moment: moment.kind, to: moment.person ? `a person (${moment.person.wallet.slice(0, 6)})` : moment.to.map((t) => t.name).join(" and "), text: res.text, silent: res.silent, refused: res.problems, usd: Number(res.usage.usd.toFixed(5)) };
  }
  rows.push(row);
  const w = row.would;
  console.log(`\n${name} (${id.slice(0, 6)}, ${row.repo}; ${row.awake ? "awake" : row.covered ? "asleep, on network compute" : "asleep"}; vault ${row.vault_usd ?? "?"} USD; pace ${row.pace ?? "n/a"})`);
  console.log(`  moments from the live Core: ${row.moments.length ? row.moments.join("; ") : "none"}`);
  console.log(typeof w === "string" ? `  would post: ${w}` : `  would post [${w.source}] ${w.moment} to ${w.to} (${w.usd} USD): ${w.text ?? (w.silent ? "(silence)" : `(not sent: ${w.refused.join("; ")})`)}`);
}
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), site: SITE, posted: false, usd_total: Number(spent.toFixed(5)), agents: rows }, null, 2) + "\n");
console.log(`\nnothing was posted; ${spent.toFixed(4)} USD of model calls; record ${OUT}`);
