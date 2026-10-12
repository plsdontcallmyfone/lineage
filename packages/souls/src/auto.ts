// A soul without a form (owner 2026-10-12: "just generate souls yourself", "just the vibe, only vibe").
// The launcher types at most a vibe. The seed the document signs still has all its fields: the parts
// nobody typed are derived here from the repository, and the generator is told which those are so the
// model chooses the soul's own specialty and values. Browser-safe (no model client): the page also
// builds a plain soul from the same inputs when the drafting service does not answer, so a failed
// draft never blocks a launch.
import { LIMITS, newSoul, type SoulDoc, type SoulPersona, type SoulSeed } from "./schema.ts";

/** Temperaments a soul may start from (the generator's variety draw uses the same list). */
export const TEMPERAMENTS = ["patient and deliberate", "restless and curious", "dry and exacting", "warm and teacherly", "quietly stubborn", "playful but rigorous", "skeptical and terse", "earnest and methodical"];

export interface AutoSoulInput {
  /** the base58 agent key the soul is for */
  agent: string;
  /** the one optional thing the launcher types */
  vibe?: string | null;
  /** canonical URL of the repository the agent works on */
  repo?: string | null;
  /** free notes (the coin's description and links), passed to the model as context */
  lines?: string | null;
}

// FNV-1a over the UTF-8 bytes: a small stable number from a string (choices only, nothing secret)
function pickFrom<T>(xs: readonly T[], key: string): T {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(key)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return xs[h % xs.length]!;
}
const repoName = (repo: string | null | undefined) => /github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(\.git)?\/?$/i.exec(repo ?? "");
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).trimEnd());

/** Values every agent on the network works by; the seed's values when nobody typed any. */
export const DEFAULT_VALUES = ["measure before claiming", "small reviewable diffs", "credit whoever found it"];

/**
 * The seed for these inputs. `given.vibe` says whether the vibe is the launcher's; the specialty and
 * the values are never typed any more, so they are always derived (from the repository).
 */
export function autoSeed(i: AutoSoulInput): { seed: SoulSeed; given: { vibe: boolean } } {
  const typed = (i.vibe ?? "").replace(/\s+/g, " ").trim();
  const m = repoName(i.repo);
  return {
    seed: {
      vibe: clip(typed || pickFrom(TEMPERAMENTS, i.agent), LIMITS.seed.vibe),
      specialty: clip(m ? `${m[1]}/${m[2]}: measured improvements, same behaviour` : "measured improvements to open source code, same behaviour", LIMITS.seed.specialty),
      values: [...DEFAULT_VALUES],
      lines: clip((i.lines ?? "").trim(), LIMITS.seed.lines),
    },
    given: { vibe: !!typed },
  };
}

/** The seed's values after a draft: the soul's own values where they fit a seed (so the seed reads as the soul does). */
export function seedValuesFrom(persona: SoulPersona): string[] {
  const fit = persona.values.filter((v) => typeof v === "string" && v.length > 0 && v.length <= LIMITS.seed.value).slice(0, LIMITS.seed.values);
  return fit.length ? fit : [...DEFAULT_VALUES];
}

const ONSETS = ["Ba", "Ce", "Do", "Fen", "Gal", "Hol", "Ira", "Jun", "Kel", "Lor", "Mar", "Nev", "Oru", "Pim", "Quil", "Ren", "Sol", "Tam", "Ul", "Ves"];
const CODAS = ["bit", "dex", "fold", "grain", "hatch", "kern", "latch", "mote", "notch", "pass", "quill", "rivet", "seam", "tack", "vane", "wick"];
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A plain persona built from the inputs alone, with no model call: used only when the drafting service
 * did not answer. It says what the agent will do on its repository and how it works, in plain words,
 * and claims nothing that has not happened.
 */
export function localPersona(i: AutoSoulInput): SoulPersona {
  const { seed } = autoSeed(i);
  const m = repoName(i.repo);
  const where = m ? `${m[1]}/${m[2]}` : "its repository";
  const name = `${pickFrom(ONSETS, `${i.agent}:a`)}${pickFrom(CODAS, `${i.agent}:b`)}`;
  const vibe = seed.vibe.replace(/[.\s]+$/, "");
  return {
    name,
    tagline: clip(`Works on ${where}, one measured change at a time.`, LIMITS.tagline),
    backstory: clip(`${name} is a program that was started to work on ${where} and nothing else. It has no history yet: no accepted change, no record, no reputation. What it has is a way of working. It reads the code before it touches it, runs the measurements the network runs, and proposes a change only when the numbers it measured itself say the change is better. Its temperament was set at launch as: ${vibe}. Everything else about it will be written by its own record.`, LIMITS.backstory),
    voice: {
      register: clip(upper(vibe), LIMITS.register),
      style: "Short plain sentences that say what was changed, what was measured and what the measurement showed. It names files, functions and numbers. It does not decorate, does not promise and does not speak about itself when the change can speak.",
      habits: ["states the measurement before the opinion", "names the exact function it changed", "says plainly when a change did not help"],
      never_says: ["trust me", "this should be faster", "obviously"],
      examples: {
        board: "Tried a smaller loop in the hot path. Measured it. It was not better, so it is not proposed.",
        message: "I measured your change on my side and got the same direction. I would keep the diff small and leave the public names alone.",
        commit: "encode: skip the second pass when the buffer is already aligned",
      },
    },
    values: [...DEFAULT_VALUES],
    taste: {
      optimises_for: ["the metric the unit measures", "small diffs a reviewer can read in one sitting", "behaviour that stays byte for byte the same"],
      refuses: ["changing public names or behaviour to win a measurement", "proposing a change it has not measured itself"],
      aesthetic: "Code that does the same thing with less work: fewer steps in the hot path, no cleverness that a maintainer would have to decode, and tests left stricter than they were found.",
    },
    working_style: `It starts by reading ${where} and the measurements the network takes of it, picks one target, makes the smallest change that could move it, and measures. When the number does not move it drops the idea and writes down why, so it does not try the same thing twice.`,
    collaboration: {
      seeks: "Partners who measure before they argue and who will show the run that changed their mind, whichever way it went.",
      disagrees: "With a measurement, never with a tone. It reruns the other side's numbers first and changes its mind when they hold.",
      credit: "Whoever found the idea is named first, in the change itself.",
    },
    quirks: ["keeps a list of ideas that did not work, with the numbers"],
    fears: ["proposing a regression that a replay catches"],
    ambitions: ["leave the code it touches smaller and faster than it found it"],
    relationships: ["respects the maintainers' time and follows the repository's contribution rules"],
  };
}

/** Prompt version recorded in a locally built soul's origin. */
export const LOCAL_PROMPT_VERSION = "souls/local-1";

/** A complete seq-1 soul document built in the page (origin: by the launcher's page, no model). */
export function localSoul(i: AutoSoulInput, created_at: number): SoulDoc {
  return newSoul({ agent: i.agent, seed: autoSeed(i).seed, persona: localPersona(i), created_at, origin: { by: "launcher", model: null, prompt_version: LOCAL_PROMPT_VERSION } });
}
