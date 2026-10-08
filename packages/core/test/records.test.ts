import { afterEach, describe, expect, test } from "bun:test";
import { canonicalJson, hashJson, leafHash, merkleRoot } from "../src/protocol.ts";
import { verifyCredential } from "../src/records.ts";
import {
  agent,
  candidate,
  CANARY_FAST,
  diff,
  expectOk,
  makeAuthor,
  result,
  runReplays,
  settleCanaries,
  setup,
  submit,
  warmShadows,
  type Agent,
  type Env,
} from "./helpers.ts";

// Identity plan I2: per-epoch reputation records and contribution leaves, rooted in record_root,
// and a credential anyone can check against the roots alone.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const breaks = () => result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1", "t2"], cand_fail: ["t3"] } });

async function recordsOf(e: Env, id: string, n: number) {
  const r = await expectOk(e.anon.get(`/v1/agents/${id}/records?epoch=${n}`));
  return (r.epochs[0]?.leaves ?? []) as any[];
}
const rec = (leaves: any[], role: string) => leaves.find((l) => l.kind === "record" && l.record.role === role)?.record;
async function rootsOf(e: Env) {
  const eps = await expectOk<any[]>(e.anon.get("/v1/epochs"));
  const roots = new Map<number, string | null>();
  for (const x of eps) roots.set(x.n, (await expectOk(e.anon.get(`/v1/epochs/${x.n}`))).record_root);
  return roots;
}
/** Every leaf of epoch n, from the public per-agent records (deduplicated): rebuilds the root. */
async function allLeaves(e: Env, n: number, ids: string[]) {
  const set = new Set<string>();
  for (const id of ids) for (const l of await recordsOf(e, id, n)) set.add(l.leaf);
  return [...set].sort();
}

describe("reputation records (identity plan I2)", () => {
  test("canary caught and canary accepted: verifier records, author record, contribution, no shadow record", async () => {
    const e = (env = await setup({ verifiers: 2, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    const patch = diff("canary_break", "src/hidden.rs");
    const up = await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch, kind: "perf", target: "ir", expected_reason: "tests_fail" }));
    const author = await makeAuthor(e);
    warmShadows(e);
    const real = await submit(e, author, diff("real"));
    settleCanaries(e);
    const all = await expectOk<any[]>(e.admin.c.get(`/v1/candidates?lineage=${e.lineage}`, true));
    const canary = all.find((c) => c.candidate_id !== real.candidate_id)!;
    const [cheat, honest] = e.verifiers as [Agent, Agent];
    const behave = (a: Agent, asg: any) => (a.id === cheat.id ? result() : asg.candidate.patch_hash === up.patch_hash ? breaks() : result());
    await runReplays(e, canary.candidate_id, behave);
    await runReplays(e, real.candidate_id, behave);
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const n = closed.n;
    expect(closed.record_root).toMatch(/^[0-9a-f]{64}$/);

    const h = rec(await recordsOf(e, honest.id, n), "verifier");
    expect(h.canaries).toEqual({ caught: 1, accepted: 0 });
    expect(h.replays.counted).toBe(1);
    expect(h.slashes).toEqual([]);
    const c = rec(await recordsOf(e, cheat.id, n), "verifier");
    expect(c.canaries).toEqual({ caught: 0, accepted: 1 });
    expect(c.strikes).toEqual({ canary: 1 });
    expect(c.slashes).toHaveLength(1);
    expect(c.slashes[0].reason).toBe("canary");
    expect(c.slashed_total).toBe((await agent(e, cheat.id)).slashed_total);
    const aLeaves = await recordsOf(e, author.id, n);
    const a = rec(aLeaves, "author");
    const gen = (await candidate(e, real.candidate_id)).gen_id;
    expect([a.lineage_id, a.candidates.accepted, a.accepted[0].gen_id]).toEqual([e.lineage, 1, gen]);
    expect(a.accepted[0].author_units).toBeGreaterThan(0);
    const contrib = aLeaves.find((l) => l.kind === "contribution").contribution;
    expect(contrib).toMatchObject({ epoch: n, gen_id: gen, lineage_id: e.lineage, members: [{ agent: author.id, role: "author", share_bps: 10_000 }], finder: null });
    // the shadow author has no record (its canary is in the epoch's canary list instead)
    expect(await expectOk(e.anon.get(`/v1/agents/${canary.author}/records`))).toEqual({ agent: canary.author, epochs: [] });
    // the root is the Merkle root of every public leaf, each leaf the hash of its record
    for (const l of aLeaves.filter((x) => x.kind === "record"))
      expect(l.leaf).toBe(leafHash(canonicalJson({ epoch: n, agent: author.id, role: "author", lineage_id: e.lineage, record_digest: hashJson(l.record) })));
    expect(merkleRoot(await allLeaves(e, n, [author.id, honest.id, cheat.id, ...e.verifiers.map((v) => v.id), e.reference!.id]))).toBe(closed.record_root);
  });

  test("a launched shadow's records and credential answer exactly like a real agent's with nothing final (SPEC 10.7)", async () => {
    // regression: both routes answered 404 for shadows only, naming the shadow pool as soon as it launched
    const e = (env = await setup({ verifiers: 2, over: { canary_rate: 1, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, patch: diff("canary_break", "src/hidden.rs"), kind: "perf", target: "ir", expected_reason: "tests_fail" }));
    const real = await makeAuthor(e);
    warmShadows(e);
    const shadows = e.core.db.query<{ agent_id: string }, []>("SELECT agent_id FROM shadows WHERE launched_at IS NOT NULL").all();
    expect(shadows.length).toBeGreaterThan(0);
    const strip = (c: any) => ({ ...c, agent: "", issued_at: 0, controller_since: c.controller_since === null ? null : 0, sig: c.sig === null ? null : "" });
    const realRecords = await e.anon.get(`/v1/agents/${real.id}/records`);
    const realCred = await e.anon.get(`/v1/agents/${real.id}/credential`);
    for (const { agent_id } of shadows) {
      const r = await e.anon.get(`/v1/agents/${agent_id}/records`);
      expect([r.status, r.body]).toEqual([realRecords.status, { ...realRecords.body, agent: agent_id }]);
      const c = await e.anon.get(`/v1/agents/${agent_id}/credential`);
      expect(c.status).toBe(realCred.status);
      expect(strip(c.body)).toEqual(strip(realCred.body));
    }
  });

  test("minority slash and revert land in the epoch they resolve; credentials verify from the roots alone", async () => {
    const e = (env = await setup({ verifiers: 5, over: { audit_rate: 1, max_open_replays: 4 } }));
    const author = await makeAuthor(e);
    const bad = await submit(e, author, diff("bad", "src/a.rs"));
    await runReplays(e, bad.candidate_id, (_a, asg) => (asg.kind === "replay" ? result() : "skip"));
    const g1 = (await candidate(e, bad.candidate_id)).gen_id;
    const originals = (await candidate(e, bad.candidate_id)).replays.filter((r: any) => !r.audit_id).map((r: any) => r.replayer);
    // epoch 0 closes with the generation accepted and its audit still open
    const e0 = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const a0 = rec(await recordsOf(e, author.id, e0.n), "author");
    expect([a0.candidates.accepted, a0.reverted, a0.audits]).toEqual([1, [], {}]);
    // the audit contradicts: revert, original replayers in the minority
    await runReplays(e, bad.candidate_id, (_a, asg) => (asg.kind === "replay" ? result() : breaks()));
    expect((await expectOk(e.anon.get(`/v1/generations/${g1}`))).audit.status).toBe("reverted");
    const e1 = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const a1 = rec(await recordsOf(e, author.id, e1.n), "author");
    expect([a1.reverted, a1.audits]).toEqual([[g1], { reverted: 1 }]);
    for (const id of originals) {
      const v = rec(await recordsOf(e, id, e1.n), "verifier");
      expect(v.strikes).toEqual({ audit_minority: 1 });
      expect(v.slashes.map((s: any) => s.reason)).toEqual(["audit_minority"]);
    }

    const roots = await rootsOf(e);
    for (const id of [author.id, ...originals]) {
      const cred = await expectOk(e.anon.get(`/v1/agents/${id}/credential`));
      expect(cred.agent).toBe(id);
      const okv = verifyCredential(cred, roots);
      expect(okv.errors).toEqual([]);
      expect(okv.checked).toBeGreaterThan(0);
      // altering one record fails
      const tampered = structuredClone(cred);
      const leaf = tampered.epochs.flatMap((x: any) => x.leaves).find((l: any) => l.kind === "record");
      if (leaf.record.role === "author") leaf.record.candidates.accepted += 1;
      else leaf.record.replays.assigned = (leaf.record.replays.assigned ?? 0) + 1;
      expect(verifyCredential(tampered, roots).ok).toBe(false);
      // inflating a total without a record fails too
      const inflated = structuredClone(cred);
      inflated.totals.accepted += 1;
      expect(verifyCredential(inflated, roots).errors).toContain("totals do not equal the sums of the records");
      // another epoch's root fails
      const wrongRoot = new Map([...roots].map(([k]) => [k, "ab".repeat(32)]));
      expect(verifyCredential(cred, wrongRoot).ok).toBe(false);
    }
    const authorCred = await expectOk(e.anon.get(`/v1/agents/${author.id}/credential`));
    expect([authorCred.totals.accepted, authorCred.totals.reverted, authorCred.totals.contributions]).toEqual([1, 1, 1]);
    // Core in sim mode has no issuer key: the credential is unsigned and still verifies
    expect([authorCred.issuer, authorCred.sig]).toEqual([null, null]);
  });

  test("dispute minority on a candidate", async () => {
    const e = (env = await setup({ verifiers: 4 }));
    const author = await makeAuthor(e);
    const c = await submit(e, author, diff("d"));
    let lazy: string | null = null;
    const behave = (a: Agent) => {
      lazy ??= a.id;
      return a.id === lazy ? result() : breaks();
    };
    await runReplays(e, c.candidate_id, behave);
    expect((await candidate(e, c.candidate_id)).status).toBe("rejected");
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close"));
    const v = rec(await recordsOf(e, lazy!, closed.n), "verifier");
    expect(v.replays).toMatchObject({ assigned: 1, minority: 1 });
    expect(v.strikes).toEqual({ minority: 1 });
    const a = rec(await recordsOf(e, author.id, closed.n), "author");
    expect([a.candidates.rejected, a.rejections]).toEqual([1, { tests_fail: 1 }]);
    expect(a.accepted).toEqual([]);
  });
});
