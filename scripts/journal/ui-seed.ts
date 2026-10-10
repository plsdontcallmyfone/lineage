#!/usr/bin/env bun
// A local Core with journal entries for the headless UI check (no model spend): one launched agent,
// the two entries the real Claude run wrote (scripts/journal/LOCAL-LAST.json) on sessions that ended
// without a candidate, one entry on a session whose candidate the verifiers accepted, and one on a
// session whose candidate is still open (withheld: it must not render). Stays up until killed.
//
//   bun scripts/journal/ui-seed.ts [--port 9664]   then   bun apps/web/server.ts --port 9665 --core <printed base> --dev
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { journalStatement, signJournal } from "../../packages/core/src/protocol.ts";
import { serve } from "../../packages/core/src/http.ts";
import { diff, expectOk, honest, makeAuthor, result, runReplays, setup, submit, type Agent, type Env } from "../../packages/core/test/helpers.ts";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9664);
const last = JSON.parse(readFileSync(join(import.meta.dir, "LOCAL-LAST.json"), "utf8"));
const e: Env = await setup({ verifiers: 3 });
const a: Agent = await makeAuthor(e);

async function session(): Promise<string> {
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/events`, { events: [{ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 40 }] }));
  return s.session_id;
}
async function entry(sid: string, text: string) {
  const st = journalStatement({ agent: a.id, session_id: sid, lineage_id: e.lineage, created_at: e.clock.now(), text });
  await expectOk(a.c.post(`/v1/agents/${a.id}/journal`, { statement: st, sig: signJournal(a.key, st) }));
  e.clock.advance(60_000);
}

for (const text of [last.session1.entry, last.session2.entry]) {
  const sid = await session();
  await expectOk(a.c.post(`/v1/sessions/${sid}/end`, {}));
  await entry(sid, text);
}
const s3 = await session();
const c3 = await submit(e, a, diff("ui"));
await expectOk(a.c.post(`/v1/sessions/${s3}/end`, { commit_id: c3.commit_id }));
await entry(s3, "Tried a capacity hint on the output buffer. My sandbox said accepted; the verdict comes from the replays.");
await runReplays(e, c3.candidate_id, honest(result({}, 900)));
const s4 = await session();
const c4 = await submit(e, a, diff("ui-open"));
await expectOk(a.c.post(`/v1/sessions/${s4}/end`, { commit_id: c4.commit_id }));
await entry(s4, "WITHHELD_ENTRY: still waiting for replays.");

// a fixed port for the dashboard, in front of the same Core
const server = serve(e.core, { port });
console.log(JSON.stringify({ core: `http://127.0.0.1:${server.port}`, agent: a.id, open_candidate: c4.commit_id }));
await new Promise(() => {});
