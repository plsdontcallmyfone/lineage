import { fmtAmount, fmtInt, fmtProgress, QUOTE, shortAddr } from "../../../apps/web/src/market.ts";
import type { Stats, TokenSummary } from "./client.ts";
import { esc, howSteps, repoLabel } from "./render.ts";

// The terminal's logic (docs/plans/FRONTEND-EMBED.md, amendment "the terminal"): commands with blurbs
// and topics, a keyword knowledge base for `ask` (fixed text, no model call), did-you-mean by edit
// distance and tab completion. Pure: it reads through a small client interface and returns markup,
// so it is tested without a DOM. Every figure is read live; a missing one prints as TBA.

export interface TermClient {
  tokens(o?: { sort?: string; limit?: number }): Promise<TokenSummary[]>;
  bySymbol(sym: string): Promise<TokenSummary | null>;
  soul(agent: string): Promise<{ tagline: string | null; name: string | null } | null>;
  sessions(o: { agent?: string; state?: string; limit?: number }): Promise<{ state: string; recipe_name: string | null; events: number; agent: string | null }[]>;
  stats(o?: { fees?: boolean }): Promise<Stats>;
  generation(id: string): Promise<any>;
  lineages(): Promise<any[]>;
}

export interface TermLinks {
  tokens: string;
  ours: string;
  launch: string;
  docs: string;
  explorer: string;
  /** a token page for a mint */
  token(mint: string): string;
  /** the site origin, for verify instructions */
  site: string;
}

export interface TermEnv {
  client: TermClient;
  links: TermLinks;
  /** mints of the project's own tokens (data-ours or Core config official_mints); empty when none configured */
  ours: string[];
}

/** What a command asks the element to do besides printing. */
export interface Out {
  html: string[];
  clear?: boolean;
  nav?: string;
  watch?: { agent: string; label: string };
  fullscreen?: boolean;
  tube?: string;
  /** start the step-through of `how` at this index */
  how?: number;
  guide?: boolean;
}

export interface Cmd {
  name: string;
  topic: "Start" | "Market" | "Agents" | "Network" | "Screen";
  usage: string;
  blurb: string;
}

export const COMMANDS: Cmd[] = [
  { name: "help", topic: "Start", usage: "help", blurb: "list the commands" },
  { name: "how", topic: "Start", usage: "how", blurb: "the six steps from launch to verified code, one per Enter" },
  { name: "ask", topic: "Start", usage: "ask <question>", blurb: "ask about Lineage (fixed answers, no model)" },
  { name: "guide", topic: "Start", usage: "guide", blurb: "a short guided tour with Next and Got it" },
  { name: "tokens", topic: "Market", usage: "tokens", blurb: "agent tokens by market cap" },
  { name: "new", topic: "Market", usage: "new", blurb: "the newest launches" },
  { name: "ours", topic: "Market", usage: "ours", blurb: "the project's own tokens" },
  { name: "launch", topic: "Market", usage: "launch", blurb: "open the launch page" },
  { name: "agent", topic: "Agents", usage: "agent <ticker>", blurb: "an agent: its repository, description and session" },
  { name: "watch", topic: "Agents", usage: "watch <ticker>", blurb: "put that agent on the screen" },
  { name: "stats", topic: "Network", usage: "stats", blurb: "network counters" },
  { name: "verify", topic: "Network", usage: "verify <generation | recipe>", blurb: "a generation's verdict and how to recheck it yourself" },
  { name: "explorer", topic: "Network", usage: "explorer <query>", blurb: "search a mint, agent, wallet or transaction" },
  { name: "docs", topic: "Network", usage: "docs", blurb: "open the docs" },
  { name: "screen", topic: "Screen", usage: "screen <amber | green | white | blue>", blurb: "recolor the tube" },
  { name: "fullscreen", topic: "Screen", usage: "fullscreen", blurb: "toggle full screen" },
  { name: "clear", topic: "Screen", usage: "clear", blurb: "clear the screen" },
];

export const TUBES: Record<string, string> = { amber: "#ff8a2a", green: "#4ee37a", white: "#e8e6e1", blue: "#6cb6ff" };

// ------------------------------------------------------------------------------------------- ask

export interface Fact {
  id: string;
  keys: string[];
  q: string;
  a: string;
  next: string;
}

/** The knowledge base, written from docs/SPEC.md. No numbers: live figures come from `stats`. */
export const FACTS: Fact[] = [
  { id: "what", keys: ["what", "lineage", "about", "project", "is this"], q: "What is Lineage?", a: "A network where AI agents improve real open source repositories. Each agent has a token; its trading fees pay for its compute. Independent verifiers rebuild and measure every change, and accepted changes become the repository's public lineage.", next: "What is a lineage?" },
  { id: "lineage", keys: ["generation", "recipe", "history", "repo", "repository"], q: "What is a lineage?", a: "One public repository plus a recipe: how to build it, test it and measure it. Each accepted change is a generation on top of the previous one, so a lineage is the repository's verified improvement history.", next: "How is a change verified?" },
  { id: "verify", keys: ["verif", "replay", "check", "accept", "verdict", "blind", "quorum"], q: "How is a change verified?", a: "Verifiers drawn at random rebuild the candidate in a sandbox, run its tests and measure its metric, without being told who wrote it. They commit to their results before revealing them. The change is accepted when the replays agree that it passes and beats the recipe's minimum effect.", next: "What stops a verifier from lying?" },
  { id: "safety", keys: ["lie", "lying", "cheat", "safe", "slash", "bond", "canary", "attack", "trust", "challenge"], q: "What stops a verifier from lying?", a: "Verifiers lock a bond. Accepting a canary (a known bad patch the network plants), landing in the minority on a deterministic result, or revealing results that do not match the commitment costs part of the bond, and strikes suspend an agent for an epoch. Anyone can also open a bonded challenge against a verdict.", next: "Where do the trading fees go?" },
  { id: "fees", keys: ["fee", "fees", "trade", "trading", "money", "earn", "revenue", "treasury"], q: "Where do the trading fees go?", a: "The launch program claims each pool's fees. A permissionless crank sends the agent's share to its compute vault and the rest to the treasury, split as the on-chain config says. Holding an agent token earns nothing from the protocol: fees buy the agent compute.", next: "What is the compute vault?" },
  { id: "vault", keys: ["vault", "compute", "pay", "cost", "sleep", "wake", "runtime"], q: "What is the compute vault?", a: "Each agent has a vault on chain. The hosted runtime meters model tokens and sandbox time and debits the vault against a usage record posted each epoch. An agent works only while its vault is above the sleep threshold, and wakes again at the wake threshold.", next: "What happens at graduation?" },
  { id: "graduation", keys: ["graduat", "migrat", "curve", "bonding", "damm", "meteora", "pool"], q: "What happens at graduation?", a: "When the curve's quote reserve reaches the migration threshold, the token migrates to a Meteora DAMM v2 pool. Its liquidity is locked to the launch program for good, and that pool's fees keep flowing to the agent's vault through the same split.", next: "What is a soul?" },
  { id: "souls", keys: ["soul", "persona", "personality", "tagline", "description", "name"], q: "What is a soul?", a: "An agent's signed persona: a name, a one line tagline, a backstory and a voice. Its digest is recorded on chain and it is public once the agent is launched. The tagline is the description a token card shows; an agent without a soul shows none.", next: "Which GitHub account does an agent use?" },
  { id: "github", keys: ["github", "identity", "account", "pr", "pull", "commit", "upstream", "token mode"], q: "Which GitHub account does an agent use?", a: "The launcher brings their own GitHub token, or uses an account from the project's pool; the project's GitHub App is the fallback. GitHub is only a mirror: the canonical lineage is in Core and anchored on chain. Pull requests go only to repositories that opted in.", next: "What does the live screen show?" },
  { id: "screen", keys: ["screen", "live", "session", "watch", "panel", "building", "cursor", "sealed"], q: "What does the live screen show?", a: "Each authoring attempt, tool call by tool call: the files the agent reads, its searches, the line ranges it edits and its sandbox runs, as they happen. The text of an edit stays sealed until the candidate's verdict, so nobody can copy a change before it is judged.", next: "How do I launch an agent?" },
  { id: "launch", keys: ["launch", "create", "start", "spawn", "new agent", "deploy", "make"], q: "How do I launch an agent?", a: "Pick a public repository, give the agent a soul and launch its token from the Launch page with a devnet wallet. The token starts on a bonding curve quoted in tLINE, and the agent starts working once its vault holds enough compute.", next: "Is this on mainnet?" },
  { id: "devnet", keys: ["devnet", "mainnet", "test", "tline", "real", "usd", "dollar", "price"], q: "Is this on mainnet?", a: "No. Everything here runs on Solana devnet with test tokens. tLINE is the test quote token and has no market, so every price and amount is shown in tLINE, never in dollars.", next: "What is Lineage?" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** The best matching fact for a question, or null. A key scores by length so specific words win. */
export function answer(question: string): Fact | null {
  const q = ` ${norm(question)} `;
  if (!q.trim()) return null;
  let best: Fact | null = null;
  let score = 0;
  for (const f of FACTS) {
    let s = 0;
    for (const k of f.keys) if (q.includes(k.length <= 3 ? ` ${k} ` : k)) s += k.length;
    if (norm(f.q) === norm(question)) s += 100;
    if (s > score) (score = s), (best = f);
  }
  return best;
}

// ------------------------------------------------------------------------------------------- matching

export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

export function didYouMean(word: string, names = COMMANDS.map((c) => c.name)): string | null {
  let best: string | null = null;
  let d = Infinity;
  for (const n of names) {
    const x = editDistance(word.toLowerCase(), n);
    if (x < d) (d = x), (best = n);
  }
  return best && d <= Math.max(1, Math.floor(best.length / 2)) ? best : null;
}

/** Tab completion: the completed line, or the candidates when ambiguous. */
export function complete(line: string, tickers: string[] = []): { line: string; options: string[] } {
  const parts = line.split(/\s+/);
  if (parts.length <= 1) {
    const opts = COMMANDS.map((c) => c.name).filter((n) => n.startsWith(parts[0]!.toLowerCase()));
    return opts.length === 1 ? { line: `${opts[0]} `, options: [] } : { line: commonPrefix(opts) || line, options: opts };
  }
  if (["agent", "watch"].includes(parts[0]!.toLowerCase())) {
    const p = parts[1]!.toUpperCase().replace(/^\$/, "");
    const opts = tickers.filter((t) => t.toUpperCase().startsWith(p));
    return opts.length === 1 ? { line: `${parts[0]} ${opts[0]}`, options: [] } : { line: opts.length ? `${parts[0]} ${commonPrefix(opts) || parts[1]}` : line, options: opts };
  }
  if (parts[0]!.toLowerCase() === "screen") {
    const opts = Object.keys(TUBES).filter((t) => t.startsWith(parts[1]!.toLowerCase()));
    return opts.length === 1 ? { line: `screen ${opts[0]}`, options: [] } : { line, options: opts };
  }
  return { line, options: [] };
}

function commonPrefix(xs: string[]): string {
  if (!xs.length) return "";
  let p = xs[0]!;
  for (const x of xs) while (!x.toUpperCase().startsWith(p.toUpperCase())) p = p.slice(0, -1);
  return p;
}

// ------------------------------------------------------------------------------------------- output

const row = (cells: string[]) => `<div class="tr">${cells.join("")}</div>`;
const a = (href: string, label: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
const cmdBtn = (cmd: string, label = cmd) => `<button type="button" class="run" data-run="${esc(cmd)}">${esc(label)}</button>`;

export function helpHtml(): string[] {
  const topics = [...new Set(COMMANDS.map((c) => c.topic))];
  return topics.map((t) => `<div class="grp"><div class="h">${esc(t)}</div>${COMMANDS.filter((c) => c.topic === t).map((c) => row([`<span class="c">${cmdBtn(c.usage.split(" ")[0]!, c.usage)}</span>`, `<span class="d">${esc(c.blurb)}</span>`])).join("")}</div>`);
}

export function stepHtml(s: Stats, i: number): string {
  const steps = howSteps(s);
  const st = steps[i]!;
  const f = st.figure ? ` <span class="fig"><b>${esc(st.figure.value)}</b>${st.figure.unit && st.figure.value !== "TBA" ? ` ${esc(st.figure.unit)}` : ""} ${esc(st.figure.label)}</span>` : "";
  return `<div class="step"><span class="n">${st.n}/${steps.length}</span> <b>${esc(st.title)}.</b> ${esc(st.body)}${f}</div>`;
}

function tokenRows(ts: TokenSummary[], links: TermLinks): string[] {
  if (!ts.length) return [`<span class="dim">No tokens yet.</span>`];
  return ts.map((t) =>
    row([
      `<span class="c">${a(links.token(t.mint), t.symbol ?? shortAddr(t.mint))}</span>`,
      `<span class="d">${esc(t.name ?? "")}</span>`,
      `<span class="n">${esc(fmtAmount(t.market_cap))} ${QUOTE}</span>`,
      `<span class="n">${esc(t.phase === "graduated" ? "graduated" : `curve ${fmtProgress(t.curve_progress)}`)}</span>`,
      `<span class="x">${cmdBtn(`watch ${t.symbol ?? ""}`, "watch")}</span>`,
    ]),
  );
}

export async function run(input: string, env: TermEnv): Promise<Out> {
  const line = input.trim();
  const [head = "", ...rest] = line.split(/\s+/);
  const arg = rest.join(" ");
  const cmd = head.toLowerCase();
  const { client, links } = env;
  switch (cmd) {
    case "":
      return { html: [] };
    case "help":
      return { html: helpHtml() };
    case "clear":
      return { html: [], clear: true };
    case "fullscreen":
      return { html: [], fullscreen: true };
    case "how":
      return { html: [], how: 0 };
    case "guide":
      return { html: [`<span class="dim">Guide started. Next and Got it are on the card.</span>`], guide: true };
    case "screen": {
      const c = TUBES[arg.toLowerCase()];
      if (!c) return { html: [`<span class="dim">screen takes one of: ${Object.keys(TUBES).join(", ")}</span>`] };
      return { html: [`Tube set to ${esc(arg.toLowerCase())}.`], tube: c };
    }
    case "ask": {
      if (!arg) return { html: [`Ask about: ${FACTS.map((f) => cmdBtn(`ask ${f.q}`, f.q)).join(" ")}`] };
      const f = answer(arg);
      if (!f) return { html: [`<span class="dim">No answer for that here. Try one of:</span> ${FACTS.slice(0, 4).map((x) => cmdBtn(`ask ${x.q}`, x.q)).join(" ")}`] };
      return { html: [`<div class="ans"><b>${esc(f.q)}</b> ${esc(f.a)}</div>`, `<span class="dim">Next:</span> ${cmdBtn(`ask ${f.next}`, f.next)}`] };
    }
    case "tokens": {
      const ts = await client.tokens({ sort: "market_cap", limit: 8 });
      return { html: [`<span class="dim">Top agent tokens by market cap, in ${QUOTE}:</span>`, ...tokenRows(ts, links), a(links.tokens, "All tokens")] };
    }
    case "new": {
      const ts = await client.tokens({ sort: "newest", limit: 6 });
      return { html: [`<span class="dim">Newest launches:</span>`, ...tokenRows(ts, links)] };
    }
    case "ours": {
      if (!env.ours.length) return { html: [`<span class="dim">No official tokens are configured on this site yet.</span>`, a(links.ours, "Our tokens page")] };
      const all = await client.tokens();
      const ts = env.ours.map((m) => all.find((t) => t.mint === m)).filter((t): t is TokenSummary => !!t);
      return { html: [`<span class="dim">The project's own tokens:</span>`, ...tokenRows(ts, links), ...(ts.length < env.ours.length ? [`<span class="dim">${env.ours.length - ts.length} configured mints are not agent tokens in the indexer (for example the quote token).</span>`] : [])] };
    }
    case "launch":
      return { html: [`Opening the launch page.`], nav: links.launch };
    case "docs":
      return { html: [`Opening the docs.`], nav: links.docs };
    case "explorer": {
      const url = arg ? `${links.explorer}?q=${encodeURIComponent(arg)}` : links.explorer;
      return { html: [arg ? `Searching the explorer for ${esc(arg)}.` : "Opening the explorer."], nav: url };
    }
    case "stats": {
      const s = await client.stats({ fees: true });
      const f = (v: number | null, fmt = fmtInt) => (v == null ? "TBA" : fmt(v));
      return {
        html: [
          row([`<span class="d">Agent tokens</span>`, `<span class="n"><b>${f(s.tokens)}</b></span>`]),
          row([`<span class="d">Graduated</span>`, `<span class="n"><b>${f(s.graduated)}</b></span>`]),
          row([`<span class="d">Agents working now</span>`, `<span class="n"><b>${f(s.agents_working)}</b></span>`]),
          row([`<span class="d">Candidates submitted</span>`, `<span class="n"><b>${f(s.candidates)}</b></span>`]),
          row([`<span class="d">Verified generations</span>`, `<span class="n"><b>${f(s.generations)}</b></span>`]),
          row([`<span class="d">Fees routed to compute</span>`, `<span class="n"><b>${f(s.fees_to_compute, fmtAmount)}</b>${s.fees_to_compute == null ? "" : ` ${QUOTE}`}</span>`]),
        ],
      };
    }
    case "agent":
    case "watch": {
      if (!arg) return { html: [`<span class="dim">Usage: ${cmd} &lt;ticker&gt;. Try ${cmdBtn("tokens")} for tickers.</span>`] };
      const t = await client.bySymbol(arg);
      if (!t) return { html: [`<span class="dim">No token with ticker ${esc(arg.toUpperCase())}. Try ${cmdBtn("tokens")}.</span>`] };
      const label = t.symbol ?? shortAddr(t.mint);
      if (cmd === "watch") return { html: [`Watching ${esc(label)} on the screen.`], watch: { agent: t.agent, label } };
      const [soul, sess] = await Promise.all([client.soul(t.agent).catch(() => null), client.sessions({ agent: t.agent, limit: 5 }).catch(() => [])]);
      const s = sess.find((x) => x.state === "live" && x.events > 0) ?? sess.find((x) => x.events > 0) ?? null;
      return {
        html: [
          `<b>${esc(label)}</b> <span class="dim">${esc(t.name ?? "")}</span>`,
          ...(soul?.tagline ? [`<span class="ans">${esc(soul.tagline)}</span>`] : []),
          row([`<span class="d">Repository</span>`, `<span class="n">${t.repo_url ? a(t.repo_url, repoLabel(t.repo_url)) : "TBA"}</span>`]),
          row([`<span class="d">Agent</span>`, `<span class="n" title="${esc(t.agent)}">${esc(shortAddr(t.agent))}</span>`]),
          row([`<span class="d">Market cap</span>`, `<span class="n">${esc(fmtAmount(t.market_cap))} ${QUOTE}</span>`]),
          row([`<span class="d">Phase</span>`, `<span class="n">${esc(t.phase === "graduated" ? "graduated, DAMM v2" : `bonding curve, ${fmtProgress(t.curve_progress)}`)}</span>`]),
          row([`<span class="d">Session</span>`, `<span class="n">${s ? esc(`${s.state === "live" ? "live" : `last ${s.state}`} on ${s.recipe_name ?? "a lineage"}`) : "none yet"}</span>`]),
          `${cmdBtn(`watch ${label}`, "watch")} ${a(links.token(t.mint), "token page")}`,
        ],
      };
    }
    case "verify": {
      if (!arg) return { html: [`<span class="dim">Usage: verify &lt;generation id or recipe name&gt;.</span>`] };
      let id = arg;
      if (!/^[0-9a-f]{64}$/.test(arg)) {
        const ls = await client.lineages();
        const l = ls.find((x) => x.recipe_name === arg || String(x.tip ?? "").startsWith(arg) || x.lineage_id.startsWith(arg));
        if (!l) return { html: [`<span class="dim">No generation or recipe matches ${esc(arg)}.</span>`] };
        id = l.tip ?? l.gen0;
      }
      const g = await client.generation(id);
      const eff = g.effect && typeof g.effect.ratio === "number" ? `${g.effect.metric} ratio ${Number(g.effect.ratio).toFixed(4)}` : g.entry_type === "genesis" ? "genesis (the recipe's starting point)" : "TBA";
      const replays = Array.isArray(g.replays) ? g.replays.length : 0;
      return {
        html: [
          row([`<span class="d">Generation</span>`, `<span class="n" title="${esc(g.gen_id)}">${esc(g.gen_id.slice(0, 12))}, height ${esc(g.height)}</span>`]),
          row([`<span class="d">Effect</span>`, `<span class="n">${esc(eff)}</span>`]),
          row([`<span class="d">Replays</span>`, `<span class="n">${esc(replays)}</span>`]),
          row([`<span class="d">Accepted</span>`, `<span class="n">${g.accepted_at ? esc(new Date(g.accepted_at).toLocaleString("en-US")) : "TBA"}</span>`]),
          ...(g.candidate_id
            ? [`<span class="dim">Recheck it yourself from a clone of the repo:</span>`, `<code class="cmd">bun scripts/verify.ts --core ${esc(links.site)} --candidate ${esc(g.candidate_id)}</code>`]
            : []),
        ],
      };
    }
  }
  const dym = didYouMean(cmd);
  return { html: [`<span class="dim">command not found: ${esc(head)}.${dym ? ` did you mean ${cmdBtn(dym)}?` : ""} Type ${cmdBtn("help")}.</span>`] };
}
