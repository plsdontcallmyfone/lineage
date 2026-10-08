#!/usr/bin/env bun
// W1 against a live Core (plan FINISH.md W1): one mirror cycle with the runtime-only credential store,
// then, for every branch it published, delete the branch and run again: the rebuilt branch must point
// at the same commit and GitHub must report the agent's commits Verified. Generations whose authors
// have no GitHub account are recorded as app-identity fallbacks. Writes go only to forks owned by the
// pool accounts in the credential store (owner approval 2026-10-08: test repositories only).
//
//   bun scripts/mirror/w1-live.ts [--core https://157-245-71-188.sslip.io] [--credentials <dir>]
//
// Results (no secrets) go to scripts/mirror/W1-LIVE-LAST.json.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STORE, FileCredentialStore } from "../../packages/souls/src/github/credentials.ts";
import { CoreReader } from "../../packages/mirror/src/coreapi.ts";
import { client, deleteBranch } from "../../packages/mirror/src/github.ts";
import { mirrorOnce, storeIdentities, type MirrorReport } from "../../packages/mirror/src/mirror.ts";

const arg = (n: string, d?: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const CORE = arg("core", "https://157-245-71-188.sslip.io")!;
const LAST = join(import.meta.dir, "W1-LIVE-LAST.json");
const log = (m: string) => console.log(`[w1] ${m}`);
const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (c: string, ok: boolean, detail = "") => {
  checks.push({ check: c, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${c}${detail ? `: ${detail}` : ""}`);
};
const strip = (r: MirrorReport) => ({ lineages: r.lineages, generations: r.generations });

const store = new FileCredentialStore(arg("credentials", DEFAULT_STORE));
const ids = storeIdentities(store);
const core = new CoreReader(CORE);
const agents = (await core.get<any[]>("/v1/agents"))!;
const withAccount = agents.filter((a) => a.kind === "launched" && ids.forAgent(a.agent_id)).map((a) => a.agent_id);
log(`${agents.filter((a) => a.kind === "launched").length} launched agents on ${CORE}; with a GitHub account in the credential store: ${withAccount.join(", ") || "none"}`);

const first = await mirrorOnce({ core, identities: ids, log });
const gens = first.generations;
const byAccount = gens.filter((g) => g.identity === "account");
check("every accepted generation of a GitHub lineage was built into its lineage's chain", gens.every((g) => !!g.sha && !g.detail?.startsWith("not built")), `${gens.length} generations in ${first.lineages.filter((l) => l.status !== "skipped").length} lineages`);
check("generations of agents without an account are recorded as app fallbacks", gens.filter((g) => g.identity === "app").every((g) => g.status === "fallback"), gens.filter((g) => g.identity === "app").map((g) => `${g.recipe} gen ${g.height} by ${g.author?.slice(0, 8)}`).join(", ") || "none");
for (const a of withAccount) {
  const mine = byAccount.filter((g) => g.author === a);
  log(`agent ${a}: ${mine.length} accepted generations on ${CORE}`);
}
if (byAccount.length) {
  check("every generation of an agent with an account is on its fork", byAccount.every((g) => g.status === "published" && !!g.fork), byAccount.map((g) => `${g.fork}@${g.sha?.slice(0, 12)}`).join(", "));
  check("GitHub reports each of those commits Verified", byAccount.every((g) => g.verified === true), byAccount.map((g) => `${g.verification_reason} ${g.html_url}`).join(", "));
  const before = new Map(byAccount.map((g) => [g.gen_id, g.sha]));
  for (const l of first.lineages) for (const p of l.pushes) if (p.fork) {
    const id = ids.forAgent(p.agent!)!;
    await deleteBranch(client(id.token!, {}), p.fork, p.branch);
    log(`deleted ${p.fork}:${p.branch}`);
  }
  const second = await mirrorOnce({ core, identities: ids, log });
  const after = second.generations.filter((g) => before.has(g.gen_id));
  check("deleted branches are rebuilt identically", after.every((g) => g.sha === before.get(g.gen_id) && g.verified === true) && second.lineages.every((l) => l.pushes.every((p) => p.action === "pushed")), after.map((g) => `${g.sha?.slice(0, 12)} verified=${g.verified}`).join(", "));
  writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), core: CORE, accounts: withAccount, checks, first: strip(first), rebuilt: strip(second) }, null, 2) + "\n");
} else {
  check("no accepted generation on this Core is authored by an agent with a GitHub account (nothing to push)", true, `agents with an account: ${withAccount.join(", ") || "none"}`);
  writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), core: CORE, accounts: withAccount, checks, first: strip(first) }, null, 2) + "\n");
}
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} passed; ${LAST}`);
