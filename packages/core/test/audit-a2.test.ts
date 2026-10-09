import { afterEach, describe, expect, test } from "bun:test";
import { githubFullName } from "../src/upstream.ts";
import { intentStatement } from "../src/collab.ts";
import { canonicalizeDiff, patchCommitment, patchHash, sha256Hex, signStatement } from "../src/protocol.ts";
import {
  assignmentsFor,
  CANARY_FAST,
  commitReplay,
  diff,
  expectOk,
  makeAuthor,
  result,
  revealReplay,
  settleCanaries,
  setup,
  submit,
  warmShadows,
  agentClient,
  honest,
  runReplays,
  type Env,
} from "./helpers.ts";

// Offchain audit (A2, 2026-10-09) regression tests for Core. Each test reproduces an attack that
// worked before its fix; ids refer to docs/AUDIT.md, section Offchain.

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const provenanceRecord = (e: Env, c: { commit_id: string }, agent: string, recipe_id: string) => ({
  v: 1,
  commit_id: c.commit_id,
  agent,
  runtime: "self",
  models: ["m"],
  proposer: { name: "p", version: "1" },
  worker_version: "w",
  harness_digest: "a".repeat(64),
  recipe_id,
  lineage_id: e.lineage,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  spend: { usd: "0", amount: null },
  sandbox_s: 0,
  started_at: 1,
  finished_at: 2,
});

describe("audit A2: author-blind oracles (SPEC 10.7)", () => {
  test("OFF-01: POST provenance answers a stranger the same whether or not its guess names the author", async () => {
    const e = (env = await setup({ verifiers: 3 }));
    const a = await makeAuthor(e);
    const c = await submit(e, a, diff("off01"));
    const stranger = agentClient(e);
    const { recipe_id } = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    const right = await stranger.c.post(`/v1/candidates/${c.commit_id}/provenance`, { record: provenanceRecord(e, c, a.id, recipe_id), sig: "x" });
    const wrong = await stranger.c.post(`/v1/candidates/${c.commit_id}/provenance`, { record: provenanceRecord(e, c, e.verifiers[0]!.id, recipe_id), sig: "x" });
    expect(right.status).toBe(wrong.status);
    expect(right.body.error).toBe(wrong.body.error);
  });

  test("OFF-03: a canary's first reveal publishes no units and no slash before every replay is in", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("off03canary") }));
    const author = await makeAuthor(e);
    warmShadows(e);
    e.clock.advance(5_000);
    const real = await submit(e, author, diff("off03real"));
    settleCanaries(e);
    const canary = e.core.db.query<{ candidate_id: string }, []>("SELECT candidate_id FROM candidates WHERE is_canary = 1 AND candidate_id IS NOT NULL").get();
    expect(canary).toBeTruthy();
    expect(canary!.candidate_id).not.toBe(real.candidate_id);
    // every assigned replayer of the canary commits "accept" (rubber stamps)
    const held = [];
    for (const v of e.verifiers) for (const asg of await assignmentsFor(v, canary!.candidate_id)) if (asg.status === "assigned") held.push(await commitReplay(v, asg, result({}, 900)));
    expect(held.length).toBeGreaterThanOrEqual(2);
    const before = e.core.lastEventId();
    await revealReplay(held[0]!);
    const after = e.core.events(before, 1000).map((x) => x.type);
    expect(after).toContain("replay.revealed");
    expect(after.filter((t) => t === "units.awarded" || t === "agent.slashed" || t === "agent.strike")).toEqual([]);
    // once every replay is in, the canary is judged and the rubber stamps are slashed
    for (const h of held.slice(1)) await revealReplay(h);
    const later = e.core.events(before, 5000).filter((x) => x.type === "agent.slashed").length;
    expect(later).toBeGreaterThan(0);
  }, 60_000);

  test("OFF-07: a shadow whose canary was listed at its epoch's close is retired", async () => {
    const e = (env = await setup({ verifiers: 6, over: { canary_rate: 1, max_open_replays: 4, ...CANARY_FAST } }));
    await expectOk(e.admin.c.post("/v1/admin/canaries", { lineage_id: e.lineage, kind: "perf", target: "ir", expected_reason: "tests_fail", patch: diff("off07canary") }));
    const author = await makeAuthor(e);
    warmShadows(e);
    e.clock.advance(5_000);
    await submit(e, author, diff("off07real"));
    settleCanaries(e);
    const cn = e.core.db.query<{ commit_id: string; candidate_id: string; author: string }, []>("SELECT commit_id, candidate_id, author FROM candidates WHERE is_canary = 1").get()!;
    // honest replayers reject it (tests fail), so neither the reason nor a canary_fail exposes the shadow
    await runReplays(e, cn.candidate_id, honest(result({ tests: { base_pass: ["t1", "t2", "t3"], cand_pass: ["t1"], cand_fail: ["t2", "t3"] } })));
    const st = e.core.db.query<{ status: string }, [string]>("SELECT status FROM candidates WHERE commit_id = ?").get(cn.commit_id)!.status;
    expect(["rejected", "expired"]).toContain(st);
    e.core.db.query("UPDATE shadows SET max_uses = 100 WHERE agent_id = ?").run(cn.author);
    // OFF-04: before the close a passing canary replay reads `counted`, like a real rejection's
    const open = await expectOk(e.anon.get(`/v1/candidates/${cn.candidate_id}`));
    expect(open.replays.map((r: any) => r.role)).not.toContain("canary_pass");
    expect(open.canary).toBeNull();
    await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    for (let i = 0; i < 3; i++) {
      e.clock.advance(5_000);
      e.core.tick();
    }
    const listed = await expectOk(e.anon.get(`/v1/candidates/${cn.candidate_id}`));
    expect(listed.canary).not.toBeNull();
    const sh = e.core.db.query<{ retired_at: number | null }, [string]>("SELECT retired_at FROM shadows WHERE agent_id = ?").get(cn.author)!;
    expect(sh.retired_at).not.toBeNull();
  }, 60_000);

  test("OFF-13: the public hotspot assignment event names no replayer", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    // the event shape is what matters; emit through the module's own path is covered by findings.test.ts
    const src = await Bun.file(new URL("../src/findings.ts", import.meta.url)).text();
    const line = src.split("\n").find((l) => l.includes('"hotspot.replay_assigned"'))!;
    expect(line).not.toContain("replayer");
    void e;
  });
});

test("OFF-06: a withdrawn intent no longer names the agent of a later sealed session", async () => {
  const e = (env = await setup({ verifiers: 3 }));
  const a = await makeAuthor(e);
  const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
  const st = { agent: a.id, lineage_id: e.lineage, tip: lv.tip, kind: "perf", target: "ir", ttl_s: 600, note: null };
  const it = await expectOk(a.c.post("/v1/intents", { lineage_id: e.lineage, tip: lv.tip, kind: "perf", target: "ir", ttl_s: 600, sig: signStatement(a.key, "intent", intentStatement(st as never)) }));
  await expectOk(a.c.request("DELETE", `/v1/intents/${it.intent_id}`));
  e.clock.advance(61_000);
  const s = await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
  await expectOk(a.c.post(`/v1/sessions/${s.session_id}/events`, { events: [{ kind: "read", path: "src/lib.rs", start_line: 1, end_line: 2 }] }));
  const salt = sha256Hex("off06").slice(0, 32);
  await expectOk(a.c.post("/v1/candidates", { lineage_id: e.lineage, parent_gen_id: lv.tip, kind: "perf", target: "ir", commitment: patchCommitment(patchHash(canonicalizeDiff(diff("off06"))), salt), claimed_effect: 0.1 }));
  const v = await expectOk(e.anon.get(`/v1/sessions/${s.session_id}`));
  expect(v.state).toBe("sealed");
  expect(v.agent).toBeNull();
});

describe("audit A2: HTTP parsing and abuse limits", () => {
  test("OFF-11: malformed numbers and percent-encoding answer 400, never 500, and limit=-1 is not 'no limit'", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    for (const u of [
      "/v1/candidates?limit=NaN",
      "/v1/candidates?limit=-1",
      "/v1/intents?limit=abc",
      "/v1/activity?limit=%00",
      "/v1/sessions?limit=1e309",
      "/v1/events/log?limit=-1",
      `/v1/lineages/${e.lineage}/board?after=x`,
      "/v1/agents/%E0%A4%A/records",
      "/v1/lineages/%E0%A4%A/workboard",
    ]) {
      const r = await e.anon.get(u);
      expect([u, r.status]).toEqual([u, 400]);
    }
  });

  test("OFF-12: an unhandled error answers a generic 500 without the exception text", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const orig = e.core.listAgents.bind(e.core);
    (e.core as any).listAgents = () => {
      throw new Error("SQLITE secret path /var/lib/lineage/core.db");
    };
    const r = await e.anon.get("/v1/agents");
    (e.core as any).listAgents = orig;
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("/var/lib");
  });

  test("OFF-14: usage records refuse NaN, negative or non-integer figures and over-long refs", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const a = await makeAuthor(e);
    for (const bad of [{ model_tokens: "NaN" }, { model_tokens: -5 }, { model_tokens: 1.5 }, { sandbox_seconds: -1 }, { ref: "r".repeat(201) }, { ref: { x: 1 } }]) {
      const r = await e.admin.c.post("/v1/admin/usage", { agent: a.id, amount: "1", ...bad });
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
    await expectOk(e.admin.c.post("/v1/admin/usage", { agent: a.id, amount: "1", model_tokens: 10, sandbox_seconds: 1.5, ref: "ok-1" }));
  });

  test("OFF-16: a failing first request to a lazily built module does not roll back its tables", async () => {
    const e = (env = await setup({ verifiers: 1 }));
    const a = await makeAuthor(e);
    expect((await e.anon.get("/v1/sessions/unknown")).status).toBe(404);
    const lv = await expectOk(e.anon.get(`/v1/lineages/${e.lineage}`));
    await expectOk(a.c.post("/v1/sessions", { lineage_id: e.lineage, gen_id: lv.tip, commit: lv.snapshot.commit_sha, proposer: "anthropic" }));
    expect((await e.anon.get("/v1/findings/hotspots/unknown")).status).toBe(404);
    expect((await e.anon.get("/v1/findings/hotspots")).status).toBe(200);
  });

  test("OFF-15: dot-only GitHub owner or repo names are refused", () => {
    expect(githubFullName("https://github.com/../user")).toBeNull();
    expect(githubFullName("https://github.com/a/..")).toBeNull();
    expect(githubFullName("https://github.com/./.")).toBeNull();
    expect(githubFullName("https://github.com/karpathy/minbpe")).toBe("karpathy/minbpe");
    expect(githubFullName("https://github.com/a/.dotfiles")).toBe("a/.dotfiles");
  });
});
