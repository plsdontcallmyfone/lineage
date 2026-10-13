// One status line for an agent, written for its launcher (owner 2026-10-13, "clear comms"): a launcher
// must always know what is happening to their agent and what, if anything, they must do. agentStatus()
// turns the facts every page already reads (chain: bound or not; Core: lifecycle, awake, network
// compute; the market indexer: a live session; the hosted runtime's report: why it waits, its desktop)
// into a short label (at most three words), one plain sentence, and, only when someone must act, one
// action. Used by the launched screen, the Profile cards, the agent profile header, the coin page's
// building panel and the setup bar's popup, so they all say the same thing in the same words.
// The runtime's own sentence stays on the agent's Runway panel (pages/spend-section.ts) for the detail.
// A try at setting up the measurement that did not pass says what stopped it, in product words chosen
// by the stage and rule the runtime names ("trial 2 failed at build (compile error)"); the sandbox's
// own output (the compiler's line, the test names) is shown on the Runway panel only.
// Pure except statusSlot, which reads the runtime's report for pages that do not have it.
import { html, type Raw } from "./html.ts";

export interface AgentFacts {
  /** the launch's transactions are still landing */
  launching?: boolean;
  hosted: boolean;
  /** the hosted runtime holds its signing key (chain); null when not read */
  bound: boolean | null;
  /** its signing key was revoked on chain */
  revoked?: boolean;
  /** Core's lifecycle; null while Core has not read the launch, undefined when not asked */
  lifecycle?: "setting_up" | "active" | null;
  awake: boolean | null;
  /** network compute: the seconds between attempts the runtime reports (null when it did not say); null when not covered */
  covered: { min_interval_s: number | null } | null;
  /** a live session runs now */
  working: boolean;
  /** the hosted runtime's reason it is not working */
  waiting: string | null;
  desktop: "starting" | "running" | "paused" | "none" | null;
  /** how old the runtime's report is, ms; null when it never reported on this agent */
  report_age_ms: number | null;
}

export interface AgentStatus {
  key: string;
  label: string;
  tone: "good" | "warn" | "info" | "";
  sentence: string;
  /** what the launcher must do, or null: `bind` finishes setup, `fund` opens the coin whose fees fill the vault */
  action: { kind: "bind" | "fund"; label: string } | null;
}

/**
 * A report older than this means the runtime is restarting. It is Core's own limit for an old report
 * (config network_compute_report_max_age_s, 600 s): the runtime reports about once a minute, and on the
 * mainnet site a report was up to 394 s old in normal running (2026-10-13).
 */
export const STALE_MS = 600_000;

const list = (a: string[]) => (a.length <= 1 ? (a[0] ?? "") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

function every(s: number | null | undefined): string {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return "";
  if (s >= 60 && s % 60 === 0) return `: one attempt every ${s === 60 ? "minute" : `${s / 60} minutes`}`;
  return `: one attempt every ${s === 1 ? "second" : `${s} seconds`}`;
}

/**
 * What stopped a try at setting up the measurement, by the stage and the rule the runtime names
 * (packages/worker/src/trial-reason.ts: its stage words and KINDS; a test holds the two in step).
 * `head` completes "Its measurement ..."; `why` is the cause in product words.
 */
const SETUP_FAIL: Record<string, { head: string; why: Record<string, string>; other: string }> = {
  "the recipe": { head: "was not written correctly yet", why: { "recipe not valid": "its settings were not valid", "nothing new measured": "it measured nothing the repository's existing measurement does not" }, other: "its settings were not valid" },
  prepare: { head: "could not fetch what the code needs yet", why: { "a download failed": "a download failed", "toolchain version": "the repository asks for a compiler or language version the network does not run", "time limit": "fetching took longer than the time limit", "disk limit": "what the code depends on did not fit the disk limit", "memory limit": "fetching ran out of memory" }, other: "the step that fetches what the code depends on stopped with an error" },
  build: { head: "did not build yet", why: { "toolchain version": "the code would not compile on the compiler version the network runs", "a dependency was not fetched": "something the code depends on was not fetched before the build", "compile error": "the code or the benchmark written for it did not compile", "time limit": "the build took longer than the time limit", "memory limit": "the build ran out of memory", "disk limit": "the build ran out of disk", "process limit": "the build started more processes than the sandbox allows" }, other: "the build stopped with an error" },
  tests: { head: "did not pass its checks yet", why: { "test output not recognised": "the repository's tests did not report results the network can read", "no test passed every run": "none of the repository's tests passed on every run in the sandbox", "time limit": "the repository's tests took longer than the time limit", "a dependency was not fetched": "the repository's tests need something that was not fetched", "memory limit": "the repository's tests ran out of memory", "compile error": "the repository's tests did not compile" }, other: "the repository's tests did not run in the sandbox" },
  metrics: { head: "is not steady yet", why: { "a metric differed between identical runs": "a benchmark gave different readings on identical runs", "a metric gave no value": "a benchmark gave no reading", "a metric too noisy": "a benchmark's readings were too noisy to show a small improvement", "time limit": "a benchmark took longer than the time limit", "memory limit": "a benchmark ran out of memory" }, other: "a benchmark did not run" },
  equivalence: { head: "is not steady yet", why: { "equivalence output differed between identical runs": "its behaviour check printed different results on identical runs", "no equivalence harness": "it has no behaviour check yet", "equivalence harness printed nothing": "its behaviour check printed nothing", "time limit": "its behaviour check took longer than the time limit" }, other: "its behaviour check did not run" },
  headroom: { head: "measures too little of the code yet", why: {}, other: "too much of what its benchmark counts is not the repository's own code" },
  "the sandbox": { head: "could not be tried yet", why: {}, other: "the network's sandbox could not run it" },
};

/** "did not build yet: the code ... did not compile" from the runtime's sentence, or null when it names no failed trial. */
export const SETUP_FAIL_WORDS = SETUP_FAIL;

export function setupFailure(w: string): { head: string; why: string } | null {
  const m = /trial \d+ failed at (the recipe|prepare|build|tests|metrics|equivalence|headroom|the sandbox) \(([^)]+)\)/.exec(w);
  if (m) {
    const s = SETUP_FAIL[m[1]!]!;
    return { head: s.head, why: s.why[m[2]!] ?? s.other };
  }
  if (/before its first trial/.test(w)) return { head: "was not finished yet", why: "the try used its budget reading the repository before it could test anything" };
  if (/calibrations of draft \d+ did not agree/.test(w)) return { head: "was not confirmed yet", why: "the verifiers measured it and their results did not agree" };
  return null;
}

/** Why the repository cannot be measured, in the launcher's words, from the runtime's sentence; null when it says no such thing. */
export function cannotReason(w: string): string | null {
  const stopped = /^unit setup for .+? stopped after (\d+) drafts?/.exec(w);
  if (stopped) {
    const f = setupFailure(w);
    return `its measurement could not be set up in ${stopped[1]} ${stopped[1] === "1" ? "try" : "tries"}${f ? `. On the last one it ${f.head.replace(/ yet$/, "")}: ${f.why}` : ""}`;
  }
  const m = /^no unit possible for .+?: (.+)$/.exec(w);
  if (!m) return null;
  const r = m[1]!;
  if (/^it has no tests/.test(r)) {
    const gpu = /calls CUDA \(a GPU\) in (.+?), and units/.exec(r)?.[1]?.split(" and ") ?? [];
    return `it has no tests of its own, and every change must be checked by the repository's own tests${gpu.length ? `. Its code also needs a GPU (${list(gpu)}), and agents are measured on CPUs` : ""}`;
  }
  const lang = /no toolchain image for its language \((?:mostly (\.\w+) files|no source files found)\); images exist for (.+)$/.exec(r);
  if (lang) return `${lang[1] ? `it is mostly ${lang[1]} files` : "no source code was found in it"}, and agents can build ${lang[2]}`;
  return "the agent found no way to measure work on it";
}

const st = (key: string, label: string, tone: AgentStatus["tone"], sentence: string, action: AgentStatus["action"] = null): AgentStatus => ({ key, label, tone, sentence, action });
const PAUSED = (): AgentStatus => st("paused", "Paused", "warn", "Its compute vault is too low to pay for an attempt. The vault refills from its coin's trading fees.", { kind: "fund", label: "Open its coin" });
const VAULT = /^Paused: vault low$|compute vault exhausted|cannot pay for an attempt|can pay for the draft|^asleep|no OpenRouter route/;

/** The agent's state for `viewer`: its launcher (told what to do) or anyone else (told what it waits for). */
export function agentStatus(f: AgentFacts, viewer: "launcher" | "public" = "launcher"): AgentStatus {
  const mine = viewer === "launcher";
  const w = (f.waiting ?? "").trim();
  if (f.launching) return st("launching", "Launching", "info", "Its launch transactions are landing on Solana.");
  if (!f.hosted) {
    if (f.working) return st("working", "Working", "good", "It is working on the repository now.");
    return st("self_hosted", "Self-hosted", "", mine ? "You run this agent on your own machine with its key. Nothing runs for it here." : "Its owner runs it on their own machine. Nothing runs for it here.");
  }
  if (f.revoked) return st("revoked", "Key revoked", "warn", "Its signing key was revoked on chain, so nothing can work for it.");
  const cannot = cannotReason(w);
  if (cannot) return st("cannot", "Cannot be measured", "warn", `It cannot work on this repository yet: ${cannot}. It reads the repository again by itself and starts when that changes.`);
  const saysUnbound = /waiting for the launcher to bind|owner's wallet to sign the binding|moved the signing key away/.test(w);
  if (f.bound === false || (saysUnbound && f.bound !== true))
    return mine
      ? st("unbound", "Finish setup", "warn", "It cannot start until your wallet signs one approval that lets the hosted runtime work for it.", { kind: "bind", label: "Finish setup" })
      : st("unbound", "Setup not finished", "warn", "It starts once its launcher finishes setup with one approval from their wallet.");
  // bound on chain while the runtime's last report still waits for it: the runtime picks it up on its next read
  if (saysUnbound && !f.working) return st("starting", "Starting", "info", "The hosted runtime is picking it up. Work starts by itself.");
  if (f.working)
    return f.covered
      ? st("working_covered", "Working", "good", `It is working now on network compute, a slower pace${every(f.covered.min_interval_s)}.`)
      : st("working", "Working", "good", "It is working on the repository now.");
  if (f.lifecycle === null && f.report_age_ms === null) return st("launched", "Launched", "info", "It is launched on Solana and the network is reading the launch.");
  if (f.report_age_ms === null) return st("starting", "Starting", "info", "The hosted runtime is picking it up. Work starts by itself.");
  if (f.report_age_ms > STALE_MS) return st("restarting", "Runtime restarting", "info", "The hosted runtime is restarting. It is back within minutes; nothing to do.");
  if (f.lifecycle === "setting_up" || /^setting up: /.test(w)) {
    if (/can pay for the draft/.test(w)) return PAUSED();
    const v = /verifiers are calibrating .*\((\d+) of (\d+) measured\)/.exec(w);
    const retry = /next try (\d\d:\d\d UTC)/.exec(w);
    const fail = retry ? setupFailure(w) : null;
    const s =
      /^setting up: reading /.test(w) ? "It is reading the repository to set up how its work is measured."
      : /is drafting the unit/.test(w) ? "Another agent of this repository is writing how work on it is measured; that serves this agent too."
      : /^setting up: drafting the unit/.test(w) ? "It is writing how its work on this repository is measured. Verifiers check that next."
      : /waits for enough verifiers|goes to the verifiers/.test(w) ? "Its measurement is written and waits for verifiers to check it."
      : v ? `Verifiers are checking its measurement (${v[1]} of ${v[2]} done). Work starts when they agree.`
      : /was created; work starts shortly/.test(w) ? "Its measurement is ready. Work starts shortly."
      : retry && fail ? `Its measurement ${fail.head}: ${fail.why}. It tries again at ${retry[1]}.`
      : retry ? `The last try at setting up its measurement did not pass. It tries again at ${retry[1]}.`
      : /starts when a slot is free/.test(w) ? "It is next in line to set up its measurement."
      : "It is setting up how its work on this repository is measured.";
    return st("setting_up", "Setting up", "info", s);
  }
  if (/^waiting for a desktop/.test(w) || (f.desktop === "starting" && !f.covered && f.awake !== false)) return st("desktop", "Desktop starting", "info", "Its desktop is starting. Work begins when it is up.");
  if (/provider balance low/.test(w)) return st("provider", "Waiting", "", "The network's model provider balance is low, so attempts wait. Nothing to do; it resumes when the balance is topped up.");
  if (/global runtime cap/.test(w)) return st("cap", "Waiting", "", "The network's spending limit for this period is reached. It resumes by itself in the next period.");
  if (/epoch cap reached/.test(w)) return st("epoch_cap", "Waiting", "", "It reached its own spending limit for this period. It resumes by itself in the next one.");
  if (/waiting for a quote price/.test(w)) return st("price", "Waiting", "", "It waits for a price for its vault's coin. It resumes by itself when one is read.");
  if (/vault not read yet|vault unknown/.test(w)) return st("starting", "Starting", "info", "The hosted runtime is picking it up. Work starts by itself.");
  if (f.covered) {
    if (/no OpenRouter route/.test(w)) return PAUSED();
    return st("covered", "Network compute", "good", `Its vault cannot pay for an attempt, so the network pays, at a slower pace${every(f.covered.min_interval_s)}. Full pace returns when its vault is funded.`);
  }
  if (VAULT.test(w) || f.awake === false) return PAUSED();
  if (w) return st("waiting", "Waiting", "", "It is waiting to start its next attempt. Nothing to do.");
  return st("between", "Between attempts", "good", "It finished an attempt. The next one starts by itself.");
}

/** GET /v1/agents/:id/spend as the pages read it. */
export interface SpendAnswer {
  reported_at?: number | null;
  spend?: { waiting?: string | null; bound?: boolean; covered?: { min_interval_s?: unknown } | null; desktop?: { state?: string } | null } | null;
  /** the agent's model runs through a provider whose prepaid balance is low */
  provider_balance_low?: boolean;
}

/** The facts from what a page has read. `bound` is the chain's word when the page read it; else the runtime's. */
export function factsOf(o: { now: number; hosted: boolean; lifecycle?: string | null; awake?: boolean | null; covered?: boolean | null; live?: boolean; bound?: boolean | null; revoked?: boolean; launching?: boolean; spend?: SpendAnswer | null }): AgentFacts {
  const s = o.spend?.spend ?? null;
  const n = s?.covered?.min_interval_s;
  const d = s?.desktop?.state;
  return {
    launching: o.launching,
    hosted: o.hosted,
    bound: o.bound !== undefined && o.bound !== null ? o.bound : s ? s.bound !== false : null,
    revoked: o.revoked,
    lifecycle: o.lifecycle === "setting_up" || o.lifecycle === "active" ? o.lifecycle : o.lifecycle === null ? null : undefined,
    awake: o.awake ?? null,
    covered: s?.covered ? { min_interval_s: typeof n === "number" && Number.isFinite(n) ? n : null } : o.covered ? { min_interval_s: null } : null,
    working: !!o.live,
    waiting: typeof s?.waiting === "string" && s.waiting ? s.waiting : o.spend?.provider_balance_low ? "provider balance low" : null,
    desktop: d === "starting" || d === "running" || d === "paused" || d === "none" ? d : null,
    report_age_ms: typeof o.spend?.reported_at === "number" ? Math.max(0, o.now - o.spend.reported_at) : null,
  };
}

/** The status as markup: label, sentence and, when given, the action's button or link. */
export function statusHtml(s: AgentStatus, action: Raw | string = ""): Raw {
  return html`<div class="as" data-status="${s.key}"><span class="as-l${s.tone ? ` ${s.tone}` : ""}">${s.label}</span><p class="as-s">${s.sentence}</p>${action ? html`<div class="as-a">${action}</div>` : ""}</div>`;
}

/** The action as a link for pages that hold no wallet: finishing setup happens on the Profile, funding on the coin's page. */
export function actionLink(s: AgentStatus, o: { mint?: string | null }): Raw | "" {
  if (!s.action) return "";
  if (s.action.kind === "bind") return html`<a class="wl-btn primary" href="/profile#agents" data-as-act="bind">${s.action.label}</a>`;
  return o.mint ? html`<a class="wl-btn" href="/tokens/${o.mint}" data-as-act="fund">${s.action.label}</a>` : "";
}

const answers = new Map<string, { at: number; spend: SpendAnswer | null } | Promise<SpendAnswer | null>>();

/**
 * The status for a page that has not read the runtime's report: a slot filled once the report answers
 * (asked at most once every 30 s per agent; a repaint shows the kept answer at once). `onCoin` leaves
 * the "Open its coin" link out (the page is the coin's).
 */
export function statusSlot(agent: string, base: { hosted: boolean; lifecycle?: string | null; awake?: boolean | null; covered?: boolean | null; live?: boolean; mint?: string | null; onCoin?: boolean }, viewer: "launcher" | "public" = "public", f: typeof fetch = fetch): Raw {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agent)) return html``;
  const paint = (spend: SpendAnswer | null) => {
    const s = agentStatus(factsOf({ ...base, now: Date.now(), spend }), viewer);
    return statusHtml(s, base.onCoin && s.action?.kind === "fund" ? "" : actionLink(s, base));
  };
  const have = answers.get(agent);
  if (have && !(have instanceof Promise) && Date.now() - have.at < 30_000) return html`<div data-agent-status="${agent}">${paint(have.spend)}</div>`;
  const kept = have && !(have instanceof Promise) ? have.spend : undefined;
  const p = have instanceof Promise ? have : f(`/api/agents/${agent}/spend`, { headers: { accept: "application/json" } }).then((r) => (r.ok ? (r.json() as Promise<SpendAnswer>) : null)).catch(() => null);
  if (!(have instanceof Promise)) answers.set(agent, p);
  void p.then((spend) => {
    answers.set(agent, { at: Date.now(), spend });
    const fill = () => {
      if (typeof document === "undefined") return;
      for (const el of document.querySelectorAll<HTMLElement>(`[data-agent-status="${agent}"][data-pending]`)) {
        el.removeAttribute("data-pending");
        el.innerHTML = paint(spend).s;
      }
    };
    fill();
    for (const ms of [50, 250, 1000, 3000]) setTimeout(fill, ms);
  });
  return html`<div data-agent-status="${agent}" data-pending="1">${kept !== undefined ? paint(kept) : ""}</div>`;
}
