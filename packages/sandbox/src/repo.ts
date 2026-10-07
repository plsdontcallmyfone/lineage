import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalUrl, sha256Hex } from "@lineage/protocol";

// Snapshot trees: a bare mirror per repo, then a fresh tree per evaluation (snapshot commit +
// overlay + parent patch series + candidate patch).

export const LINEAGE_HOME = process.env.LINEAGE_HOME ?? join(homedir(), ".lineage");
const REPO_ROOT = resolve(import.meta.dir, "../../..");

function git(cwd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

function must(r: { ok: boolean; out: string; err: string }, what: string): string {
  if (!r.ok) throw new Error(`${what}: ${r.err.trim()}`);
  return r.out;
}

const FIXED = {
  GIT_AUTHOR_NAME: "lineage-fixture",
  GIT_AUTHOR_EMAIL: "fixture@lineage.invalid",
  GIT_COMMITTER_NAME: "lineage-fixture",
  GIT_COMMITTER_EMAIL: "fixture@lineage.invalid",
  GIT_AUTHOR_DATE: "2026-10-07T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-07T00:00:00Z",
};

/**
 * `fixture:<name>` repos are built from fixtures/<name> with fixed author and dates, so the
 * commit sha is the same on every machine.
 */
function ensureFixture(name: string): string {
  const src = join(REPO_ROOT, "fixtures", name);
  if (!existsSync(src)) throw new Error(`unknown fixture ${name}`);
  const bare = join(LINEAGE_HOME, "fixtures", `${name}.git`);
  if (existsSync(bare)) return bare;
  const work = mkdtempSync(join(LINEAGE_HOME, "tmp-fixture-"));
  try {
    cpSync(src, work, { recursive: true });
    must(git(work, ["init", "-q", "-b", "main"]), "fixture init");
    must(git(work, ["add", "-A"]), "fixture add");
    must(git(work, ["commit", "-q", "-m", `fixture ${name}`], FIXED), "fixture commit");
    mkdirSync(dirname(bare), { recursive: true });
    must(git(LINEAGE_HOME, ["clone", "-q", "--bare", work, bare]), "fixture bare clone");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return bare;
}

export function mirrorPath(url: string): string {
  if (url.startsWith("fixture:")) return ensureFixture(url.slice("fixture:".length));
  const dir = join(LINEAGE_HOME, "mirrors", sha256Hex(canonicalUrl(url)).slice(0, 24) + ".git");
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    must(git(LINEAGE_HOME, ["clone", "-q", "--mirror", url, dir]), `mirror ${url}`);
  }
  return dir;
}

export function ensureCommit(url: string, commit: string): string {
  const mirror = mirrorPath(url);
  if (!git(mirror, ["cat-file", "-e", `${commit}^{commit}`]).ok) {
    must(git(mirror, ["fetch", "-q", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]), "fetch");
    must(git(mirror, ["cat-file", "-e", `${commit}^{commit}`]), `commit ${commit} not found in ${url}`);
  }
  return mirror;
}

export function headCommit(url: string, ref = "HEAD"): string {
  const mirror = mirrorPath(url);
  return must(git(mirror, ["rev-parse", ref]), "rev-parse").trim();
}

export function commitTime(url: string, commit: string): number {
  return Number(must(git(ensureCommit(url, commit), ["show", "-s", "--format=%ct", commit]), "commit time").trim());
}

export function newWorkDir(prefix: string): string {
  const base = join(LINEAGE_HOME, "work");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

/** Container user 10001 must be able to write the tree. */
export function openPermissions(dir: string): void {
  Bun.spawnSync(["chmod", "-R", "a+rwX", dir]);
}

/** Checks out the snapshot into `dest` (which must not exist) and copies the overlay on top. */
export function materialize(url: string, commit: string, overlayDir: string | null, dest: string): void {
  const mirror = ensureCommit(url, commit);
  mkdirSync(dest, { recursive: true });
  // git archive gives a clean tree without .git
  const archive = Bun.spawnSync(["git", "archive", "--format=tar", commit], { cwd: mirror });
  if (archive.exitCode !== 0) throw new Error(`archive: ${archive.stderr.toString()}`);
  const untar = Bun.spawnSync(["tar", "-x", "-C", dest], { stdin: archive.stdout });
  if (untar.exitCode !== 0) throw new Error(`untar: ${untar.stderr.toString()}`);
  if (overlayDir) cpSync(overlayDir, dest, { recursive: true });
  // a throwaway repo so patches apply with git's exact semantics
  must(git(dest, ["init", "-q"]), "tree init");
  must(git(dest, ["add", "-A"]), "tree add");
  must(git(dest, ["commit", "-q", "--no-gpg-sign", "-m", "snapshot"], FIXED), "tree commit");
}

/** Applies a canonical diff exactly (no fuzz). Returns false on conflict, leaving the tree unchanged. */
export function applyPatch(tree: string, diff: string): boolean {
  const file = join(tree, ".git", "lineage.patch");
  writeFileSync(file, diff);
  if (!git(tree, ["apply", "--check", "--whitespace=nowarn", file]).ok) return false;
  must(git(tree, ["apply", "--whitespace=nowarn", file]), "apply");
  must(git(tree, ["add", "-A"]), "add");
  must(git(tree, ["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "patch"], FIXED), "commit");
  return true;
}

/** Canonical `git diff` of the working tree against HEAD (what an author submits). */
export function diffWorkingTree(tree: string): string {
  must(git(tree, ["add", "-A"]), "add");
  return must(git(tree, ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames", "-U3", "--full-index"]), "diff");
}

export function cloneTree(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
}

export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

export { chmodSync };
