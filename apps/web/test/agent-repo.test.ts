// "Upstream" and "Agent's repo" side by side (owner 2026-10-12): the agent's repository is read from
// Core's record of its published commits and never made up; with none the page says so.
import { describe, expect, test } from "bun:test";
import { agentRepoLabel, agentRepos, commitLink, repoOfRow, repoPair, type GenGithubRow } from "../src/agent-repo.ts";

const UP = "https://github.com/keis/base58";
const own = (gen: string, login: string, sha = "d02114a7c1f3e5b9a8d7c6b5a4f3e2d1c0b9a8f7"): GenGithubRow => ({
  gen_id: gen, author: "AgentA", repo: UP,
  github: { url: `https://github.com/${login}/base58/commit/${sha}`, commit: sha, repo: `${login}/base58`, branch: "units/base58-py", identity: "token", login },
});
const shared = (gen: string): GenGithubRow => ({
  gen_id: gen, author: "AgentB", repo: UP,
  github: { url: "https://github.com/units-agents/generations/commit/1bc7952aa", commit: "1bc7952aa", repo: "units-agents/generations", branch: "base58-py/AgentB", identity: "app", login: "unitsdotgg" },
});
const text = (r: { s: string }) => r.s.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

describe("the agent's own repository", () => {
  test("an agent with its own account: its fork; an agent without one: its branch of the publisher's repository", () => {
    expect(repoOfRow(own("g1", "agwyus9p"))).toEqual({ repo: "agwyus9p/base58", url: "https://github.com/agwyus9p/base58", branch: null });
    expect(repoOfRow(shared("g2"))).toEqual({ repo: "units-agents/generations", url: "https://github.com/units-agents/generations/tree/base58-py/AgentB", branch: "base58-py/AgentB" });
  });

  test("nothing published is no repository: pending, awaiting a publisher, removed, or a malformed record", () => {
    for (const github of [null, undefined, { status: "awaiting publisher" }, { status: "pending" }, { status: "removed", repo: "agwyus9p/base58" }, { commit: "abc", repo: "not a repo" }, { commit: "abc", repo: "a/b/../c" }, { commit: "abc" }])
      expect(repoOfRow({ gen_id: "g", github: github as any })).toBeNull();
    expect(agentRepos([{ gen_id: "g", github: { status: "pending" } }])).toEqual([]);
  });

  test("the labels keep upstream and agent apart, each a link", () => {
    const one = repoPair({ upstream: UP, repos: agentRepos([own("g1", "agwyus9p"), own("g0", "agwyus9p")], UP) });
    expect(text(one)).toBe("Upstream: keis/base58 Agent's repo: agwyus9p/base58");
    expect(one.s).toContain(`href="${UP}"`);
    expect(one.s).toContain('href="https://github.com/agwyus9p/base58"');
    expect(text(repoPair({ upstream: UP, repos: agentRepos([shared("g2")]) }))).toBe("Upstream: keis/base58 Agent's repo: units-agents/generations, branch base58-py/AgentB");
    // a unit page lists the repositories of every agent that has a generation on it
    expect(text(repoPair({ upstream: UP, repos: agentRepos([own("g3", "nbebp7jy"), own("g1", "agwyus9p"), shared("g2")]), many: true }))).toBe("Upstream: keis/base58 Agents' repos: nbebp7jy/base58 , agwyus9p/base58 , units-agents/generations, branch base58-py/AgentB");
    expect(agentRepoLabel(true, 1)).toBe("Agent's repo");
  });

  test("no repository yet is said in words, never a link; before Core answers only the upstream shows", () => {
    const none = repoPair({ upstream: UP, repos: [] });
    expect(text(none)).toBe("Upstream: keis/base58 No repository yet");
    expect(none.s.match(/<a /g)).toHaveLength(1);
    expect(text(repoPair({ upstream: UP, repos: [], many: true }))).toBe("Upstream: keis/base58 No agent repository yet");
    expect(text(repoPair({ upstream: UP, repos: null }))).toBe("Upstream: keis/base58");
    expect(text(repoPair({ upstream: null, repos: [] }))).toBe("No repository yet");
  });

  test("only this upstream's repository is the agent's repo for it", () => {
    const other: GenGithubRow = { ...own("g9", "agwyus9p"), repo: "https://github.com/karpathy/minbpe", github: { ...own("g9", "agwyus9p").github!, repo: "agwyus9p/minbpe" } };
    expect(agentRepos([other, own("g1", "agwyus9p")], UP).map((a) => a.repo)).toEqual(["agwyus9p/base58"]);
    expect(agentRepos([other, own("g1", "agwyus9p")]).map((a) => a.repo)).toEqual(["agwyus9p/minbpe", "agwyus9p/base58"]);
  });

  test("a generation row links to its commit in the author's repository, or shows nothing", () => {
    const l = commitLink(own("g1", "agwyus9p"));
    expect(text(l)).toBe("commit d02114a in agwyus9p/base58");
    expect(l.s).toContain('href="https://github.com/agwyus9p/base58/commit/d02114a7c1f3e5b9a8d7c6b5a4f3e2d1c0b9a8f7"');
    expect(commitLink({ gen_id: "g", github: { status: "pending" } }).s).toBe("");
    expect(commitLink({ gen_id: "g", github: { commit: "abc", repo: "a/b", url: "javascript:alert(1)" } }).s).toBe("");
    expect(commitLink(undefined).s).toBe("");
  });
});
