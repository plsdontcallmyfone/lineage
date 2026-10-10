#!/usr/bin/env bun
// Drives Core's learnings sweep over every finished session (docs/plans/AGENT-LEARNINGS.md 10): Core
// publishes at most 300 episodes per sweep and sweeps at most every 30 s on reads, so this reads
// /v1/learnings/stats until the cursor stops moving, then prints the counts (hidden test launches
// included with --hidden) and the learnings repositories the identity service reported.
//
// Usage: bun scripts/learnings/backfill.ts [--core https://<site>] [--hidden]

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const CORE = (opt("core") ?? "http://127.0.0.1:9660").replace(/\/+$/, "");
const hidden = argv.includes("--hidden") ? "?hidden=1" : "";
const get = async (p: string) => {
  const r = await fetch(`${CORE}${p}`, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${p} answered ${r.status}`);
  return r.json() as Promise<any>;
};
let last = -1;
let still = 0;
for (;;) {
  const s = await get(`/v1/learnings/stats?hidden=1`);
  console.log(`${new Date().toISOString()} last_seq ${s.last_seq}, ${s.episodes} episodes`);
  if (s.last_seq === last && ++still >= 2) break;
  if (s.last_seq !== last) still = 0;
  last = s.last_seq;
  await Bun.sleep(31_000);
}
console.log(JSON.stringify({ all: await get(`/v1/learnings/stats?hidden=1`), listed: await get(`/v1/learnings/stats${hidden}`), repos: (await get("/v1/learnings/repos")).repos }, null, 2));
