// Shared by scripts/public/export-verifier.ts and scripts/public/export-recipes.ts: the two public
// repositories that are snapshots of parts of this one (the verifier kit and the recipes).
//
// Both exports read a NAMED COMMIT through git (never the working tree, which other sessions edit),
// build the whole expected tree in memory, and then either write it into a checkout of the public
// repository or, with --check, compare it and write nothing. A SOURCE.json at the root of the
// exported directory names the commit and the sha256 of every exported file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

export const MONOREPO_URL = "https://github.com/plsdontcallmyfone/lineage";

/** A file tree in memory: path (posix, relative) to bytes. */
export type Tree = Map<string, Buffer>;

/** Reads files of one commit of a git repository. */
export class CommitReader {
  readonly commit: string;
  private readonly list: Set<string>;
  private readonly cache = new Map<string, Buffer>();

  constructor(readonly root: string, rev = "HEAD") {
    this.commit = this.git("rev-parse", `${rev}^{commit}`).toString().trim();
    this.list = new Set(this.git("ls-tree", "-r", "--name-only", "-z", this.commit).toString().split("\0").filter(Boolean));
  }

  private git(...a: string[]): Buffer {
    return execFileSync("git", ["-C", this.root, ...a], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 });
  }

  has(path: string): boolean {
    return this.list.has(path);
  }

  /** Every file under a directory (or the file itself), sorted. */
  under(dir: string): string[] {
    const p = dir.replace(/\/+$/, "") + "/";
    return [...this.list].filter((f) => f === dir || f.startsWith(p)).sort();
  }

  /** Names directly inside a directory. */
  children(dir: string): string[] {
    const p = dir.replace(/\/+$/, "") + "/";
    const out = new Set<string>();
    for (const f of this.list) if (f.startsWith(p)) out.add(f.slice(p.length).split("/")[0]!);
    return [...out].sort();
  }

  read(path: string): Buffer {
    let b = this.cache.get(path);
    if (!b) {
      if (!this.list.has(path)) throw new Error(`${path} is not in commit ${this.commit.slice(0, 12)}`);
      b = this.git("show", `${this.commit}:${path}`);
      this.cache.set(path, b);
    }
    return b;
  }

  text(path: string): string {
    return this.read(path).toString("utf8");
  }
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const EM_DASH = "—";

/**
 * The exported text of a source file. The public repositories carry no em dash character, and a few
 * source files hold one inside a regular expression or a string that rejects it; it is written as its
 * escape, which means the same to the engine. Binary files and files without one are returned as they are.
 */
export function exportedBytes(b: Buffer): Buffer {
  if (b.includes(0) || !b.includes(EM_DASH)) return b;
  return Buffer.from(b.toString("utf8").split(EM_DASH).join("\\u2014"), "utf8");
}

// ------------------------------------------------------------------------------------------ audit

/** What must never reach a public repository. Each rule names what it found; values are not printed. */
const SECRET_RULES: [name: string, re: RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Solana keypair (64 byte array)", /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI style key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ["keyed RPC URL", /https?:\/\/[^\s"'`]*(?:api[-_]?key=|\/v2\/[A-Za-z0-9_-]{20,}|helius[^\s"'`]*\?[^\s"'`]*=)[^\s"'`]*/i],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack or Telegram token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/],
  ["home directory path", /\/Users\/[a-z][a-z0-9_-]*\/|\/home\/(?!bun\b|runner\b|lineage\b|units\b|sandbox\b|user\b)[a-z][a-z0-9_-]*\//],
  ["personal email", /[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|yahoo|proton|protonmail|icloud|live)\.[a-z.]{2,}/i],
];

export interface Finding {
  path: string;
  rule: string;
  line: number;
}

/** Secrets, personal data and em dashes in a tree. An empty list means the tree is clean. */
export function auditTree(tree: Tree): Finding[] {
  const out: Finding[] = [];
  for (const [path, bytes] of tree) {
    if (bytes.includes(0)) continue; // binary: not text we can read; exports carry almost none
    const text = bytes.toString("utf8");
    const lineOf = (i: number) => text.slice(0, i).split("\n").length;
    for (const [rule, re] of SECRET_RULES) {
      const m = re.exec(text);
      if (m) out.push({ path, rule, line: lineOf(m.index) });
    }
    const d = text.indexOf(EM_DASH);
    if (d >= 0) out.push({ path, rule: "em dash", line: lineOf(d) });
  }
  return out;
}

// ----------------------------------------------------------------------------------- write, check

export interface SourceManifest {
  _generated: string;
  source_repository: string;
  source_commit: string;
  files: Record<string, string>;
  [k: string]: unknown;
}

/** SOURCE.json for a tree: what wrote it, from which commit, and the sha256 of every file. */
export function manifestFor(tree: Tree, o: { script: string; commit: string; extra?: Record<string, unknown> }): SourceManifest {
  return {
    _generated: `Written by ${o.script} of the units monorepo (${MONOREPO_URL}). Do not edit this directory by hand: change the source there and run the export again.`,
    source_repository: MONOREPO_URL,
    source_commit: o.commit,
    ...(o.extra ?? {}),
    files: Object.fromEntries([...tree.keys()].sort().map((p) => [p, sha256(tree.get(p)!)])),
  };
}

/** Files on disk under a directory (posix relative paths), leaving out the names in `ignore` at any depth. */
export function diskFiles(dir: string, ignore: string[] = []): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (ignore.includes(e.name)) continue;
      const r = rel ? posix.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (existsSync(dir)) walk("");
  return out.sort();
}

export interface SyncResult {
  /** files whose bytes differ or that are missing in the checkout */
  changed: string[];
  /** files in the checkout's exported directory that the export does not produce */
  extra: string[];
}

/**
 * Writes a tree into `dir` (or with check: compares it). SOURCE.json keeps its commit while every
 * exported file is unchanged, so it names the last commit that changed the snapshot. Files named in
 * `keep` (at any depth) belong to the public repository itself and are neither written nor removed.
 */
export function syncTree(dir: string, tree: Tree, o: { check?: boolean; script: string; commit: string; keep?: string[]; extra?: Record<string, unknown> }): SyncResult {
  const keep = [...(o.keep ?? []), "SOURCE.json"];
  const changed: string[] = [];
  for (const [p, bytes] of tree) {
    const abs = join(dir, p);
    // a link where a file should be is replaced, never written through
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink() || !readFileSync(abs).equals(bytes)) changed.push(p);
  }
  const extra = diskFiles(dir, keep).filter((p) => !tree.has(p));
  const manifest = manifestFor(tree, o);
  const manifestPath = join(dir, "SOURCE.json");
  let manifestStale = !existsSync(manifestPath);
  if (!manifestStale) {
    try {
      const stored = JSON.parse(readFileSync(manifestPath, "utf8")) as SourceManifest;
      const { source_commit: _a, ...mine } = manifest;
      const { source_commit: _b, ...theirs } = stored;
      manifestStale = JSON.stringify(mine) !== JSON.stringify(theirs);
    } catch {
      manifestStale = true;
    }
  }
  if (manifestStale) changed.push("SOURCE.json");
  if (!o.check && (changed.length || extra.length)) {
    for (const p of extra) rmSync(join(dir, p));
    for (const [p, bytes] of tree) {
      const abs = join(dir, p);
      mkdirSync(dirname(abs), { recursive: true });
      if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) rmSync(abs);
      writeFileSync(abs, bytes);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  return { changed: changed.sort(), extra };
}

/** Refuses a target that already has a git remote or is inside the monorepo: these exports are local until the owner says otherwise. */
export function assertLocalCheckout(target: string, monorepo: string): void {
  const inside = (a: string, b: string) => (a + "/").startsWith(b.replace(/\/+$/, "") + "/");
  if (inside(target, monorepo)) throw new Error(`${target} is inside the monorepo; the public repositories live outside it`);
}

/** Common command line: [--check] [--commit <rev>] [<checkout>]. */
export function parseArgs(argv: string[], fallback: string): { check: boolean; rev: string; target: string } {
  const check = argv.includes("--check");
  const ci = argv.indexOf("--commit");
  const rev = ci >= 0 ? (argv[ci + 1] ?? "HEAD") : "HEAD";
  const target = argv.find((a, i) => !a.startsWith("--") && !(ci >= 0 && i === ci + 1)) ?? fallback;
  return { check, rev, target };
}

/** Prints the result of an export run and returns the exit code. */
export function report(name: string, target: string, sub: string, r: SyncResult, findings: Finding[], check: boolean, commit: string): number {
  for (const f of findings) console.error(`AUDIT ${f.path}:${f.line}: ${f.rule}`);
  if (findings.length) {
    console.error(`${findings.length} audit finding(s): nothing was written`);
    return 1;
  }
  const n = r.changed.length + r.extra.length;
  if (!n) console.log(`${name}: ${join(target, sub)} is up to date with ${commit.slice(0, 12)}`);
  else {
    console.log(`${name}: ${check ? "would change" : "wrote"} ${r.changed.length} file(s)${r.extra.length ? `, ${check ? "would remove" : "removed"} ${r.extra.length}` : ""} in ${join(target, sub)} from ${commit.slice(0, 12)}`);
    for (const p of r.changed.slice(0, 40)) console.log(`  ${p}`);
    if (r.changed.length > 40) console.log(`  ... and ${r.changed.length - 40} more`);
    for (const p of r.extra.slice(0, 40)) console.log(`  (not exported) ${p}`);
  }
  return check && n ? 1 : 0;
}
