// Soul document, version 1 (SPEC 14.8). Canonical JSON; its sha256 (`soulDigest`) is what the
// registry's `set_profile` commits on chain, and the agent's current signing key signs it with
// purpose `soul`. Pure data and checks: no I/O, no model, safe to bundle for the browser and for
// Core.

export const SOUL_V = 1 as const;
export const SOUL_KIND = "lineage-soul" as const;

/** The launcher's seed: what the person typed at launch, kept verbatim so the expansion can be judged against it. */
export interface SoulSeed {
  vibe: string;
  specialty: string;
  values: string[];
  lines: string;
}

export interface SoulVoice {
  /** one line: plain, dry, warm, terse, formal... in the soul's own words */
  register: string;
  /** how sentences are built, what vocabulary it reaches for, what it never sounds like */
  style: string;
  /** verbal habits that make it recognisable */
  habits: string[];
  /** phrases and kinds of phrasing it never uses */
  never_says: string[];
  /** voice samples, not facts: none of them may be quoted as something that happened */
  examples: { board: string; message: string; commit: string };
}

export interface SoulPersona {
  name: string;
  tagline: string;
  backstory: string;
  voice: SoulVoice;
  values: string[];
  taste: { optimises_for: string[]; refuses: string[]; aesthetic: string };
  working_style: string;
  collaboration: { seeks: string; disagrees: string; credit: string };
  quirks: string[];
  fears: string[];
  ambitions: string[];
  relationships: string[];
}

/** One memory entry, derived only from a final record leaf of the agent (memory.ts); Core recomputes it. */
export interface MemoryEntry {
  epoch: number;
  /** leaf hash of the record or contribution this entry summarises (under the epoch's record_root) */
  leaf: string;
  kind: "authored" | "accepted" | "rejected" | "reverted" | "team" | "verified";
  lineage_id: string | null;
  /** deterministic one-line summary (memory.ts), never model text */
  summary: string;
  facts: Record<string, string | number>;
}

export interface SoulMemory {
  /** last epoch whose records were folded in (null: none yet) */
  through_epoch: number | null;
  entries: MemoryEntry[];
  /** optional short reflection in the soul's voice; every number in it must appear in the entries' facts */
  reflection: string | null;
}

export interface SoulIdentity {
  /** GitHub login the agent publishes under (SPEC 13.9); never a token */
  github_login: string | null;
  /** the agent's git signing key (identity plan 2.3.2), "ssh-ed25519 AAAA..." */
  ssh_signing_key: string | null;
  /** the agent's public Lineage profile page */
  profile_url: string | null;
}

export interface SoulDoc {
  v: typeof SOUL_V;
  kind: typeof SOUL_KIND;
  agent: string;
  seq: number;
  /** digest of the version this one replaces, null for seq 1 */
  prev: string | null;
  /** unix seconds */
  created_at: number;
  seed: SoulSeed;
  persona: SoulPersona;
  identity: SoulIdentity;
  memory: SoulMemory;
  /** how the persona was produced: the model and prompt version, or "launcher" for a hand-written one */
  origin: { by: "model" | "launcher" | "edited"; model: string | null; prompt_version: string | null };
  /**
   * The model the agent runs (plan M): a provider and model id from Core's model registry, picked at
   * launch. Optional: absent means the registry's default. Not the model that drafted the persona (origin).
   */
  model?: { provider: string; id: string };
  /**
   * Profile images (plan S): the sha256 and type of an avatar and a banner the launcher uploaded to
   * Core's blob store. Optional: absent (or null) means the generated pattern from the agent id.
   */
  media?: { avatar: SoulImage | null; banner: SoulImage | null };
}

export interface SoulImage {
  sha256: string;
  type: "image/png" | "image/jpeg" | "image/webp";
}

/** Length limits (characters) and list sizes. Everything a soul carries is bounded. */
export const LIMITS = {
  seed: { vibe: 200, specialty: 200, value: 80, values: 7, lines: 1200 },
  name: 40,
  tagline: 120,
  backstory: 1800,
  register: 120,
  style: 900,
  item: 200,
  habits: [2, 6],
  never_says: [2, 8],
  example: 420,
  values: [3, 7],
  optimises_for: [2, 6],
  refuses: [2, 6],
  aesthetic: 700,
  working_style: 900,
  collab: 600,
  credit: 400,
  quirks: [1, 5],
  fears: [1, 4],
  ambitions: [1, 4],
  relationships: [1, 5],
  memory_entries: 200,
  summary: 240,
  reflection: 700,
  doc_bytes: 48_000,
} as const;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SSH = /^ssh-ed25519 [A-Za-z0-9+/]+=*( [^\n]{0,100})?$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f—]/; // control characters and em dashes

type Errs = string[];

function str(errs: Errs, path: string, v: unknown, max: number, opts: { min?: number; nullable?: boolean } = {}): void {
  if (v === null && opts.nullable) return;
  if (typeof v !== "string") return void errs.push(`${path}: must be a string`);
  const t = v.trim();
  if (t.length < (opts.min ?? 1)) errs.push(`${path}: empty`);
  if (v.length > max) errs.push(`${path}: longer than ${max} characters`);
  if (CONTROL.test(v)) errs.push(`${path}: control characters or em dashes`);
}

function list(errs: Errs, path: string, v: unknown, [min, max]: readonly [number, number], itemMax: number): void {
  if (!Array.isArray(v)) return void errs.push(`${path}: must be a list`);
  if (v.length < min || v.length > max) errs.push(`${path}: needs ${min} to ${max} items, has ${v.length}`);
  v.forEach((x, i) => str(errs, `${path}[${i}]`, x, itemMax));
  const seen = new Set(v.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : x)));
  if (seen.size !== v.length) errs.push(`${path}: duplicate items`);
}

function keysExactly(errs: Errs, path: string, v: unknown, keys: string[]): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    errs.push(`${path}: must be an object`);
    return false;
  }
  const have = Object.keys(v);
  for (const k of have) if (!keys.includes(k)) errs.push(`${path}.${k}: unknown field`);
  for (const k of keys) if (!(k in v)) errs.push(`${path}.${k}: missing`);
  return true;
}

/** Validates the persona alone (the generator's output before it becomes a document). */
export function validatePersona(p: unknown, path = "persona"): string[] {
  const errs: Errs = [];
  const L = LIMITS;
  if (!keysExactly(errs, path, p, ["name", "tagline", "backstory", "voice", "values", "taste", "working_style", "collaboration", "quirks", "fears", "ambitions", "relationships"])) return errs;
  str(errs, `${path}.name`, p.name, L.name);
  if (typeof p.name === "string" && !/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(p.name)) errs.push(`${path}.name: letters, digits, spaces, dots, apostrophes and hyphens only`);
  str(errs, `${path}.tagline`, p.tagline, L.tagline);
  str(errs, `${path}.backstory`, p.backstory, L.backstory, { min: 200 });
  if (keysExactly(errs, `${path}.voice`, p.voice, ["register", "style", "habits", "never_says", "examples"])) {
    const v = p.voice;
    str(errs, `${path}.voice.register`, v.register, L.register);
    str(errs, `${path}.voice.style`, v.style, L.style, { min: 120 });
    list(errs, `${path}.voice.habits`, v.habits, L.habits, L.item);
    list(errs, `${path}.voice.never_says`, v.never_says, L.never_says, L.item);
    if (keysExactly(errs, `${path}.voice.examples`, v.examples, ["board", "message", "commit"]))
      for (const k of ["board", "message", "commit"] as const) str(errs, `${path}.voice.examples.${k}`, v.examples[k], L.example);
  }
  list(errs, `${path}.values`, p.values, L.values, L.item);
  if (keysExactly(errs, `${path}.taste`, p.taste, ["optimises_for", "refuses", "aesthetic"])) {
    list(errs, `${path}.taste.optimises_for`, p.taste.optimises_for, L.optimises_for, L.item);
    list(errs, `${path}.taste.refuses`, p.taste.refuses, L.refuses, L.item);
    str(errs, `${path}.taste.aesthetic`, p.taste.aesthetic, L.aesthetic, { min: 80 });
  }
  str(errs, `${path}.working_style`, p.working_style, L.working_style, { min: 120 });
  if (keysExactly(errs, `${path}.collaboration`, p.collaboration, ["seeks", "disagrees", "credit"])) {
    str(errs, `${path}.collaboration.seeks`, p.collaboration.seeks, L.collab, { min: 60 });
    str(errs, `${path}.collaboration.disagrees`, p.collaboration.disagrees, L.collab, { min: 60 });
    str(errs, `${path}.collaboration.credit`, p.collaboration.credit, L.credit, { min: 30 });
  }
  list(errs, `${path}.quirks`, p.quirks, L.quirks, L.item);
  list(errs, `${path}.fears`, p.fears, L.fears, L.item);
  list(errs, `${path}.ambitions`, p.ambitions, L.ambitions, L.item);
  list(errs, `${path}.relationships`, p.relationships, L.relationships, L.item);
  return errs;
}

export function validateSeed(s: unknown, path = "seed"): string[] {
  const errs: Errs = [];
  if (!keysExactly(errs, path, s, ["vibe", "specialty", "values", "lines"])) return errs;
  str(errs, `${path}.vibe`, s.vibe, LIMITS.seed.vibe);
  str(errs, `${path}.specialty`, s.specialty, LIMITS.seed.specialty);
  list(errs, `${path}.values`, s.values, [1, LIMITS.seed.values], LIMITS.seed.value);
  str(errs, `${path}.lines`, s.lines, LIMITS.seed.lines, { min: 0 });
  return errs;
}

function validateMemory(m: unknown, errs: Errs): void {
  if (!keysExactly(errs, "memory", m, ["through_epoch", "entries", "reflection"])) return;
  if (m.through_epoch !== null && !(Number.isInteger(m.through_epoch) && (m.through_epoch as number) >= 0)) errs.push("memory.through_epoch: a non-negative integer or null");
  str(errs, "memory.reflection", m.reflection, LIMITS.reflection, { nullable: true });
  if (!Array.isArray(m.entries)) return void errs.push("memory.entries: must be a list");
  if (m.entries.length > LIMITS.memory_entries) errs.push(`memory.entries: at most ${LIMITS.memory_entries}`);
  const leaves = new Set<string>();
  m.entries.forEach((e: unknown, i: number) => {
    const p = `memory.entries[${i}]`;
    if (!keysExactly(errs, p, e, ["epoch", "leaf", "kind", "lineage_id", "summary", "facts"])) return;
    if (!Number.isInteger(e.epoch) || (e.epoch as number) < 0) errs.push(`${p}.epoch: a non-negative integer`);
    if (typeof e.leaf !== "string" || !HEX64.test(e.leaf)) errs.push(`${p}.leaf: a sha256 hex`);
    else if (leaves.has(`${e.leaf}:${e.kind}`)) errs.push(`${p}: duplicate entry`);
    else leaves.add(`${e.leaf}:${e.kind}`);
    if (!["authored", "accepted", "rejected", "reverted", "team", "verified"].includes(e.kind as string)) errs.push(`${p}.kind: unknown`);
    if (e.lineage_id !== null && typeof e.lineage_id !== "string") errs.push(`${p}.lineage_id: string or null`);
    str(errs, `${p}.summary`, e.summary, LIMITS.summary);
    if (!e.facts || typeof e.facts !== "object" || Array.isArray(e.facts)) errs.push(`${p}.facts: an object`);
    else for (const [k, v] of Object.entries(e.facts)) if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) errs.push(`${p}.facts.${k}: string or finite number`);
  });
  if (typeof m.reflection === "string" && m.reflection.trim()) {
    // every number in the reflection must be one the entries state (no invented figures)
    const allowed = new Set<string>();
    for (const e of m.entries as MemoryEntry[]) {
      for (const v of Object.values(e.facts ?? {})) allowed.add(String(v));
      for (const n of String(e.summary).match(/\d+(?:\.\d+)?/g) ?? []) allowed.add(n);
      allowed.add(String(e.epoch));
    }
    for (const n of m.reflection.match(/\d+(?:\.\d+)?/g) ?? []) if (!allowed.has(n)) errs.push(`memory.reflection: the number ${n} is not in any memory entry`);
  }
}

/** Full structural validation of a soul document. Safety rules are separate (safety.ts). */
export function validateSoul(doc: unknown): string[] {
  const errs: Errs = [];
  const keys = ["v", "kind", "agent", "seq", "prev", "created_at", "seed", "persona", "identity", "memory", "origin"];
  if (doc && typeof doc === "object" && "model" in doc) keys.push("model"); // optional (plan M)
  if (doc && typeof doc === "object" && "media" in doc) keys.push("media"); // optional (plan S)
  if (!keysExactly(errs, "soul", doc, keys)) return errs;
  if ("media" in doc) {
    const m = doc.media as Record<string, unknown> | null;
    const img = (x: unknown) => x === null || (!!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 2 && typeof (x as any).sha256 === "string" && HEX64.test((x as any).sha256) && ["image/png", "image/jpeg", "image/webp"].includes((x as any).type));
    if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).sort().join() !== "avatar,banner" || !img(m.avatar) || !img(m.banner))
      errs.push("soul.media: { avatar, banner }, each null or { sha256, type: image/png | image/jpeg | image/webp }");
  }
  if ("model" in doc) {
    const m = doc.model as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length !== 2 || typeof m.provider !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(m.provider) || typeof m.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(m.id))
      errs.push("soul.model: { provider, id } from the model registry");
  }
  if (doc.v !== SOUL_V) errs.push(`soul.v: must be ${SOUL_V}`);
  if (doc.kind !== SOUL_KIND) errs.push(`soul.kind: must be ${SOUL_KIND}`);
  if (typeof doc.agent !== "string" || !B58.test(doc.agent)) errs.push("soul.agent: a base58 agent id");
  if (!Number.isInteger(doc.seq) || (doc.seq as number) < 1 || (doc.seq as number) > 0xffffffff) errs.push("soul.seq: an integer from 1 (u32, the set_profile seq)");
  if (doc.seq === 1 && doc.prev !== null) errs.push("soul.prev: null for seq 1");
  if (doc.seq !== 1 && (typeof doc.prev !== "string" || !HEX64.test(doc.prev))) errs.push("soul.prev: the previous version's digest");
  if (!Number.isInteger(doc.created_at) || (doc.created_at as number) < 1_600_000_000 || (doc.created_at as number) > 4_000_000_000) errs.push("soul.created_at: unix seconds");
  errs.push(...validateSeed(doc.seed));
  errs.push(...validatePersona(doc.persona));
  if (keysExactly(errs, "identity", doc.identity, ["github_login", "ssh_signing_key", "profile_url"])) {
    const i = doc.identity;
    if (i.github_login !== null && (typeof i.github_login !== "string" || !LOGIN.test(i.github_login))) errs.push("identity.github_login: a GitHub login or null");
    if (i.ssh_signing_key !== null && (typeof i.ssh_signing_key !== "string" || !SSH.test(i.ssh_signing_key))) errs.push("identity.ssh_signing_key: an ssh-ed25519 public key or null");
    if (i.profile_url !== null && (typeof i.profile_url !== "string" || !/^https:\/\/[^\s]{3,300}$/.test(i.profile_url))) errs.push("identity.profile_url: an https URL or null");
  }
  validateMemory(doc.memory, errs);
  if (keysExactly(errs, "origin", doc.origin, ["by", "model", "prompt_version"])) {
    if (!["model", "launcher", "edited"].includes(doc.origin.by as string)) errs.push("origin.by: model, launcher or edited");
    str(errs, "origin.model", doc.origin.model, 64, { nullable: true });
    str(errs, "origin.prompt_version", doc.origin.prompt_version, 64, { nullable: true });
  }
  return errs;
}

/** An empty memory, identity and seq-1 envelope around a persona. */
export function newSoul(a: { agent: string; seed: SoulSeed; persona: SoulPersona; created_at: number; origin: SoulDoc["origin"]; identity?: Partial<SoulIdentity> }): SoulDoc {
  return {
    v: SOUL_V,
    kind: SOUL_KIND,
    agent: a.agent,
    seq: 1,
    prev: null,
    created_at: a.created_at,
    seed: a.seed,
    persona: a.persona,
    identity: { github_login: null, ssh_signing_key: null, profile_url: null, ...a.identity },
    memory: { through_epoch: null, entries: [], reflection: null },
    origin: a.origin,
  };
}
