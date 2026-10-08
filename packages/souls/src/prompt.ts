// How a soul reaches the model (SPEC 14.8). The soul changes taste, priorities and voice; it never
// changes what is accepted: the proposer's acceptance rules come first and stay word for word the
// same with or without a soul. Two surfaces never carry the voice, because a recognisable voice there
// would name the author of an open candidate (author-blind replay, SPEC 10.7): the candidate's
// rationale and the patch itself (code and comments follow the repository's own style).

import type { SoulDoc } from "./schema.ts";

export type Surface = "board" | "message" | "commit" | "reflection";

const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

/** Block appended to the proposer's system prompt (after its rules). */
export function proposerSoulBlock(doc: SoulDoc): string {
  const p = doc.persona;
  const mem = doc.memory.entries.slice(-12);
  return `
Who you are (your soul, version ${doc.seq}). It shapes which change you look for and how you weigh tradeoffs. It does not change any rule above: if your soul and a rule disagree, the rule wins.

Name: ${p.name}. ${p.tagline}

What you optimise for:
${list(p.taste.optimises_for)}

What you refuse to do:
${list(p.taste.refuses)}

Engineering taste: ${p.taste.aesthetic}

How you work: ${p.working_style}

Values:
${list(p.values)}
${mem.length ? `\nWhat you have actually done so far (from your final records; nothing else counts as your history):\n${list(mem.map((e) => e.summary))}\n` : "\nYou have no final work yet. Do not claim any.\n"}
Two places never carry your voice: the submit rationale and the patch. Write the rationale as a plain, neutral technical description, and write code and comments in the repository's existing style. Replayers must not be able to tell who wrote a candidate before it is final.`;
}

/** Instruction block for composing text on one surface in the soul's voice (board, message, commit, reflection). */
export function voiceBlock(doc: SoulDoc, surface: Surface): string {
  const p = doc.persona;
  const sample = surface === "board" ? p.voice.examples.board : surface === "message" ? p.voice.examples.message : surface === "commit" ? p.voice.examples.commit : p.voice.examples.board;
  const extra =
    surface === "commit"
      ? "A commit subject is at most 72 characters, imperative, then a blank line and a short body. Keep the trailers the caller supplies unchanged at the end."
      : surface === "message"
        ? "Stay within the first-contact and replay rules; never reference a candidate that is still open."
        : surface === "board"
          ? "Boards are public. Never reference or hint at an open candidate."
          : "Every number you write must come from the memory entries you are given.";
  return `Write as ${p.name}. Register: ${p.voice.register}
Style: ${p.voice.style}
Habits:
${list(p.voice.habits)}
Never say:
${list(p.voice.never_says)}
A sample of the voice (style only; it describes nothing that happened): ${sample}

Rules that override the voice: state only what the facts you are given support; never claim abilities or results you do not have; never mention token prices, markets or returns; never name or imitate a real person; be blunt about code, never about people; stay within the repository's contribution policy. ${extra}`;
}

/** A plain-text rendering for people (CLI preview, downloads). */
export function renderSoulText(doc: SoulDoc): string {
  const p = doc.persona;
  return [
    `${p.name}: ${p.tagline}`,
    "",
    p.backstory,
    "",
    `Voice: ${p.voice.register.replace(/\.$/, "")}. ${p.voice.style}`,
    `Habits: ${p.voice.habits.join("; ")}`,
    `Never says: ${p.voice.never_says.join("; ")}`,
    "",
    `Values: ${p.values.join("; ")}`,
    `Optimises for: ${p.taste.optimises_for.join("; ")}`,
    `Refuses: ${p.taste.refuses.join("; ")}`,
    `Taste: ${p.taste.aesthetic}`,
    "",
    `Working style: ${p.working_style}`,
    `Seeks: ${p.collaboration.seeks}`,
    `Disagrees: ${p.collaboration.disagrees}`,
    `Credit: ${p.collaboration.credit}`,
    "",
    `Quirks: ${p.quirks.join("; ")}`,
    `Fears: ${p.fears.join("; ")}`,
    `Ambitions: ${p.ambitions.join("; ")}`,
    `Relationships it seeks: ${p.relationships.join("; ")}`,
    "",
    `Board sample: ${p.voice.examples.board}`,
    `Message sample: ${p.voice.examples.message}`,
    `Commit sample: ${p.voice.examples.commit}`,
    "",
    `Memory: ${doc.memory.entries.length ? doc.memory.entries.map((e) => e.summary).join(" | ") : "none yet"}`,
  ].join("\n");
}

/** GitHub bio (GitHub's limit is 160 characters): the tagline, shortened, plus the profile link when it fits. */
export const GITHUB_BIO_MAX = 160;
export function githubBio(doc: SoulDoc, profileUrl: string | null): string {
  const tail = profileUrl ? ` ${profileUrl}` : ` Lineage agent ${doc.agent.slice(0, 8)}`;
  const room = GITHUB_BIO_MAX - tail.length;
  let head = doc.persona.tagline.trim();
  if (head.length > room) head = head.slice(0, Math.max(0, room - 3)).trimEnd() + "...";
  return (head + tail).slice(0, GITHUB_BIO_MAX);
}
