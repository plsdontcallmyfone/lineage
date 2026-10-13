import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKey } from "@units/protocol";
import type { CoreClient } from "../../core/src/client.ts";
import { historyOf, plain, readTree, recipeName, UnitSetup, unitSetupError, type DraftJob, type DraftResult, type Reading, type RepoSetup, type SetupHost } from "../src/unit-setup.ts";

// Unit setup (unit-setup.ts): the free reading of a repository, and the state machine that has one
// agent draft a recipe, waits for the verifiers, retries with a bound, and always says why.

function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "unit-setup-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}

describe("reading a repository", () => {
  test("python with tests has a class and no objection", () => {
    const r = readTree(tree({ "pkg/core.py": "def f(): return 1\n", "tests/test_core.py": "def test_f(): pass\n", "README.md": "x" }));
    expect(r).toEqual({ class: "python", tests: 1, tests_in: ["tests"], impossible: null });
  });
  test("python tests found by content when no file is named for them", () => {
    const r = readTree(tree({ "lib.py": "import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass\n" }));
    expect(r.impossible).toBeNull();
  });
  test("a training script with no tests that calls CUDA: both facts in one sentence", () => {
    const r = readTree(tree({ "train.py": "import torch\ncap = torch.cuda.get_device_capability()\n", "prepare.py": "import torch\nx = torch.empty(2, device=\"cuda\")\n", "README.md": "x" }));
    expect(r.class).toBe("python");
    expect(r.impossible).toBe("it has no tests, and a unit needs the repository's own tests to check every change; its code also calls CUDA (a GPU) in prepare.py and train.py, and units are measured on CPUs");
  });
  test("rust, go, zig and a solana program", () => {
    expect(readTree(tree({ "Cargo.toml": "", "src/lib.rs": "#[cfg(test)]\nmod t { #[test] fn a() {} }\n" }))).toMatchObject({ class: "rust", impossible: null });
    expect(readTree(tree({ "Cargo.toml": "", "Anchor.toml": "", "programs/p/src/lib.rs": "fn a() {}\n", "programs/p/tests/t.rs": "#[test] fn a() {}\n" }))).toMatchObject({ class: "solana", impossible: null });
    expect(readTree(tree({ "go.mod": "", "a.go": "package a\n", "a_test.go": "package a\n" }))).toMatchObject({ class: "go", impossible: null });
    expect(readTree(tree({ "build.zig": "", "src/main.zig": "test \"x\" {}\n" }))).toMatchObject({ class: "zig", impossible: null });
    expect(readTree(tree({ "go.mod": "", "a.go": "package a\n" })).impossible).toContain("it has no tests");
  });
  test("a language with no toolchain image", () => {
    const r = readTree(tree({ "index.ts": "export {}\n", "a.ts": "", "package.json": "{}" }));
    expect(r.class).toBeNull();
    expect(r.impossible).toContain("no toolchain image for its language (mostly .ts files)");
  });
});

test("recipe names: the repository's name, then owner and name, then numbered", () => {
  expect(recipeName("https://github.com/Simple/Thing.Py", new Set())).toBe("thing-py");
  expect(recipeName("https://github.com/acme/thing", new Set(["thing"]))).toBe("acme-thing");
  expect(recipeName("https://github.com/acme/thing", new Set(["thing", "acme-thing"]))).toBe("thing-2");
  expect(recipeName("https://github.com/acme/x", new Set())).toBe("x-unit");
});

test("a public sentence has no em dash, one line and at most 280 characters", () => {
  const s = plain(`a \u2014 b\n${"x".repeat(400)}`);
  expect(s.includes("\u2014")).toBe(false);
  expect(s.includes("\n")).toBe(false);
  expect(s.length).toBeLessThanOrEqual(280);
});

test("config check", () => {
  expect(unitSetupError(undefined)).toBeNull();
  expect(unitSetupError({ enabled: false, draft_max_usd: 1, max_drafts: 2 })).toBeNull();
  expect(unitSetupError({ draft_max_usd: 0 })).toContain("draft_max_usd");
  expect(unitSetupError({ max_drafts: 0 })).toContain("max_drafts");
  expect(unitSetupError({ first_trial_turns: 8 })).toBeNull();
  expect(unitSetupError({ first_trial_turns: 0 })).toContain("first_trial_turns");
});

const REPO = "https://github.com/acme/thing";
const A = "AgentAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const B = "AgentBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";

function world(o: { agents: { agent: string; status: string; target_repo?: string }[]; read?: () => Promise<Reading>; draft?: (j: DraftJob) => Promise<DraftResult>; budget?: (agent: string) => { usd: number } | { usd: null; why: string }; cfg?: Record<string, unknown> }) {
  const w = {
    now: 1_000_000,
    life: new Map<string, string>(o.agents.map((a) => [a.agent, "setting_up"])),
    proposals: [] as any[],
    store: {} as Record<string, RepoSetup>,
    drafts: [] as DraftJob[],
    reads: 0,
    jobs: [] as Promise<void>[],
    running: new Set<string>(),
    metered: [] as { agent: string; usd: number }[],
    logs: [] as string[],
  };
  const core = {
    get: async (path: string) => {
      if (path.startsWith("/v1/agents")) return { status: 200, body: [...w.life].map(([agent_id, lifecycle]) => ({ agent_id, lifecycle })) };
      if (path.startsWith("/v1/recipe-proposals")) return { status: 200, body: w.proposals };
      return { status: 404, body: null };
    },
  } as unknown as CoreClient;
  const host: SetupHost = {
    core,
    log: (m) => w.logs.push(m),
    now: () => w.now,
    save: () => {},
    store: () => w.store,
    agents: () => o.agents.map((a) => ({ agent: a.agent, status: a.status, target_repo: a.target_repo ?? REPO })),
    keyOf: () => ({ id: "k" }) as unknown as AgentKey,
    awake: () => true,
    busy: (a) => w.running.has(a),
    freeSlot: () => true,
    budget: (agent, cap) => o.budget?.(agent) ?? { usd: cap },
    run: (agent, _max, job) => {
      w.running.add(agent);
      w.jobs.push(job({ model: (u) => w.metered.push({ agent, usd: u.usd }), sandbox: () => {} }).finally(() => w.running.delete(agent)));
    },
  };
  const setup = new UnitSetup(o.cfg, host, {
    read: async () => (w.reads++, o.read ? o.read() : { ok: true, commit: "c".repeat(40), class: "python" }),
    draft: async (j) => {
      w.drafts.push(j);
      j.meter.model({ model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.25 });
      return o.draft ? o.draft(j) : { kind: "proposed", proposal_id: "p1", name: "thing" };
    },
  });
  /** one runtime tick, then everything it started in the background */
  const tick = async (advance_ms = 31_000) => {
    w.now += advance_ms;
    await setup.tick();
    await Bun.sleep(0);
    await Promise.all(w.jobs);
  };
  return { w, setup, tick };
}

describe("unit setup", () => {
  test("two agents on one new repository: one draft, one proposal, both say why they wait, both work once Core creates the unit", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: B, status: "bound" }, { agent: A, status: "bound" }] });
    await tick(); // the free reading starts
    expect(setup.reason(A)!.why).toBe("setting up: reading acme/thing");
    await tick(); // read: the draft starts, by the first agent id
    expect(w.drafts.length).toBe(1);
    expect(w.drafts[0]!.agent).toBe(A);
    expect(w.metered).toEqual([{ agent: A, usd: 0.25 }]);
    expect(w.store[REPO]).toMatchObject({ drafts: 1, usd: 0.25, proposal_id: "p1" });
    w.proposals = [{ proposal_id: "p1", repo: REPO, class: "python", status: "calibrating", reason: null, round: 0, replays: [{ status: "committed", round: 0 }, { status: "assigned", round: 0 }] }];
    await tick();
    await tick();
    expect(w.drafts.length).toBe(1); // no second proposal while one is open
    expect(setup.reason(A)!.why).toBe("setting up: verifiers are calibrating the unit drafted for acme/thing (1 of 2 measured)");
    expect(setup.reason(B)!.why).toBe(setup.reason(A)!.why);
    expect(setup.settingUp(A)).toBe(true);
    w.proposals[0].status = "accepted";
    w.life.set(A, "active");
    w.life.set(B, "active");
    await tick();
    expect(setup.settingUp(A)).toBe(false);
    expect(setup.reason(A)).toBeNull();
    expect(setup.reason(B)).toBeNull();
    expect(w.drafts.length).toBe(1);
  });

  test("a repository that cannot have a unit: no model call, one final sentence, also for an agent that is not bound", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: A, status: "awaiting_owner" }], read: async () => ({ ok: false, commit: "c".repeat(40), class: "python", impossible: "it has no tests, and a unit needs the repository's own tests to check every change" }) });
    await tick();
    await tick();
    expect(w.drafts.length).toBe(0);
    expect(setup.reason(A)).toEqual({ why: "no unit possible for acme/thing: it has no tests, and a unit needs the repository's own tests to check every change", final: true });
    await tick(3_600_000);
    expect(w.reads).toBe(1); // read again only after recheck_s
  });

  test("an agent that is not bound says what it waits for and spends nothing", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: A, status: "awaiting_owner" }] });
    await tick();
    await tick();
    expect(w.drafts.length).toBe(0);
    expect(setup.reason(A)!.why).toContain("waiting for the launcher to bind the agent to the hosted runtime");
  });

  test("a failed draft: retried after a backoff, bounded, with the reason on the page all the way", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: A, status: "bound" }], draft: async () => ({ kind: "failed", reason: "the benchmark was not stable" }), cfg: { max_drafts: 2, retry_s: 600 } });
    await tick();
    await tick();
    expect(w.drafts.length).toBe(1);
    await tick();
    expect(setup.reason(A)!.why).toMatch(/^setting up: draft 1 of 2 did not pass: the benchmark was not stable; next try \d\d:\d\d UTC$/);
    await tick(300_000);
    expect(w.drafts.length).toBe(1); // inside the backoff
    await tick(600_000);
    expect(w.drafts.length).toBe(2);
    await tick(86_400_000);
    await tick();
    expect(w.drafts.length).toBe(2); // the bound: no third draft
    expect(setup.reason(A)).toEqual({ why: "unit setup for acme/thing stopped after 2 drafts and 0.50 USD: draft 2 of 2 did not pass: the benchmark was not stable", final: true });
  });

  test("a failed trial is kept with why: in the log, in the state, in the next draft's job, on the Runway detail; the public sentence says it in fixed words", async () => {
    const build = { stage: "build" as const, kind: "compile", cause: "error[E0433]: failed to resolve: use of undeclared crate `x` in curve25519/src/lib.rs:12", seconds: 96.4 };
    const tests = { stage: "tests" as const, kind: "none_stable", cause: "no test passed in every run: 3 failed every run (a, b, c)" };
    let n = 0;
    const { w, setup, tick } = world({
      agents: [{ agent: A, status: "bound" }],
      cfg: { max_drafts: 2, retry_s: 600 },
      draft: async () =>
        ++n === 1
          ? { kind: "failed", reason: "trial 1 failed at build (compile error), and it reached its spend limit", trials: [{ n: 1, ok: false, seconds: 427, reason: build }], before_trial: { turns: 24, usd: 1.2 }, dir: "/state/unit-setup/thing-1" }
          : { kind: "failed", reason: "trial 2 failed at tests (no test passed every run), and it reached its spend limit", trials: [{ n: 1, ok: false, seconds: 174, reason: build }, { n: 2, ok: false, seconds: 392, reason: tests }], dir: "/state/unit-setup/thing-2" },
    });
    await tick();
    await tick();
    await tick();
    // the public sentence: the stage and the rule in fixed words, never the sandbox's own output
    expect(setup.reason(A)!.why).toMatch(/^setting up: draft 1 of 2 did not pass: trial 1 failed at build \(compile error\), and it reached its spend limit; next try \d\d:\d\d UTC$/);
    expect(setup.reason(A)!.why).not.toContain("E0433");
    // the journal line carries the cause
    expect(w.logs.find((l) => l.startsWith("unit setup for acme/thing: draft 1 of 2 did not pass"))).toContain("[build: error[E0433]: failed to resolve: use of undeclared crate `x` in curve25519/src/lib.rs:12]; next draft");
    // the state keeps the trial, and the spend report's detail is the last failed one
    const at = w.now - 31_000; // the tick the draft ran in
    expect(w.store[REPO]!.trials).toEqual([{ draft: 1, at, n: 1, ok: false, seconds: 427, reason: build }]);
    expect(w.store[REPO]!.last_dir).toBe("/state/unit-setup/thing-1");
    expect(setup.detail(A)).toEqual({ draft: 1, trial: 1, stage: "build", kind: "compile", cause: build.cause, seconds: 96.4, at });
    // the next draft starts from it
    await tick(600_000);
    expect(w.drafts.length).toBe(2);
    expect(w.drafts[1]!.history).toEqual([{ draft: 1, trials: [{ n: 1, ok: false, seconds: 427, reason: build }] }]);
    expect(w.drafts[1]!.resume).toBe("/state/unit-setup/thing-1");
    expect(w.drafts[0]!.history).toEqual([]);
    await tick(86_400_000);
    await tick();
    // the final state says what the last failure was
    expect(setup.reason(A)).toEqual({ why: "unit setup for acme/thing stopped after 2 drafts and 0.50 USD: draft 2 of 2 did not pass: trial 2 failed at tests (no test passed every run), and it reached its spend limit", final: true });
    expect(setup.detail(A)).toMatchObject({ draft: 2, trial: 2, stage: "tests", kind: "none_stable", cause: tests.cause });
    expect(w.store[REPO]!.trials!.map((t) => `${t.draft}.${t.n}`)).toEqual(["1.1", "2.1", "2.2"]);
    expect(historyOf(w.store[REPO]!).map((d) => d.trials.length)).toEqual([1, 2]);
  });

  test("the drafting model finds the repository impossible: final, no further draft", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: A, status: "bound" }], draft: async () => ({ kind: "impossible", reason: "its tests need a GPU" }) });
    await tick();
    await tick();
    await tick();
    await tick(86_400_000);
    expect(w.drafts.length).toBe(1);
    expect(setup.reason(A)).toEqual({ why: "no unit possible for acme/thing: its tests need a GPU", final: true });
  });

  test("verifiers reject the proposal: counted as a failed draft with their reason, then a new draft", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: A, status: "bound" }], cfg: { retry_s: 60 } });
    await tick();
    await tick();
    w.proposals = [{ proposal_id: "p1", repo: REPO, class: "python", status: "rejected", reason: "stable test sets differ", round: 0, replays: [] }];
    await tick();
    expect(setup.reason(A)!.why).toContain("the verifiers' calibrations of draft 1 did not agree (stable test sets differ)");
    await tick(120_000);
    expect(w.drafts.length).toBe(2);
  });

  test("an agent that cannot pay: said so, no draft; a draft that throws is not counted as a draft", async () => {
    const poor = world({ agents: [{ agent: A, status: "bound" }], budget: () => ({ usd: null, why: "compute vault exhausted (0 base units unowed)" }) });
    await poor.tick();
    await poor.tick();
    expect(poor.w.drafts.length).toBe(0);
    expect(poor.setup.reason(A)!.why).toBe("setting up: no agent of acme/thing can pay for the draft of its unit now (compute vault exhausted (0 base units unowed))");
    const down = world({ agents: [{ agent: A, status: "bound" }], draft: async () => { throw new Error("model provider is down"); } });
    await down.tick();
    await down.tick();
    await down.tick();
    expect(down.w.store[REPO]).toMatchObject({ drafts: 0, errors: 1 });
    expect(down.setup.reason(A)!.why).toMatch(/^setting up: the draft could not run \(model provider is down\); next try/);
  });

  test("turned off: nothing is read and no agent is held back", async () => {
    const { w, setup, tick } = world({ agents: [{ agent: A, status: "bound" }], cfg: { enabled: false } });
    await tick();
    expect(w.reads).toBe(0);
    expect(setup.settingUp(A)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
// in the runtime: the draft is an attempt of the agent (slot, meter, vault), an agent with no unit
// starts no authoring attempt, and the spend report carries the sentence, also for unbound agents

import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { generateAgentKey } from "@units/protocol";
import { parseConfig, Runtime, type Backend } from "../src/index.ts";

const dirs: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
afterAll(() => {
  server?.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("runtime wiring: a setting_up agent drafts instead of authoring, pays from its vault, and every agent says why", async () => {
  const a = generateAgentKey().id;
  const b = generateAgentKey().id;
  const life: Record<string, string> = { [a]: "setting_up", [b]: "setting_up" };
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v1/agents") return Response.json(Object.entries(life).map(([agent_id, lifecycle]) => ({ agent_id, lifecycle })));
      if (u.pathname === "/v1/recipe-proposals") return Response.json([]);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "units-unit-setup-rt-"));
  dirs.push(dir);
  const backend: Backend = {
    mode: "sim",
    init: async () => ({ decimals: 6, sleepThreshold: 0n, wakeThreshold: 0n, maxDebitPerEpoch: null }),
    discover: async () => [],
    signingKey: async () => null,
    vault: async () => ({ balance: 0n, awake: false }),
    bindRequest: async () => ({}),
    nextEpoch: async (n) => ({ epoch: n, earliestS: 0 }),
    post: async () => {},
    refreshAwake: async () => false,
  };
  const lines: string[] = [];
  const authored: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const cfg = parseConfig({ mode: "sim", core: `http://127.0.0.1:${server.port}`, runtime_key: "k", state_dir: dir, compute_price_line_per_usd: "1", compute_price_line_per_sandbox_s: "0", attempt_max_usd: 1, sandbox_reserve_s: 0, min_attempt_usd: 0.05, unit_setup: { draft_max_usd: 0.5 } });
  const rt = new Runtime(cfg, {
    backend, runtimeKey: generateAgentKey(), log: (m) => lines.push(m), telemetry: false,
    proposer: (agent) => ({ name: "none", propose: async () => (authored.push(agent), null) }),
    unitSetup: {
      read: async () => ({ ok: true, commit: "c".repeat(40), class: "python" }),
      draft: async (j) => {
        j.meter.model({ model: "m", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.3 });
        j.meter.sandbox(12);
        await gate;
        return { kind: "failed", reason: "trial 1 failed at build (compile error), and it reached its spend limit", trials: [{ n: 1, ok: false, seconds: 189, reason: { stage: "build", kind: "compile", cause: "error[E0499]: cannot borrow `*r` as mutable more than once at a time in syscall/solana-bn254/examples/lineage_equiv.rs:63", seconds: 127.2 } }] };
      },
    },
  });
  await rt.start();
  const r = rt as unknown as {
    vaults: Map<string, { balance: bigint; awake: boolean }>; hosted: Map<string, unknown>; state: { agents: Record<string, unknown>; unit_setup?: Record<string, RepoSetup> }; running: Map<string, { promise: Promise<void> }>; workers: Map<string, unknown>;
    setup: UnitSetup; startAttempts(): void; usageOf(agent: string): { attempts: number; usd: number; sandbox_s: number };
  };
  for (const [agent, status] of [[a, "bound"], [b, "awaiting_owner"]] as const) {
    r.state.agents[agent] = { key_id: "x", key_file: "x", status, discovered_at: 0, bound_at: 0, mint: null, target_repo: REPO, candidates: 0 };
    r.hosted.set(agent, { agent, mint: null, launcher: null, target_repo: REPO });
  }
  r.vaults.set(a, { balance: 5_000_000n, awake: true });
  await r.setup.tick(); // reads Core and the repository
  await Bun.sleep(5);
  await r.setup.tick(); // starts the draft
  expect(r.running.has(a)).toBe(true);
  r.startAttempts();
  expect(r.workers.size).toBe(0); // no authoring attempt for an agent with no unit
  expect(authored).toEqual([]);
  let rep = rt.spendReport();
  expect(rep.agents[a]!.waiting).toBe("setting up: drafting the unit for acme/thing (draft 1 of 3)");
  expect(rep.agents[b]).toMatchObject({ bound: false, vault: null, waiting: `setting up: agent ${a.slice(0, 6)} is drafting the unit for acme/thing; one draft serves every agent of the repository` });
  release();
  await r.running.get(a)!.promise;
  expect(r.running.has(a)).toBe(false);
  expect(r.usageOf(a)).toMatchObject({ attempts: 1, usd: 0.3, sandbox_s: 12 }); // metered to the drafter's vault like an attempt
  expect(r.state.unit_setup![REPO]).toMatchObject({ drafts: 1, usd: 0.3 });
  expect(b in rt.state.open.usage).toBe(false); // the unbound agent is never charged
  await r.setup.tick();
  rep = rt.spendReport();
  expect(rep.agents[a]!.waiting).toMatch(/^setting up: draft 1 of 3 did not pass: trial 1 failed at build \(compile error\), and it reached its spend limit; next try \d\d:\d\d UTC$/);
  // the report carries the failed trial with the sandbox's own line, for the Runway panel, also for the agent that is not bound
  const detail = { draft: 1, trial: 1, stage: "build", kind: "compile", cause: "error[E0499]: cannot borrow `*r` as mutable more than once at a time in syscall/solana-bn254/examples/lineage_equiv.rs:63", seconds: 127.2 };
  expect(rep.agents[a]!.setup).toMatchObject(detail);
  expect(rep.agents[b]!.setup).toMatchObject(detail);
  expect(lines.find((l) => l.startsWith("unit setup for acme/thing: draft 1 of 3 did not pass"))).toContain("[build: error[E0499]: cannot borrow `*r` as mutable more than once at a time in syscall/solana-bn254/examples/lineage_equiv.rs:63]");
  // the unit exists now: the sentence goes, the bound agent authors, the unbound one says what it waits for
  life[a] = "active";
  life[b] = "active";
  (r.setup as unknown as { readAt: number }).readAt = -Infinity;
  await r.setup.tick();
  rep = rt.spendReport();
  expect(rep.agents[a]!.waiting ?? "").not.toContain("setting up");
  expect(rep.agents[a]!.setup).toBeUndefined();
  expect(rep.agents[b]).toMatchObject({ bound: false, waiting: "waiting for its owner's wallet to sign the binding to the hosted runtime" });
  expect(r.setup.settingUp(a)).toBe(false);
  await rt.stop({ flush: false });
});
