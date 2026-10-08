#!/usr/bin/env bun
// GitHub proof (SPEC 14.8, identity plan I4): one signed commit by this lane's TEST agent under its
// provisioned pool account, on a fork of the agent's target repository (karpathy/minbpe) at the
// recipe's pinned commit, branch lineage/minbpe; the commit message is written in the agent's soul
// voice by Claude from stated facts (capped, checked); then GitHub's own API is asked whether the
// commit shows Verified. Results (public: login, fork, sha, verification) in scripts/souls/GITHUB-LAST.json.
// Usage: bun scripts/souls/github-proof.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicClient, composeInVoice, loadModelKey, soulDigest, type SoulDoc } from "../../packages/souls/src/index.ts";
import { FileCredentialStore, GitHub, lineageTrailers, signedCommit } from "../../packages/souls/src/github/index.ts";
import { LANE_CAP_USD, laneSpent, recordSpend } from "./lib.ts";

const soul = JSON.parse(readFileSync(join(import.meta.dir, "proof/soul-a.json"), "utf8")) as SoulDoc;
const cred = new FileCredentialStore().get(soul.agent);
if (!cred) throw new Error("no credential for the agent: run lineage-souls provision first");
const recipe = readFileSync(join(import.meta.dir, "../../recipes/minbpe/recipe.yml"), "utf8");
const base = /^commit:\s*"?([0-9a-f]{40})"?/m.exec(recipe)![1]!;
const digest = soulDigest(soul);

const CAP = 0.05;
if (laneSpent() + CAP > LANE_CAP_USD) throw new Error("lane spend cap");
const facts = `This commit adds 1 file, .lineage/agent.json, recording which Lineage agent publishes this branch and the digest of its soul document.
It changes no library code. The branch starts at the commit the minbpe recipe pins.
The branch is where accepted generations of this agent's lineage will be mirrored.`;
const v = await composeInVoice({ soul, surface: "commit", facts, client: anthropicClient(await loadModelKey()), maxUsd: CAP, log: console.log });
recordSpend({ what: "commit message in soul A's voice", usd: v.usage.usd, calls: v.usage.calls, models: v.usage.models, input_tokens: v.usage.input_tokens, output_tokens: v.usage.output_tokens, ok: !!v.text });
const message = v.text ?? "Record the agent on its lineage branch\n\nAdds .lineage/agent.json naming the agent and its soul digest. No library code changes.";
console.log(`message${v.text ? "" : " (fallback, voice text failed checks: " + v.problems.join("; ") + ")"}:\n${message}\n`);

const r = await signedCommit({
  cred,
  upstream: "karpathy/minbpe",
  branch: "lineage/minbpe",
  baseCommit: base,
  files: { ".lineage/agent.json": JSON.stringify({ agent: soul.agent, soul: digest, recipe: "minbpe", base }, null, 2) + "\n" },
  message: `${message}\n\n${lineageTrailers({ agent: soul.agent, soul: digest })}\n`,
  log: console.log,
});
// read the account's public profile back as anyone sees it
const pub = await new GitHub({ token: cred.token }).get<any>(`/users/${cred.login}`);
const keys = await fetch(`https://api.github.com/users/${cred.login}/ssh_signing_keys`).then((x) => x.json()).catch(() => []);
const out = {
  at: new Date().toISOString(),
  agent: soul.agent,
  login: cred.login,
  profile: { name: pub.name, bio: pub.bio, blog: pub.blog, company: pub.company, location: pub.location, avatar_url: pub.avatar_url },
  public_signing_keys: Array.isArray(keys) ? keys.map((k: any) => k.key) : keys,
  commit: r,
  voice_message: !!v.text,
};
writeFileSync(join(import.meta.dir, "GITHUB-LAST.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
if (!r.verified) process.exit(1);
