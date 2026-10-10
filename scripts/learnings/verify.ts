#!/usr/bin/env bun
// Checks a published episode (docs/plans/AGENT-LEARNINGS.md 7, "How to verify") against Core:
//   1. the file equals Core's copy (GET /v1/learnings/episodes/<episode_id>);
//   2. the episode id is sha256("lineage-episode-v1|" + session_id);
//   3. the candidate's patch hashes to its patch_hash, and Core's candidate view agrees on status;
//   4. the provenance record verifies (purpose provenance) and its digest matches;
//   5. the journal entry verifies (purpose journal) against its signer.
// The verdict itself and the replay draws are checked by scripts/verify.ts --candidate <commit_id> [--chain].
//
// Usage: bun scripts/learnings/verify.ts <episode.json | https URL> [--core https://<site>]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, hashJson, journalStatement, patchHash, verifyJournal, verifyStatement } from "../../packages/protocol/src/index.ts";

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith("--"));
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const CORE = (opt("core") ?? "http://127.0.0.1:9660").replace(/\/+$/, "");
if (!src) {
  console.error("usage: bun scripts/learnings/verify.ts <episode.json | URL> [--core <url>]");
  process.exit(2);
}
const ep: any = /^https?:\/\//.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));
const get = async (p: string) => {
  const r = await fetch(`${CORE}${p}`, { signal: AbortSignal.timeout(30_000) });
  return r.ok ? r.json() : null;
};
const checks: { check: string; ok: boolean; detail?: string }[] = [];
const add = (check: string, ok: boolean, detail?: string) => checks.push({ check, ok, ...(detail ? { detail } : {}) });

const core: any = await get(`/v1/learnings/episodes/${ep.episode_id}`);
add("equals Core's copy", !!core && canonicalJson(core) === canonicalJson(ep), core ? undefined : "Core does not serve this episode");
add("episode id", createHash("sha256").update(`lineage-episode-v1|${ep.session_id}`).digest("hex") === ep.episode_id);
if (ep.candidate) {
  if (ep.candidate.patch && !ep.candidate.truncated) add("patch hash", patchHash(ep.candidate.patch) === ep.candidate.patch_hash);
  const c: any = await get(`/v1/candidates/${ep.candidate.commit_id}`);
  add("candidate status in Core", !!c && c.status === ep.candidate.status, c ? `${c.status}` : "not found");
}
if (ep.provenance) {
  const p: any = await get(ep.verify.provenance);
  const rec = p?.record;
  add("provenance signature", !!rec && verifyStatement(ep.provenance.signer, ep.provenance.sig, "provenance", rec) && hashJson(rec) === ep.provenance.digest);
}
if (ep.journal) {
  const st = journalStatement({ agent: ep.agent.id, session_id: ep.session_id, lineage_id: ep.task.lineage_id, created_at: ep.journal.created_at, text: ep.journal.text });
  add("journal signature", verifyJournal(ep.journal.signer, ep.journal.sig, st));
}
console.log(JSON.stringify({ episode_id: ep.episode_id, checks, ok: checks.every((c) => c.ok) }, null, 2));
if (ep.candidate) console.log(`verdict and draws: bun scripts/verify.ts --core ${CORE} --candidate ${ep.candidate.commit_id} --chain`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
