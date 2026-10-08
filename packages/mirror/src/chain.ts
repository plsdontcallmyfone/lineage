// Deterministic commit chain of one lineage (SPEC 16, plan W1). Starting at the lineage's snapshot
// commit, every accepted generation becomes exactly one commit:
//   patch   its canonical patch applied to the previous commit's tree;
//   revert  the tree Core serves for the revert entry (snapshot plus the patch series without the
//           reverted generation, SPEC 11.3), i.e. a revert commit.
// Author and committer are the generation's author identity (its own GitHub account with its SSH
// signing key, or the app fallback), both dated at accepted_at, and the message is built only from
// fields fixed at acceptance. Ed25519 SSH signatures are deterministic, so building the same
// generations again yields the same commit ids: a deleted branch is rebuilt identically.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreReader, GenerationView, LineageView } from "./coreapi.ts";
import { git } from "./git.ts";
import { commitMessage } from "./message.ts";

export interface CommitIdentity {
  kind: "account" | "app";
  name: string;
  email: string;
  /** OpenSSH private key used to sign (null: the commit is unsigned) */
  signingKey: string | null;
  /** GitHub login (null for an unconfigured app fallback) */
  login: string | null;
  token: string | null;
}

export interface Identities {
  /** The agent's own GitHub identity, or null when it has none (then `app()` is used and recorded). */
  forAgent(agent: string): CommitIdentity | null;
  app(): CommitIdentity;
}

export interface ChainEntry {
  gen_id: string;
  height: number;
  entry_type: "patch" | "revert";
  author: string | null;
  identity: "account" | "app";
  login: string | null;
  sha: string | null;
  signed: boolean;
  error: string | null;
}

export interface Chain {
  lineage_id: string;
  recipe: string;
  repo: string;
  base: string;
  /** last commit that was built (the snapshot when nothing was) */
  tip: string;
  entries: ChainEntry[];
  /** working repository holding every built commit (the caller removes it) */
  dir: string;
}

export interface BuildOptions {
  core: CoreReader;
  lineage: LineageView;
  identities: Identities;
  /** git URL of the lineage's repository (https://github.com/owner/repo.git, or a local path in tests) */
  repoGitUrl: string;
  site: string;
  dir: string;
  log?: (m: string) => void;
}

export const APP_IDENTITY: CommitIdentity = { kind: "app", name: "lineage-app", email: "lineage-app@lineage.invalid", signingKey: null, login: null, token: null };

export async function buildChain(o: BuildOptions): Promise<Chain> {
  const log = o.log ?? (() => {});
  const L = o.lineage;
  const dir = o.dir;
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  const base = L.snapshot.commit_sha;
  let fetched = git(dir, ["fetch", "-q", "--depth", "1", o.repoGitUrl, base], { allowFail: true });
  if (!fetched.ok) fetched = git(dir, ["fetch", "-q", o.repoGitUrl], { allowFail: true });
  if (!git(dir, ["cat-file", "-e", `${base}^{commit}`], { allowFail: true }).ok) throw new Error(`snapshot commit ${base} not found in ${L.repo}: ${fetched.err}`);
  git(dir, ["checkout", "-q", "--detach", base]);

  const gens = [...L.generations].filter((g) => g.entry_type !== "genesis").sort((a, b) => a.height - b.height);
  const entries: ChainEntry[] = [];
  let tip = base;
  let broken: string | null = null;
  const views = new Map<string, GenerationView>();
  const view = async (id: string) => {
    if (!views.has(id)) views.set(id, await o.core.generation(id));
    return views.get(id)!;
  };
  for (const s of gens) {
    const g = await view(s.gen_id);
    const own = g.author ? o.identities.forAgent(g.author) : null;
    const id = own ?? o.identities.app();
    const entry: ChainEntry = {
      gen_id: g.gen_id, height: g.height, entry_type: g.entry_type as "patch" | "revert", author: g.author,
      identity: own ? "account" : "app", login: id.login, sha: null, signed: false, error: null,
    };
    entries.push(entry);
    if (broken) {
      entry.error = `not built: generation ${broken} did not apply`;
      continue;
    }
    try {
      if (g.entry_type === "patch") {
        apply(dir, g.patch ?? "", g.gen_id);
      } else {
        // a revert: the tree Core serves for this entry, rebuilt from the snapshot
        const t = await o.core.tree(L.lineage_id, g.gen_id);
        git(dir, ["read-tree", "--reset", "-u", base]);
        git(dir, ["clean", "-fdqx"]);
        for (const p of t.patches) apply(dir, p.patch, p.gen_id);
      }
      const reverted = g.reverts ? await view(g.reverts) : null;
      const soul = g.author && g.entry_type === "patch" ? await o.core.soulAt(g.author, g.accepted_at) : null;
      const msg = commitMessage({ gen: g, lineage_id: L.lineage_id, recipe: L.recipe.name, site: o.site, soul, reverted, identity: entry.identity });
      const msgFile = join(dir, ".git", "LINEAGE_MSG");
      writeFileSync(msgFile, msg);
      const when = `${Math.floor(g.accepted_at / 1000)} +0000`;
      const cfg = ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "-c", "commit.gpgsign=false"];
      if (id.signingKey) cfg.push("-c", "gpg.format=ssh", "-c", `user.signingkey=${id.signingKey}`);
      git(dir, [...cfg, "commit", "-q", "--allow-empty", "--no-verify", ...(id.signingKey ? ["-S"] : []), "-F", msgFile], {
        env: { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email },
      });
      entry.sha = git(dir, ["rev-parse", "HEAD"]).out;
      entry.signed = !!id.signingKey;
      tip = entry.sha;
      log(`chain ${L.recipe.name} gen ${g.height} ${g.entry_type} -> ${entry.sha.slice(0, 12)} (${entry.identity}${id.login ? ` ${id.login}` : ""})`);
    } catch (e) {
      entry.error = (e as Error).message;
      broken = g.gen_id;
      log(`chain ${L.recipe.name} gen ${g.height}: ${entry.error}`);
    }
  }
  return { lineage_id: L.lineage_id, recipe: L.recipe.name, repo: L.repo, base, tip, entries, dir };
}

/** Applies one canonical patch to the index and work tree (exact context first, then one line of context). */
export function apply(dir: string, patch: string, genId: string) {
  if (!patch.trim()) return;
  const file = join(dir, ".git", `LINEAGE_PATCH`);
  writeFileSync(file, patch.endsWith("\n") ? patch : patch + "\n");
  const a = git(dir, ["apply", "--index", "--whitespace=nowarn", file], { allowFail: true });
  if (a.ok) return;
  const b = git(dir, ["apply", "--index", "--whitespace=nowarn", "-C1", file], { allowFail: true });
  if (!b.ok) throw new Error(`patch of ${genId.slice(0, 12)} does not apply: ${a.err.split("\n")[0]}`);
}
