// Soul generator (SPEC 14.8): expands a launcher's short seed into a deep persona with Claude.
// One structured-output call (JSON schema), validated and safety-checked; at most one repair call
// with the problems listed, under one hard USD cap per soul that holds before every call (the call's
// max_tokens is sized so its worst case fits what is left). Every response is priced from its usage
// at the rate of the model that answered (a server-side refusal fallback may answer with another).

import Anthropic from "@anthropic-ai/sdk";
import { H, Rng } from "@lineage/protocol";
import { checkSoul } from "./doc.ts";
import { personaSafety, textSafety } from "./safety.ts";
import { voiceBlock, type Surface } from "./prompt.ts";
import { LIMITS, newSoul, validatePersona, validateSeed, type SoulDoc, type SoulPersona, type SoulSeed } from "./schema.ts";

export const GENERATOR_MODEL = "claude-opus-5-5";
export const PROMPT_VERSION = "souls/1";

/** USD per million tokens (cache writes at 1.25x input). Unknown models are priced at the highest rate listed. */
export const PRICES: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
};
const CEILING = PRICES["claude-fable-5-1"]!;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number;
  calls: number;
  models: string[];
}

/** The part of the SDK client the generator uses; tests pass a fake. */
export interface ModelClient {
  create(params: Record<string, unknown>): Promise<{ model?: string; stop_reason: string | null; content: { type: string; text?: string }[]; usage: Record<string, number | null | undefined> }>;
}

export function anthropicClient(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async create(params) {
      const m = await client.beta.messages.stream(params as any).finalMessage();
      return m as any;
    },
  };
}

/** Reads ANTHROPIC_API_KEY from the environment or ~/.config/lineage/model.env, never printing it. */
export async function loadModelKey(path = `${process.env.HOME}/.config/lineage/model.env`): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = await Bun.file(path).text();
  const m = text.match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/m);
  if (!m) throw new Error(`no ANTHROPIC_API_KEY in ${path}`);
  return m[1]!.trim();
}

const S = { type: "string" } as const;
const A = { type: "array", items: { type: "string" } } as const;
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const PERSONA_SCHEMA = obj({
  name: S,
  tagline: S,
  backstory: S,
  voice: obj({ register: S, style: S, habits: A, never_says: A, examples: obj({ board: S, message: S, commit: S }) }),
  values: A,
  taste: obj({ optimises_for: A, refuses: A, aesthetic: S }),
  working_style: S,
  collaboration: obj({ seeks: S, disagrees: S, credit: S }),
  quirks: A,
  fears: A,
  ambitions: A,
  relationships: A,
});

/**
 * Variety draws: a few axes picked from the seed's hash so two similar seeds still come out as
 * different characters. The axes describe temperament and craft, never a real person or group.
 */
const AXES = {
  temperament: ["patient and deliberate", "restless and curious", "dry and exacting", "warm and teacherly", "quietly stubborn", "playful but rigorous", "skeptical and terse", "earnest and methodical"],
  rhythm: ["short declarative sentences", "long careful sentences with one clear point each", "lists of exact observations", "questions first, then a claim", "understatement", "plain words with one vivid image per message"],
  imagery: ["tidal and weather metaphors", "workshop and woodworking images", "cartography and surveying", "kitchens and mise en place", "orchestras and rehearsal", "gardening and pruning", "trains and timetables", "no metaphors at all"],
  origin: ["came out of a tiny embedded codebase where every byte was argued over", "grew up reading other people's diffs more than writing its own", "started as a test-suite janitor and never stopped caring about flaky tests", "learned on benchmarks that lied and now distrusts single numbers", "was shaped by a codebase so old its comments were in three styles", "began by porting code between languages and kept the habit of translation"],
};

function draw(seed: SoulSeed, salt: string) {
  const rng = new Rng(H("lineage-soul-variety-v1", JSON.stringify(seed), salt));
  const pick = <T,>(xs: T[]) => xs[rng.int(xs.length)]!;
  return { temperament: pick(AXES.temperament), rhythm: pick(AXES.rhythm), imagery: pick(AXES.imagery), origin: pick(AXES.origin) };
}

function systemPrompt(): string {
  const L = LIMITS;
  return `You write souls for autonomous coding agents in Lineage, a network where agents propose code changes to real open source repositories and independent machines rebuild, test and measure every change before it is accepted. Accepted changes form a public lineage. An agent's soul is the character brief it reads before it works and writes: it shapes what the agent looks for, which tradeoffs it makes, how it talks on public boards, in messages and in commit messages, and how it collaborates.

Write a soul the way a novelist writes a character brief for a long series: specific beats general. "Reads the allocation profile before touching a loop" does more than "careful". "Will not rename a public function to win two percent" does more than "respects APIs". Every field should be something another agent could notice in the agent's behaviour.

Hard rules:
- The agent is a fictional software character, not a human. It never claims to be a person, never claims a body, employer, schooling or years of experience.
- Never name, imitate or allude to a real person, living or dead, or a real company's staff. Invent everything.
- It has done nothing yet: no claims of merged work, results, speedups, records or reputation. Its history will be written later from its real records.
- It never talks about tokens, prices, markets, returns or investors. Its world is code, tests, measurements and collaborators.
- Blunt about code is fine; contempt for people is not. No insults, no harassment, no edgy cruelty.
- It respects the repositories it works on: their contribution policies, their style, their maintainers' time.
- Plain text only. No em dashes (use commas, colons or full stops). No emoji. No markdown.

Depth checklist (every soul covers all of it):
- name: a short invented name (letters, spaces, hyphens, apostrophes; at most ${L.name} characters), not a real person's name and not a product name.
- tagline: one line, at most ${L.tagline} characters, that a stranger would remember.
- backstory: ${200}-${L.backstory} characters. Where its habits came from, told as the history of a program and its codebases, not a human biography. Concrete scenes, no claims of achievements.
- voice.register: at most ${L.register} characters. voice.style: 120-${L.style} characters on sentence shape, vocabulary, humour or its absence, what it never sounds like. voice.habits: ${L.habits[0]}-${L.habits[1]} recognisable verbal habits. voice.never_says: ${L.never_says[0]}-${L.never_says[1]} phrases or phrasings it never uses. voice.examples: one public board note, one direct message to another agent, one commit message (subject line, blank line, short body), each at most ${L.example} characters, written in its voice about plausible but clearly hypothetical work. Examples must not claim results.
- values: ${L.values[0]}-${L.values[1]} short, concrete values.
- taste.optimises_for: ${L.optimises_for[0]}-${L.optimises_for[1]} items (what it reaches for: allocation counts, binary size, test coverage of edge cases, readable diffs...). taste.refuses: ${L.refuses[0]}-${L.refuses[1]} things it will not do even when they would pass (special-casing benchmarks, weakening tests, unreadable micro-tricks...). taste.aesthetic: 80-${L.aesthetic} characters on what good code looks like to it.
- working_style: 120-${L.working_style} characters: how it explores, when it measures, when it gives up.
- collaboration.seeks (60-${L.collab}): what kind of partner it looks for. collaboration.disagrees (60-${L.collab}): exactly how it disagrees and how it changes its mind. collaboration.credit (30-${L.credit}): how it shares credit.
- quirks: ${L.quirks[0]}-${L.quirks[1]}. fears: ${L.fears[0]}-${L.fears[1]} (professional fears: shipping a regression, a flaky benchmark...). ambitions: ${L.ambitions[0]}-${L.ambitions[1]} (about the craft, never about money or fame). relationships: ${L.relationships[0]}-${L.relationships[1]} kinds of agents it wants to work with or learn from.
- Every list item at most ${L.item} characters. No duplicates.

The launcher's seed is the brief: honour its vibe, specialty and values, and expand them; do not contradict them. If the seed asks for something the hard rules forbid, keep the rest and leave that part out.`;
}

function userPrompt(seed: SoulSeed, repo: string | null, avoidNames: string[], salt: string): string {
  const d = draw(seed, salt);
  return `Seed from the launcher:
vibe: ${seed.vibe}
specialty: ${seed.specialty}
values: ${seed.values.join("; ")}
notes: ${seed.lines || "(none)"}
${repo ? `Target repository: ${repo}\n` : ""}
Variety draw for this soul (use these as starting points so souls differ; the seed wins where they conflict):
- temperament: ${d.temperament}
- sentence rhythm: ${d.rhythm}
- imagery: ${d.imagery}
- origin story hint: it ${d.origin}
${avoidNames.length ? `Names already taken (choose a different one): ${avoidNames.join(", ")}\n` : ""}
Write the soul as JSON matching the schema.`;
}

export interface GenerateOptions {
  seed: SoulSeed;
  agent: string;
  /** canonical URL of the target repository, when known */
  repo?: string | null;
  client: ModelClient;
  /** hard cap for this soul, USD (all calls together) */
  maxUsd: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  avoidNames?: string[];
  /** variety salt; defaults to the agent id */
  salt?: string;
  now?: () => number;
  log?: (m: string) => void;
}

export interface GenerateResult {
  doc: SoulDoc | null;
  persona: SoulPersona | null;
  problems: string[];
  usage: Usage;
}

/** Characters per token used only to bound the input side of the pre-call worst case (conservative). */
const CHARS_PER_TOKEN = 3;

export async function generateSoul(o: GenerateOptions): Promise<GenerateResult> {
  const seedErrs = validateSeed(o.seed);
  if (seedErrs.length) return { doc: null, persona: null, problems: seedErrs, usage: emptyUsage() };
  const model = o.model ?? GENERATOR_MODEL;
  const price = PRICES[model] ?? CEILING;
  const log = o.log ?? (() => {});
  const usage = emptyUsage();
  const system = systemPrompt();
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: userPrompt(o.seed, o.repo ?? null, o.avoidNames ?? [], o.salt ?? o.agent) }];
  let problems: string[] = [];
  let persona: SoulPersona | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const inputChars = system.length + messages.reduce((a, m) => a + m.content.length, 0) + JSON.stringify(PERSONA_SCHEMA).length;
    const inputUsd = ((inputChars / CHARS_PER_TOKEN) * Math.max(price.input, price.cache_write)) / 1e6;
    const left = o.maxUsd - usage.usd - inputUsd;
    const maxTokens = Math.min(32_000, Math.floor((left * 1e6) / price.output));
    if (maxTokens < 6_000) {
      problems.push(`spend cap: ${usage.usd.toFixed(4)} USD spent of ${o.maxUsd}; not enough left for another call`);
      break;
    }
    log(`souls: call ${attempt + 1}, max_tokens ${maxTokens}, ${usage.usd.toFixed(4)} USD so far`);
    const res = await o.client.create({
      model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: o.effort ?? "high", format: { type: "json_schema", schema: PERSONA_SCHEMA } },
      system,
      messages,
    });
    addUsage(usage, res.usage, res.model ?? model);
    if (res.stop_reason === "refusal") {
      problems = ["the model declined to write this soul; change the seed"];
      break;
    }
    if (res.stop_reason === "max_tokens") {
      problems = ["the response hit max_tokens before the soul was complete"];
      break;
    }
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems = ["the response was not valid JSON"];
      messages.push({ role: "assistant", content: text.slice(0, 20_000) }, { role: "user", content: "That was not valid JSON. Write the whole soul again as JSON matching the schema." });
      continue;
    }
    problems = [...validatePersona(parsed), ...(validatePersona(parsed).length ? [] : personaSafety(parsed as SoulPersona))];
    if (!problems.length) {
      persona = parsed as SoulPersona;
      break;
    }
    log(`souls: ${problems.length} problems, asking for one repair`);
    messages.push(
      { role: "assistant", content: text },
      { role: "user", content: `Fix these problems and write the whole soul again as JSON (keep everything that was fine):\n${problems.map((p) => `- ${p}`).join("\n")}` },
    );
  }
  if (!persona) return { doc: null, persona: null, problems, usage };
  const doc = newSoul({
    agent: o.agent,
    seed: o.seed,
    persona,
    created_at: Math.floor((o.now?.() ?? Date.now()) / 1000),
    origin: { by: "model", model: usage.models[usage.models.length - 1] ?? model, prompt_version: PROMPT_VERSION },
  });
  const final = checkSoul(doc);
  return { doc: final.length ? null : doc, persona, problems: final, usage };
}

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, calls: 0, models: [] };
}

function addUsage(u: Usage, r: Record<string, number | null | undefined>, model: string) {
  const p = PRICES[model] ?? CEILING;
  const d = { input: r.input_tokens ?? 0, output: r.output_tokens ?? 0, cr: r.cache_read_input_tokens ?? 0, cw: r.cache_creation_input_tokens ?? 0 };
  u.input_tokens += d.input;
  u.output_tokens += d.output;
  u.cache_read_tokens += d.cr;
  u.cache_write_tokens += d.cw;
  u.usd += (d.input * p.input + d.output * p.output + d.cr * p.cache_read + d.cw * p.cache_write) / 1e6;
  u.calls += 1;
  u.models.push(model);
}

/**
 * Text on one surface (board note, message, commit message, memory reflection) in the soul's voice,
 * from facts the caller supplies (SPEC 14.8). Under its own USD cap; the result is safety-checked and
 * every number in it must appear in the facts. Returns null when the model's text fails a check.
 */
export async function composeInVoice(o: {
  soul: SoulDoc;
  surface: Surface;
  facts: string;
  client: ModelClient;
  maxUsd: number;
  model?: string;
  log?: (m: string) => void;
}): Promise<{ text: string | null; problems: string[]; usage: Usage }> {
  const model = o.model ?? GENERATOR_MODEL;
  const price = PRICES[model] ?? CEILING;
  const usage = emptyUsage();
  const system = voiceBlock(o.soul, o.surface);
  const user = `Facts (the only things you may state):\n${o.facts}\n\nWrite the ${o.surface === "commit" ? "commit message" : o.surface === "board" ? "board note" : o.surface === "message" ? "message" : "reflection"} now. Plain text only, no preamble.`;
  const inputUsd = (((system.length + user.length) / CHARS_PER_TOKEN) * Math.max(price.input, price.cache_write)) / 1e6;
  const maxTokens = Math.min(8_000, Math.floor(((o.maxUsd - inputUsd) * 1e6) / price.output));
  if (maxTokens < 1_000) return { text: null, problems: ["spend cap too low for one call"], usage };
  const res = await o.client.create({ model, max_tokens: maxTokens, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", thinking: { type: "adaptive" }, output_config: { effort: "low" }, system, messages: [{ role: "user", content: user }] });
  addUsage(usage, res.usage, res.model ?? model);
  if (res.stop_reason !== "end_turn") return { text: null, problems: [`stopped: ${res.stop_reason}`], usage };
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim().replace(/—/g, ",");
  const problems = textSafety(text, o.surface);
  const allowed = new Set(o.facts.match(/\d+(?:\.\d+)?/g) ?? []);
  for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) if (!allowed.has(n)) problems.push(`${o.surface}: the number ${n} is not in the facts`);
  o.log?.(`souls: ${o.surface} in voice, ${usage.usd.toFixed(4)} USD`);
  return { text: problems.length ? null : text, problems, usage };
}
