import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASS_LABEL, REPO_URL, readTree, type TreeReading } from "../../runtime/src/repo-reading.ts";
import type { Core } from "./core.ts";
import { bad } from "./errors.ts";
import { canonicalUrl, repoId } from "./protocol.ts";
import { recipeProposalsOf } from "./recipe-proposals.ts";

// The repository check before a launch (owner 2026-10-13, "clear comms"): GET /v1/repo-check?repo=<url>
// answers "can an agent work on this repository?" before the launcher pays, with the same free reading
// the hosted runtime makes after a launch (packages/runtime/src/repo-reading.ts readTree; the rules
// live there and nowhere else):
//   ready       an active unit already exists on the repository (answered from Core's own records,
//               nothing is fetched);
//   can_set_up  no unit yet; the reading found a language with a toolchain image and tests of its own
//               (how many files, in which folders), and a verifier of that class exists here;
//   cannot      the reading's plain reason (no tests, with the files that call a GPU; no toolchain for
//               its language), or no unit of its class exists here so no verifier could calibrate one;
//   checking    the reading runs now; ask again in a few seconds;
//   unknown     the repository could not be read here (too large, not reachable, too many readings at
//               once). Never a "cannot": the launch is not held on a check that did not run.
// Cost and bounds. A reading is one `git ls-remote` for the head commit (15 s) and one download of the
// source archive at that commit, at most 64 MB packed and 400 MB unpacked in 45 s, unpacked into a
// temporary folder that is removed after the reading. No git history, no mirror kept. Readings are
// stored per repository and head commit (table repo_checks) and never run twice for the same head; a
// repository's head is asked for at most once a minute; two readings run at a time, sixteen may wait,
// and at most 120 new readings start per hour. A repository too large to read is remembered as such.
// The public route is rate limited at the gate in its own class (scripts/deploy/gate.ts).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repo_checks (
  repo TEXT NOT NULL,
  head TEXT NOT NULL,
  reading TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (repo, head)
);`;

export const REPO_CHECK_BOUNDS = {
  head_ms: 15_000,
  tree_ms: 45_000,
  packed_bytes: 64 * 1024 * 1024,
  unpacked_bytes: 400 * 1024 * 1024,
  running: 2,
  queued: 16,
  per_hour: 120,
  head_ttl_ms: 60_000,
  fail_ttl_ms: 60_000,
  /** how long one request waits for a reading before it answers `checking` */
  wait_ms: 8_000,
  /** recorded setups needed before a usual setup time is stated */
  min_setups: 3,
};

/** The repository is over the size bounds: remembered per head, never fetched again. */
export class TooLarge extends Error {}

export interface RepoWork {
  /** the head commit of the default branch; throws when the repository cannot be read now */
  head(repo: string): Promise<string>;
  /** unpacks the tree at `commit` into `dir` (an empty folder); throws TooLarge over the bounds */
  tree(repo: string, commit: string, dir: string): Promise<void>;
}

/** Where a host serves the source archive of one commit. */
export function archiveUrl(repo: string, commit: string): string {
  const m = REPO_URL.exec(repo);
  if (!m) throw new Error("not a repository address");
  const [, host, owner, name] = m;
  if (host === "github.com") return `https://codeload.github.com/${owner}/${name}/tar.gz/${commit}`;
  if (host === "gitlab.com") return `https://gitlab.com/${owner}/${name}/-/archive/${commit}/${name}-${commit}.tar.gz`;
  return `https://codeberg.org/${owner}/${name}/archive/${commit}.tar.gz`;
}

/**
 * Downloads a .tar.gz and unpacks it into `dir` without its top folder, counting the packed and the
 * unpacked bytes as they pass: over either bound, or past the deadline, the download is dropped.
 */
export async function unpackArchive(url: string, dir: string, b: { tree_ms: number; packed_bytes: number; unpacked_bytes: number } = REPO_CHECK_BOUNDS): Promise<void> {
  const ac = new AbortController();
  let late = false;
  const timer = setTimeout(() => ((late = true), ac.abort()), b.tree_ms);
  const tar = Bun.spawn(["tar", "-x", "-f", "-", "-C", dir, "--strip-components", "1", "--no-same-owner"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  let big = false;
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "units-repo-check" } });
    if (!res.ok || !res.body) throw new Error(`the source archive answered HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > b.packed_bytes) throw new TooLarge("packed");
    let packed = 0;
    let unpacked = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          packed += chunk.byteLength;
          if (packed > b.packed_bytes) {
            big = true;
            ac.abort();
            return ctl.error(new TooLarge("packed"));
          }
          ctl.enqueue(chunk);
        },
      }),
    );
    const reader = counted.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      unpacked += value.byteLength;
      if (unpacked > b.unpacked_bytes) {
        big = true;
        ac.abort();
        throw new TooLarge("unpacked");
      }
      tar.stdin.write(value);
      await tar.stdin.flush();
    }
    await tar.stdin.end();
    if ((await tar.exited) !== 0) throw new Error("the source archive could not be unpacked");
  } catch (e) {
    tar.kill();
    if (big || e instanceof TooLarge) throw new TooLarge("the repository is too large to read here");
    if (late) throw new Error("the repository took too long to download");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The production work: git for the head commit, the host's source archive for the tree. */
export function repoWork(b = REPO_CHECK_BOUNDS): RepoWork {
  return {
    async head(repo) {
      const p = Bun.spawn(["git", "ls-remote", repo, "HEAD"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const timer = setTimeout(() => p.kill(), b.head_ms);
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      clearTimeout(timer);
      const commit = /^([0-9a-f]{40})\s+HEAD$/m.exec(out)?.[1];
      if (code !== 0 || !commit) throw new Error("the repository could not be read (it must be public and have a default branch)");
      return commit;
    },
    tree: (repo, commit, dir) => unpackArchive(archiveUrl(repo, commit), dir, b),
  };
}

/** What is stored per repository and head: the reading, or that the tree was too large to read. */
type Stored = TreeReading | { too_large: true };

export type RepoCheck = { repo: string; head: string | null; checked_at: number | null } & (
  | { state: "ready"; units: number }
  | { state: "can_set_up"; class: string; language: string; tests: number; tests_in: string[]; setup_minutes: number | null; setups: number }
  | { state: "cannot"; cause: "tests" | "language" | "verifier" | "address"; class: string | null; language: string | null; seen: string | null; gpu: string[]; reason: string }
  | { state: "checking" }
  | { state: "unknown"; why: string }
);

type Done = { head: string; stored: Stored; read_at: number } | { fail: string };

interface Internals {
  db: Core["db"];
  now(): number;
}

const instances = new WeakMap<Core, RepoChecks>();
export function repoCheckOf(core: Core): RepoChecks {
  let m = instances.get(core);
  if (!m) instances.set(core, (m = new RepoChecks(core)));
  return m;
}

export class RepoChecks {
  private readonly c: Internals;
  work: RepoWork;
  bounds = { ...REPO_CHECK_BOUNDS };
  /** readings that ran (not answered from the table), for tests and the log */
  readings = 0;
  private jobs = new Map<string, Promise<Done>>();
  private heads = new Map<string, { head: string; at: number }>();
  private fails = new Map<string, { why: string; at: number }>();
  private running = 0;
  private waiters: (() => void)[] = [];
  private started: number[] = [];

  constructor(private core: Core) {
    this.c = core as unknown as Internals;
    this.c.db.exec(SCHEMA);
    this.work = repoWork(this.bounds);
  }

  /** GET /v1/repo-check?repo=<url> */
  async check(raw: string | undefined): Promise<RepoCheck> {
    if (!raw || raw.length > 200) throw bad("bad_repo", "repo: a repository URL");
    let repo: string;
    try {
      repo = canonicalUrl(raw.trim());
    } catch {
      throw bad("bad_repo", "repo: a repository URL");
    }
    const none = { repo, head: null, checked_at: null };
    if (!REPO_URL.test(repo)) return { ...none, state: "cannot", cause: "address", class: null, language: null, seen: null, gpu: [], reason: "its address is not a public GitHub, GitLab or Codeberg repository" };
    const units = this.units(repo);
    if (units > 0) return { ...none, state: "ready", units };
    const now = this.c.now();
    let job = this.jobs.get(repo);
    if (!job) {
      const h = this.heads.get(repo);
      const row = h && now - h.at < this.bounds.head_ttl_ms && now >= h.at ? this.row(repo, h.head) : null;
      if (row) return this.answer(repo, { head: h!.head, ...row });
      const f = this.fails.get(repo);
      if (f && now - f.at < this.bounds.fail_ttl_ms && now >= f.at) return { ...none, state: "unknown", why: f.why };
      job = this.read(repo).finally(() => this.jobs.delete(repo));
      this.jobs.set(repo, job);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([job, new Promise<null>((res) => (timer = setTimeout(() => res(null), this.bounds.wait_ms)))]);
    clearTimeout(timer);
    if (r === null) return { ...none, state: "checking" };
    if ("fail" in r) return { ...none, state: "unknown", why: r.fail };
    return this.answer(repo, r);
  }

  /** Active units on the repository. */
  private units(repo: string): number {
    return this.c.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM lineages WHERE repo_id = ? AND status = 'active'").get(repoId(repo))?.n ?? 0;
  }

  private row(repo: string, head: string): { stored: Stored; read_at: number } | null {
    const r = this.c.db.query<{ reading: string; read_at: number }, [string, string]>("SELECT reading, read_at FROM repo_checks WHERE repo = ? AND head = ?").get(repo, head);
    return r ? { stored: JSON.parse(r.reading) as Stored, read_at: r.read_at } : null;
  }

  private bounded<K, V>(m: Map<K, V>, k: K, v: V) {
    m.delete(k);
    m.set(k, v);
    while (m.size > 2000) m.delete(m.keys().next().value as K);
  }

  /** One reading of a repository: its head, then the stored reading of that head or a new one. Never rejects. */
  private async read(repo: string): Promise<Done> {
    const fail = (why: string): Done => {
      this.bounded(this.fails, repo, { why, at: this.c.now() });
      return { fail: why };
    };
    let head: string;
    try {
      head = await this.work.head(repo);
    } catch (e) {
      return fail((e as Error).message.slice(0, 200));
    }
    this.bounded(this.heads, repo, { head, at: this.c.now() });
    const have = this.row(repo, head);
    if (have) return { head, ...have };
    const hour = Date.now() - 3_600_000;
    this.started = this.started.filter((t) => t > hour);
    if (this.started.length >= this.bounds.per_hour || this.waiters.length >= this.bounds.queued) return fail("too many repositories are being read right now");
    this.started.push(Date.now());
    if (this.running >= this.bounds.running) await new Promise<void>((res) => this.waiters.push(res));
    this.running++;
    const dir = mkdtempSync(join(tmpdir(), "units-repo-check-"));
    let stored: Stored;
    try {
      this.readings++;
      await this.work.tree(repo, head, dir);
      stored = readTree(dir);
    } catch (e) {
      if (!(e instanceof TooLarge)) return fail((e as Error).message.slice(0, 200));
      stored = { too_large: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      this.running--;
      this.waiters.shift()?.();
    }
    const read_at = this.c.now();
    // one row per repository: the newest head replaces the one before it
    this.c.db.query("DELETE FROM repo_checks WHERE repo = ?").run(repo);
    this.c.db.query("INSERT INTO repo_checks (repo, head, reading, read_at) VALUES (?, ?, ?, ?)").run(repo, head, JSON.stringify(stored), read_at);
    return { head, stored, read_at };
  }

  /** Classes that have an active unit on a real repository here: a verifier can be qualified for them. */
  private classes(): Set<string> {
    const out = new Set<string>();
    const rows = this.c.db.query<{ json: string }, []>("SELECT rc.json AS json FROM lineages l JOIN recipes rc ON rc.recipe_id = l.recipe_id WHERE l.status = 'active'").all();
    for (const r of rows) {
      try {
        const rec = JSON.parse(r.json) as { class?: unknown; repo?: unknown };
        if (typeof rec.class === "string" && !String(rec.repo).startsWith("fixture:")) out.add(rec.class);
      } catch {
        /* a recipe that does not parse counts for no class */
      }
    }
    return out;
  }

  /**
   * How long recorded setups took: for every unit an agent drafted for its own repository, the time
   * from its launch to the unit's creation. The figure is the 80th percentile in whole minutes, and
   * only with at least `min_setups` of them; otherwise there is none.
   */
  setupTime(): { minutes: number | null; setups: number } {
    recipeProposalsOf(this.core); // its tables exist
    const rows = this.c.db
      .query<{ ms: number }, []>("SELECT p.decided_at - a.registered_at AS ms FROM recipe_proposals p JOIN agents a ON a.agent_id = p.proposer AND a.kind = 'launched' AND a.target_repo = p.repo WHERE p.status = 'accepted' AND p.decided_at > a.registered_at ORDER BY ms")
      .all();
    if (rows.length < this.bounds.min_setups) return { minutes: null, setups: rows.length };
    const at = Math.min(rows.length - 1, Math.ceil(rows.length * 0.8) - 1);
    return { minutes: Math.max(1, Math.ceil(rows[at]!.ms / 60_000)), setups: rows.length };
  }

  private answer(repo: string, r: { head: string; stored: Stored; read_at: number }): RepoCheck {
    const base = { repo, head: r.head, checked_at: r.read_at };
    const s = r.stored;
    if ("too_large" in s) return { ...base, state: "unknown", why: "the repository is too large to read here" };
    const language = s.class ? (CLASS_LABEL[s.class] ?? s.class) : null;
    if (s.impossible !== null) return { ...base, state: "cannot", cause: s.cause, class: s.class, language, seen: s.seen, gpu: s.gpu, reason: s.impossible };
    if (!this.classes().has(s.class))
      return { ...base, state: "cannot", cause: "verifier", class: s.class, language, seen: null, gpu: [], reason: `this network has no ${language} unit yet, so no verifier is qualified to calibrate one` };
    const t = this.setupTime();
    return { ...base, state: "can_set_up", class: s.class, language: language!, tests: s.tests, tests_in: s.tests_in, setup_minutes: t.minutes, setups: t.setups };
  }
}
