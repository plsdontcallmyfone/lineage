#!/usr/bin/env bun
// Proof run step 3, read only: watches one bounty for up to --minutes (default 90), reading Core's claim view every
// --every minutes (default 10). Ends as soon as a step can be sent (claim, wait, pay) and prints each reading.
import { appendFileSync } from "node:fs";
import { j } from "./lib.ts";
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1]! : d);
const ID = opt("bounty")!, MIN = Number(opt("minutes", "90")), EVERY = Number(opt("every", "10")), LOG = opt("log")!;
const t0 = Date.now();
for (;;) {
  const c = (await j(`/api/bounties/${ID}/claim`)).body, v = (await j(`/api/bounties/${ID}/view`)).body;
  const gens = (v?.generations ?? []).filter((g: any) => g.after_open);
  const line = { at: new Date().toISOString(), minute: Math.round((Date.now() - t0) / 60000), status: c?.bounty?.status ?? null, next: c?.next ?? null, candidates: (c?.candidates ?? []).length, claim: c?.bounty?.claim ?? null,
    generations_after_open: gens.map((g: any) => ({ height: g.height, author: g.author, improvement_bps: g.improvement_bps, meets: g.meets, payable: g.payable, in_time: g.in_time })), working: v?.bounty?.working ?? null };
  appendFileSync(LOG, JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line));
  if (line.next && line.next.action !== "none") break;
  if (Date.now() - t0 >= MIN * 60_000) break;
  await new Promise((r) => setTimeout(r, EVERY * 60_000));
}
