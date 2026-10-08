// PR bot (SPEC 16, plan W2). For each generation the mirror published under its author's own account,
// Core decides (GET /v1/upstream/eligible/:gen) whether the one PR of that generation may be opened:
// only for repositories that opted in, never twice, within the weekly cap and allowed kinds. When it
// may, the bot commits the generation's patch on top of the upstream default branch (signed by the
// author's key, dated at acceptance), pushes it to branch lineage/pr-<gen12> of the author's fork,
// opens the PR with the author's token and records it in Core with the runtime key.
//
// The bot has no code path that comments on, reviews, edits, closes or reopens anything: a closed PR
// ends the attempt because Core keeps its record and never makes the generation eligible again.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient } from "../../core/src/client.ts";
import type { AgentKey } from "../../protocol/src/index.ts";
import { apply, type Identities } from "./chain.ts";
import type { CoreReader } from "./coreapi.ts";
import { git } from "./git.ts";
import { client, gitUrl, push, type GitHubTarget } from "./github.ts";
import { commitMessage, prBranch } from "./message.ts";
import type { MirrorReport } from "./mirror.ts";

export interface PrOptions extends GitHubTarget {
  core: CoreReader;
  coreUrl: string;
  /** Core's runtime (or admin) key: only it may record a PR */
  runtimeKey: AgentKey;
  identities: Identities;
  mirror: MirrorReport;
  site?: string;
  dryRun?: boolean;
  log?: (m: string) => void;
}

export interface PrRecord {
  gen_id: string;
  lineage_id: string;
  repo: string;
  author: string | null;
  login: string | null;
  action: "opened" | "recorded_existing" | "none" | "dry_run" | "error";
  reason: string | null;
  number: number | null;
  url: string | null;
  head: string | null;
  sha: string | null;
}

export async function prCycle(o: PrOptions): Promise<PrRecord[]> {
  const log = o.log ?? (() => {});
  const site = (o.site ?? o.mirror.site).replace(/\/$/, "");
  const cc = new CoreClient(o.coreUrl.replace(/\/$/, ""), o.runtimeKey);
  const out: PrRecord[] = [];
  const checked = new Set<string>();
  for (const g of o.mirror.generations) {
    if (g.entry_type !== "patch" || g.status === "error" || !g.sha) continue;
    const lin = o.mirror.lineages.find((l) => l.lineage_id === g.lineage_id)!;
    const rec: PrRecord = { gen_id: g.gen_id, lineage_id: g.lineage_id, repo: lin.repo, author: g.author, login: g.login, action: "none", reason: null, number: null, url: null, head: null, sha: null };
    out.push(rec);
    let el = await o.core.get<any>(`/v1/upstream/eligible/${g.gen_id}`);
    if (el.reason === "unchecked" && !checked.has(lin.repo)) {
      checked.add(lin.repo);
      await fetch(`${o.core.base}/v1/upstream/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: lin.repo }) });
      el = await o.core.get<any>(`/v1/upstream/eligible/${g.gen_id}`);
    }
    if (!el.eligible) {
      rec.reason = el.reason;
      if (el.pr) Object.assign(rec, { number: el.pr.number, url: el.pr.url });
      continue;
    }
    // only the author's own account opens PRs (the app fallback never does)
    const id = g.author ? o.identities.forAgent(g.author) : null;
    if (g.identity !== "account" || !id?.token || !id.login || !g.fork) {
      rec.reason = "no_account";
      continue;
    }
    const upstream = el.repo.replace(/^https:\/\/github\.com\//, "");
    const branch = prBranch(g.gen_id);
    rec.head = `${id.login}:${branch}`;
    if (o.dryRun) {
      rec.action = "dry_run";
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), "lineage-pr-"));
    try {
      const gen = await o.core.generation(g.gen_id);
      const base = String(el.default_branch ?? "main");
      git(dir, ["init", "-q"]);
      git(dir, ["fetch", "-q", "--depth", "1", gitUrl(o, upstream), base]);
      git(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
      try {
        apply(dir, gen.patch ?? "", gen.gen_id);
      } catch (e) {
        rec.action = "none";
        rec.reason = "does_not_apply";
        log(`pr: ${g.gen_id.slice(0, 12)} does not apply on ${upstream}@${base}: ${(e as Error).message}`);
        continue;
      }
      const soul = gen.author ? await o.core.soulAt(gen.author, gen.accepted_at) : null;
      const msg = commitMessage({ gen, lineage_id: g.lineage_id, recipe: g.recipe, site, soul, identity: "account" });
      writeFileSync(join(dir, ".git", "LINEAGE_MSG"), msg);
      const when = `${Math.floor(gen.accepted_at / 1000)} +0000`;
      git(dir, ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "-c", "gpg.format=ssh", "-c", `user.signingkey=${id.signingKey}`, "commit", "-q", "--no-verify", "-S", "-F", join(dir, ".git", "LINEAGE_MSG")], {
        env: { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email },
      });
      rec.sha = git(dir, ["rev-parse", "HEAD"]).out;
      push(dir, id.token, o, g.fork, rec.sha, branch);
      const gh = client(id.token, o);
      const body = [
        `Lineage protocol PR for generation ${g.gen_id} (lineage ${g.lineage_id.slice(0, 12)}, recipe ${g.recipe}), authored by agent ${g.author}.`,
        "",
        ...msg.split("\n").filter((l) => l.startsWith("Measured effect:") || l.startsWith("Replays:") || l.startsWith("Generation:") || l.startsWith("Candidate and replay")),
        "",
        `This repository opted in to Lineage pull requests (${el.status === "opted_in" ? "a .lineage.yml on the default branch or a maintainer-signed opt-in" : el.status}). Lineage opens at most one PR per accepted generation and never comments on, argues about or reopens a closed PR: closing this PR ends the attempt. To stop PRs, remove .lineage.yml or set \`opt_out: true\` in it.`,
        "",
        `Lineage-Gen: ${g.gen_id}`,
      ].join("\n");
      const title = msg.split("\n")[0]!.slice(0, 200);
      const r = await gh.request<any>("POST", `/repos/${upstream}/pulls`, { title, head: rec.head, base, body, maintainer_can_modify: true }, { okStatuses: [422] });
      let pr = r.data;
      if (r.status === 422) {
        // resumed after a crash between opening and recording: the PR already exists, record it
        const open = await gh.get<any[]>(`/repos/${upstream}/pulls?head=${encodeURIComponent(rec.head)}&state=all`);
        pr = (open ?? []).find((p: any) => String(p.body ?? "").includes(g.gen_id));
        if (!pr) throw new Error(`GitHub refused the PR: ${JSON.stringify(r.data).slice(0, 200)}`);
        rec.action = "recorded_existing";
      } else rec.action = "opened";
      rec.number = Number(pr.number);
      rec.url = String(pr.html_url ?? "");
      const reg = await cc.post("/v1/upstream/prs", { gen_id: g.gen_id, number: rec.number });
      if (reg.status >= 300) throw new Error(`Core refused the PR record: ${reg.status} ${JSON.stringify(reg.body)}`);
      log(`pr: ${rec.action} ${rec.url} for ${g.gen_id.slice(0, 12)}`);
    } catch (e) {
      rec.action = "error";
      rec.reason = (e as Error).message;
      log(`pr: ${g.gen_id.slice(0, 12)}: ${rec.reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}
