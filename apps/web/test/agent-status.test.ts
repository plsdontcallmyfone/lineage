import { describe, expect, test } from "bun:test";
import { actionLink, agentStatus, cannotReason, factsOf, statusHtml, statusSlot, STALE_MS, type AgentFacts } from "../src/agent-status.ts";

// The one status line (src/agent-status.ts): every case to its exact words. The waiting sentences are
// the hosted runtime's own (packages/runtime/src/unit-setup.ts and runtime.ts), two of them copied from
// the mainnet site's report on 2026-10-13.

const base: AgentFacts = { hosted: true, bound: true, lifecycle: "active", awake: true, covered: null, working: false, waiting: null, desktop: "running", report_age_ms: 20_000 };
const f = (o: Partial<AgentFacts>): AgentFacts => ({ ...base, ...o });
const SETUP = { lifecycle: "setting_up" as const };
const NO_TESTS_GPU = "no unit possible for karpathy/autoresearch: it has no tests, and a unit needs the repository's own tests to check every change; its code also calls CUDA (a GPU) in prepare.py and train.py, and units are measured on CPUs";
const NO_SOURCE = "no unit possible for units-agents/units-learnings: there is no toolchain image for its language (no source files found); images exist for Python, Rust, Go, C and C++, Zig and Solana programs";
const AGAIN = " It reads the repository again by itself and starts when that changes.";

type Row = [name: string, facts: AgentFacts, label: string, sentence: string, action: string | null];
const rows: Row[] = [
  ["launching", f({ launching: true, bound: null, lifecycle: null, report_age_ms: null }), "Launching", "Its launch transactions are landing on Solana.", null],
  ["waiting for the launcher to finish setup", f({ bound: false, waiting: "waiting for its owner's wallet to sign the binding to the hosted runtime" }), "Finish setup", "It cannot start until your wallet signs one approval that lets the hosted runtime work for it.", "bind:Finish setup"],
  ["not bound, no report yet", f({ bound: false, lifecycle: null, report_age_ms: null }), "Finish setup", "It cannot start until your wallet signs one approval that lets the hosted runtime work for it.", "bind:Finish setup"],
  ["launched, the network has not read it", f({ lifecycle: null, report_age_ms: null }), "Launched", "It is launched on Solana and the network is reading the launch.", null],
  ["bound, the runtime has not reported", f({ report_age_ms: null }), "Starting", "The hosted runtime is picking it up. Work starts by itself.", null],
  ["setting up: reading", f({ ...SETUP, waiting: "setting up: reading morluto/rea" }), "Setting up", "It is reading the repository to set up how its work is measured.", null],
  ["setting up: drafting", f({ ...SETUP, waiting: "setting up: drafting the unit for morluto/rea (draft 1 of 3)" }), "Setting up", "It is writing how its work on this repository is measured. Verifiers check that next.", null],
  ["setting up: another agent drafts", f({ ...SETUP, waiting: "setting up: agent ALGNQF is drafting the unit for morluto/rea; one draft serves every agent of the repository" }), "Setting up", "Another agent of this repository is writing how work on it is measured; that serves this agent too.", null],
  ["setting up: waits for verifiers", f({ ...SETUP, waiting: "setting up: the unit drafted for morluto/rea waits for enough verifiers qualified for Python units to calibrate it" }), "Setting up", "Its measurement is written and waits for verifiers to check it.", null],
  ["setting up: verifiers checking the draft", f({ ...SETUP, waiting: "setting up: verifiers are calibrating the unit drafted for morluto/rea (1 of 3 measured)" }), "Setting up", "Verifiers are checking its measurement (1 of 3 done). Work starts when they agree.", null],
  ["setting up: created", f({ ...SETUP, waiting: "setting up: the unit for morluto/rea was created; work starts shortly" }), "Setting up", "Its measurement is ready. Work starts shortly.", null],
  ["setting up: a try did not pass", f({ ...SETUP, waiting: "setting up: draft 1 of 3 did not pass: the tests were not stable; next try 14:20 UTC" }), "Setting up", "The last try at setting up its measurement did not pass. It tries again at 14:20 UTC.", null],
  ["setting up: next in line", f({ ...SETUP, waiting: "setting up: the draft of the unit for morluto/rea starts when a slot is free" }), "Setting up", "It is next in line to set up its measurement.", null],
  ["setting up: nothing said yet", f({ ...SETUP }), "Setting up", "It is setting up how its work on this repository is measured.", null],
  ["setting up: cannot pay for it", f({ ...SETUP, waiting: "setting up: no agent of morluto/rea can pay for the draft of its unit now (asleep (vault below the wake threshold))" }), "Paused", "Its compute vault is too low to pay for an attempt. The vault refills from its coin's trading fees.", "fund:Open its coin"],
  ["cannot be measured: no tests and a GPU (mainnet, not bound)", f({ ...SETUP, bound: false, waiting: NO_TESTS_GPU }), "Cannot be measured", `It cannot work on this repository yet: it has no tests of its own, and every change must be checked by the repository's own tests. Its code also needs a GPU (prepare.py and train.py), and agents are measured on CPUs.${AGAIN}`, null],
  ["cannot be measured: no source code (mainnet)", f({ ...SETUP, waiting: NO_SOURCE }), "Cannot be measured", `It cannot work on this repository yet: no source code was found in it, and agents can build Python, Rust, Go, C and C++, Zig and Solana programs.${AGAIN}`, null],
  ["cannot be measured: a language agents cannot build", f({ ...SETUP, waiting: "no unit possible for o/r: there is no toolchain image for its language (mostly .js files); images exist for Python, Rust, Go, C and C++, Zig and Solana programs" }), "Cannot be measured", `It cannot work on this repository yet: it is mostly .js files, and agents can build Python, Rust, Go, C and C++, Zig and Solana programs.${AGAIN}`, null],
  ["cannot be measured: setup stopped", f({ ...SETUP, waiting: "unit setup for o/r stopped after 3 drafts and 3.20 USD: draft 3 of 3 did not pass: flaky" }), "Cannot be measured", `It cannot work on this repository yet: its measurement could not be set up in 3 tries.${AGAIN}`, null],
  ["cannot be measured: the agent's own finding", f({ ...SETUP, waiting: "no unit possible for o/r: its tests need a paid API key" }), "Cannot be measured", `It cannot work on this repository yet: the agent found no way to measure work on it.${AGAIN}`, null],
  ["working", f({ working: true }), "Working", "It is working on the repository now.", null],
  ["working on network compute", f({ working: true, awake: false, covered: { min_interval_s: 600 } }), "Working", "It is working now on network compute, a slower pace: one attempt every 10 minutes.", null],
  ["between attempts", f({}), "Between attempts", "It finished an attempt. The next one starts by itself.", null],
  ["on network compute, between attempts", f({ awake: false, covered: { min_interval_s: 600 } }), "Network compute", "Its vault cannot pay for an attempt, so the network pays, at a slower pace: one attempt every 10 minutes. Full pace returns when its vault is funded.", null],
  ["on network compute, interval not reported", f({ awake: false, covered: { min_interval_s: null } }), "Network compute", "Its vault cannot pay for an attempt, so the network pays, at a slower pace. Full pace returns when its vault is funded.", null],
  ["paused: vault low", f({ waiting: "Paused: vault low" }), "Paused", "Its compute vault is too low to pay for an attempt. The vault refills from its coin's trading fees.", "fund:Open its coin"],
  ["paused: asleep and not covered", f({ awake: false, waiting: "asleep (vault below the wake threshold)" }), "Paused", "Its compute vault is too low to pay for an attempt. The vault refills from its coin's trading fees.", "fund:Open its coin"],
  ["paused: vault exhausted", f({ waiting: "compute vault exhausted (0 base units unowed); a useful attempt needs 0.4000 USD, 0.0100 available" }), "Paused", "Its compute vault is too low to pay for an attempt. The vault refills from its coin's trading fees.", "fund:Open its coin"],
  ["desktop starting", f({ waiting: "waiting for a desktop: its desktop is starting" }), "Desktop starting", "Its desktop is starting. Work begins when it is up.", null],
  ["desktop starting, by its state", f({ desktop: "starting" }), "Desktop starting", "Its desktop is starting. Work begins when it is up.", null],
  ["runtime restarting", f({ report_age_ms: STALE_MS + 1 }), "Runtime restarting", "The hosted runtime is restarting. It is back within minutes; nothing to do.", null],
  ["runtime restarting while setting up", f({ ...SETUP, waiting: "setting up: reading o/r", report_age_ms: 3_600_000 }), "Runtime restarting", "The hosted runtime is restarting. It is back within minutes; nothing to do.", null],
  ["provider balance low", f({ waiting: "provider balance low (OpenRouter has 1.20 USD, 0.0000 free of running reserves)" }), "Waiting", "The network's model provider balance is low, so attempts wait. Nothing to do; it resumes when the balance is topped up.", null],
  ["network spending limit", f({ waiting: "global runtime cap (50 USD per 86400 s window) reached" }), "Waiting", "The network's spending limit for this period is reached. It resumes by itself in the next period.", null],
  ["its own spending limit", f({ waiting: "per-agent epoch cap reached" }), "Waiting", "It reached its own spending limit for this period. It resumes by itself in the next one.", null],
  ["no price", f({ waiting: "waiting for a quote price (stale)" }), "Waiting", "It waits for a price for its vault's coin. It resumes by itself when one is read.", null],
  ["vault not read yet", f({ waiting: "vault not read yet" }), "Starting", "The hosted runtime is picking it up. Work starts by itself.", null],
  ["a reason this page has no words for", f({ waiting: "spend record is not a finite number; refusing to start an attempt" }), "Waiting", "It is waiting to start its next attempt. Nothing to do.", null],
  ["key revoked", f({ revoked: true, bound: false }), "Key revoked", "Its signing key was revoked on chain, so nothing can work for it.", null],
  ["self-hosted", f({ hosted: false, bound: null, report_age_ms: null }), "Self-hosted", "You run this agent on your own machine with its key. Nothing runs for it here.", null],
  ["self-hosted, working", f({ hosted: false, bound: null, report_age_ms: null, working: true }), "Working", "It is working on the repository now.", null],
];

describe("agent status, for the launcher", () => {
  for (const [name, facts, label, sentence, action] of rows)
    test(name, () => {
      const s = agentStatus(facts);
      expect({ label: s.label, sentence: s.sentence, action: s.action ? `${s.action.kind}:${s.action.label}` : null }).toEqual({ label, sentence, action });
    });

  test("every label is at most three words; no sentence carries an internal word, a hedge or an em dash", () => {
    for (const [, facts] of rows)
      for (const viewer of ["launcher", "public"] as const) {
        const s = agentStatus(facts, viewer);
        expect(s.label.split(" ").length).toBeLessThanOrEqual(3);
        expect(`${s.label} ${s.sentence}`).not.toMatch(/—|\bTBA\b|not bound|setting_up|\bunits?\b|recipe|lineage|SPEC|toolchain|calibrat|draft|\bmay\b|\bmight\b|should|probably|currently/i);
        expect(s.sentence).toMatch(/[.]$/);
      }
  });
});

describe("agent status, for anyone else", () => {
  test("only the words about the launcher differ, and nobody else is asked to finish setup", () => {
    expect(agentStatus(f({ bound: false }), "public")).toEqual({ key: "unbound", label: "Setup not finished", tone: "warn", sentence: "It starts once its launcher finishes setup with one approval from their wallet.", action: null });
    expect(agentStatus(f({ hosted: false, bound: null, report_age_ms: null }), "public").sentence).toBe("Its owner runs it on their own machine. Nothing runs for it here.");
    for (const [, facts] of rows) {
      const a = agentStatus(facts, "launcher"), b = agentStatus(facts, "public");
      if (a.key !== "unbound" && a.key !== "self_hosted") expect(b).toEqual(a);
    }
  });
});

describe("the facts and the markup", () => {
  test("the chain's word on bound wins over the runtime's; without it the runtime's flag is used", () => {
    const spend = { reported_at: 1000, spend: { waiting: "waiting for its owner's wallet to sign the binding to the hosted runtime", bound: false } };
    expect(factsOf({ now: 2000, hosted: true, spend }).bound).toBe(false);
    expect(factsOf({ now: 2000, hosted: true, spend, bound: true }).bound).toBe(true);
    expect(agentStatus(factsOf({ now: 2000, hosted: true, lifecycle: "active", awake: true, spend, bound: true })).label).toBe("Starting");
    expect(factsOf({ now: 2000, hosted: true, spend: null })).toMatchObject({ bound: null, report_age_ms: null, waiting: null, covered: null, desktop: null });
    expect(factsOf({ now: 61_000, hosted: true, spend: { reported_at: 1000, spend: { covered: { min_interval_s: 600 }, desktop: { state: "starting" } } } })).toMatchObject({ bound: true, report_age_ms: 60_000, covered: { min_interval_s: 600 }, desktop: "starting" });
    // Core's own word on network compute, when the runtime's report does not carry it
    expect(factsOf({ now: 1, hosted: true, covered: true, spend: null }).covered).toEqual({ min_interval_s: null });
  });
  test("cannotReason reads only the runtime's two final sentences", () => {
    expect(cannotReason("setting up: reading o/r")).toBeNull();
    expect(cannotReason("Paused: vault low")).toBeNull();
    expect(cannotReason("unit setup for o/r stopped after 1 draft and 1.00 USD: x")).toBe("its measurement could not be set up in 1 try");
  });
  test("label, sentence and the action as a link to where it is done", () => {
    const unbound = agentStatus(f({ bound: false }));
    expect(statusHtml(unbound, actionLink(unbound, { mint: "M" })).s).toBe('<div class="as" data-status="unbound"><span class="as-l warn">Finish setup</span><p class="as-s">It cannot start until your wallet signs one approval that lets the hosted runtime work for it.</p><div class="as-a"><a class="wl-btn primary" href="/profile#agents" data-as-act="bind">Finish setup</a></div></div>');
    const paused = agentStatus(f({ waiting: "Paused: vault low" }));
    expect(actionLink(paused, { mint: "MINT" }) && (actionLink(paused, { mint: "MINT" }) as { s: string }).s).toBe('<a class="wl-btn" href="/tokens/MINT" data-as-act="fund">Open its coin</a>');
    expect(actionLink(paused, {})).toBe("");
    expect(statusHtml(agentStatus(f({}))).s).toBe('<div class="as" data-status="between"><span class="as-l good">Between attempts</span><p class="as-s">It finished an attempt. The next one starts by itself.</p></div>');
  });
  test("a slot asks for the runtime's report once and a repaint shows the kept answer", async () => {
    const agent = "HB2xZfFfPH9JwSPaJHBzq4QcQn4h8cfNQ6SxaxkeJP6u";
    let asked = 0;
    const fetcher = (async () => (asked++, Response.json({ reported_at: Date.now(), spend: { waiting: NO_TESTS_GPU, bound: false } }))) as unknown as typeof fetch;
    expect(statusSlot(agent, { hosted: true, lifecycle: "setting_up" }, "public", fetcher).s).toBe(`<div data-agent-status="${agent}" data-pending="1"></div>`);
    statusSlot(agent, { hosted: true, lifecycle: "setting_up" }, "public", fetcher);
    await Bun.sleep(5);
    const again = statusSlot(agent, { hosted: true, lifecycle: "setting_up" }, "public", fetcher).s;
    expect(again).toContain('data-status="cannot"');
    expect(again).toContain("Cannot be measured");
    expect(again).not.toContain("data-pending");
    expect(asked).toBe(1);
    expect(statusSlot("not an agent", { hosted: true }).s).toBe("");
  });
});
