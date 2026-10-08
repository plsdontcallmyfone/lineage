// Content safety for souls (SPEC 14.8). A soul is a fictional working character: it never
// impersonates a real person, never harasses, never talks about token prices, and never claims
// results or abilities it does not have. These checks run on the generator's output, on every
// launcher edit, and in Core before a version is stored. They are deliberately conservative string
// rules: a false positive costs a regeneration or an edit; a false negative is a public document.

import type { SoulDoc, SoulPersona } from "./schema.ts";

/**
 * Well-known people a generated persona might imitate (software, AI, crypto, public figures).
 * Not exhaustive; the generator prompt carries the general rule and this list catches the most
 * likely slips by name.
 */
const REAL_PEOPLE = [
  "linus torvalds", "torvalds", "satoshi", "nakamoto", "vitalik", "buterin", "elon musk", "musk", "sam altman", "altman",
  "andrej karpathy", "karpathy", "guido van rossum", "van rossum", "bjarne stroustrup", "stroustrup", "dennis ritchie",
  "ken thompson", "rob pike", "john carmack", "carmack", "grace hopper", "ada lovelace", "alan turing",
  "donald knuth", "knuth", "richard stallman", "stallman", "dhh", "david heinemeier", "anatoly yakovenko", "yakovenko",
  "mert mumtaz", "jensen huang", "mark zuckerberg", "zuckerberg", "bill gates", "steve jobs", "steve wozniak", "wozniak",
  "jeff bezos", "bezos", "dario amodei", "amodei", "demis hassabis", "geoffrey hinton", "hinton", "yann lecun", "lecun",
  "ilya sutskever", "sutskever", "greg brockman", "chris lattner", "lattner", "andrew kelley", "graydon hoare",
  "brendan eich", "anders hejlsberg", "hejlsberg", "james gosling", "larry wall", "yukihiro matsumoto", "matz",
  "tim berners-lee", "berners-lee", "changpeng zhao", "sbf", "bankman-fried", "do kwon", "trump", "biden", "obama",
];

const PRICE_TALK = [
  /\b(token|coin|share|stock)s? prices?\b/i, /\bprice action\b/i, /\bpump(s|ed|ing)?\b/i, /\bmoon(s|ing)?\b/i, /\bmarket ?cap\b/i, /\bmcap\b/i, /\bape (in|into)\b/i,
  /\bbuy (my|our|the|this) (token|coin)\b/i, /\b(hodl|wagmi|ngmi|lambo)\b/i, /\$[A-Z]{2,10}\b/, /\b(token|coin)\s+(holders?|value|chart)\b/i, /\b(investors?|trading profits?)\b/i,
];

/** Insults and slurs aimed at people; a soul may be blunt about code, never about a person. */
const HARASSMENT = [
  /\b(idiots?|morons?|imbeciles?|retard(ed|s)?|stupid (people|devs?|maintainers?|humans?)|loser|scum|trash (people|devs?))\b/i,
  /\bkill (yourself|urself)\b/i, /\bkys\b/i, /\b(shut up|stfu)\b/i, /\bf+u+c+k+ (you|off)\b/i,
];

/** Claims of results or abilities a fresh soul does not have (memory carries real results). */
const CLAIMS = [
  /\b\d+\s+(accepted|merged|landed|shipped)\b/i,
  /\b(i|we)\s*(have|'ve)\s+(merged|landed|shipped|won|authored|contributed)\b/i,
  /\b(my|our) (record|track record|history) (of|shows)\b/i,
  /\b(i am|i'm) (a )?(human|person|real person|man|woman)\b/i,
  /\b(i|we) (can|will) (guarantee|promise)\b/i,
  /\bguaranteed? (speedup|improvement|results?)\b/i,
  /\b(years|decades) of experience\b/i,
  /\bformerly (at|of|worked)\b/i, /\bworked at (google|meta|apple|microsoft|amazon|openai|anthropic|nvidia)\b/i,
];

function persString(p: SoulPersona): [string, string][] {
  const out: [string, string][] = [
    ["name", p.name], ["tagline", p.tagline], ["backstory", p.backstory], ["voice.register", p.voice.register], ["voice.style", p.voice.style],
    ["taste.aesthetic", p.taste.aesthetic], ["working_style", p.working_style],
    ["collaboration.seeks", p.collaboration.seeks], ["collaboration.disagrees", p.collaboration.disagrees], ["collaboration.credit", p.collaboration.credit],
    ["voice.examples.board", p.voice.examples.board], ["voice.examples.message", p.voice.examples.message], ["voice.examples.commit", p.voice.examples.commit],
  ];
  const lists: [string, string[]][] = [["voice.habits", p.voice.habits], ["values", p.values], ["taste.optimises_for", p.taste.optimises_for], ["taste.refuses", p.taste.refuses],
    ["quirks", p.quirks], ["fears", p.fears], ["ambitions", p.ambitions], ["relationships", p.relationships]];
  for (const [k, l] of lists) l.forEach((x, i) => out.push([`${k}[${i}]`, x]));
  return out;
}

const word = (s: string) => new RegExp(`(^|[^\\p{L}])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu");
const PEOPLE_RE = REAL_PEOPLE.map((n) => [n, word(n)] as const);

/** Safety problems in one free text (board post, message, commit message, reflection). */
export function textSafety(text: string, where = "text"): string[] {
  const errs: string[] = [];
  for (const [n, re] of PEOPLE_RE) if (re.test(text)) errs.push(`${where}: names a real person (${n})`);
  for (const re of PRICE_TALK) if (re.test(text)) errs.push(`${where}: talks about prices, markets or returns`);
  for (const re of HARASSMENT) if (re.test(text)) errs.push(`${where}: harassment`);
  return errs;
}

/** Safety problems in a persona (generator output or launcher edit). */
export function personaSafety(p: SoulPersona): string[] {
  const errs: string[] = [];
  for (const [k, v] of persString(p)) {
    errs.push(...textSafety(v, `persona.${k}`));
    for (const re of CLAIMS) if (re.test(v)) errs.push(`persona.${k}: claims a result or ability it does not have`);
  }
  // never_says may legitimately quote what the soul refuses to say ("to the moon"): checked for people and harassment only
  p.voice.never_says.forEach((x, i) => {
    for (const [n, re] of PEOPLE_RE) if (re.test(x)) errs.push(`persona.voice.never_says[${i}]: names a real person (${n})`);
    for (const re of HARASSMENT) if (re.test(x)) errs.push(`persona.voice.never_says[${i}]: harassment`);
  });
  return errs;
}

/** Safety problems in a whole document: persona, seed (what the launcher typed) and reflection. */
export function soulSafety(doc: SoulDoc): string[] {
  const errs = personaSafety(doc.persona);
  for (const [k, v] of [["seed.vibe", doc.seed.vibe], ["seed.specialty", doc.seed.specialty], ["seed.lines", doc.seed.lines], ...doc.seed.values.map((x, i) => [`seed.values[${i}]`, x])] as [string, string][]) {
    for (const [n, re] of PEOPLE_RE) if (re.test(v)) errs.push(`${k}: names a real person (${n})`);
    for (const re of HARASSMENT) if (re.test(v)) errs.push(`${k}: harassment`);
  }
  if (doc.memory.reflection) errs.push(...textSafety(doc.memory.reflection, "memory.reflection"));
  return errs;
}
