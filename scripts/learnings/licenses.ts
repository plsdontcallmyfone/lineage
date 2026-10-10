#!/usr/bin/env bun
// Reads the licence of every target repository from GitHub into config/learnings-licenses.json, which
// Core puts on each episode (docs/plans/AGENT-LEARNINGS.md 8). The licence is what GitHub's licence
// detection reports (GET /repos/{owner}/{repo}/license), with the file URL and the day it was read;
// a repository GitHub cannot classify keeps spdx null. Nothing is guessed.
//
// Usage: bun scripts/learnings/licenses.ts [--core http://127.0.0.1:9660] [--recipes] [--out config/learnings-licenses.json]
//   --core     the repositories of Core's lineages (default)
//   --recipes  also every recipe in recipes/*/recipe.yml
// GITHUB_TOKEN, when set, raises the API rate limit; it is never printed.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const ROOT = join(import.meta.dir, "../..");
const OUT = opt("out") ?? join(ROOT, "config/learnings-licenses.json");
const CORE = (opt("core") ?? "http://127.0.0.1:9660").replace(/\/+$/, "");

const repos = new Set<string>();
const norm = (u: string) => u.trim().replace(/\.git$/, "").replace(/\/+$/, "");
try {
  const r = await fetch(`${CORE}/v1/lineages`, { signal: AbortSignal.timeout(20_000) });
  if (r.ok) for (const l of (await r.json()) as any[]) if (typeof l.repo === "string") repos.add(norm(l.repo));
  else console.error(`Core answered ${r.status}; continuing with the recipes`);
} catch (e) {
  console.error(`Core not reachable (${(e as Error).message}); continuing with the recipes`);
}
if (argv.includes("--recipes") || !repos.size) {
  for (const d of readdirSync(join(ROOT, "recipes"))) {
    const f = join(ROOT, "recipes", d, "recipe.yml");
    if (!existsSync(f)) continue;
    const m = /^repo:\s*"?([^"\s]+)"?/m.exec(readFileSync(f, "utf8"));
    if (m) repos.add(norm(m[1]!));
  }
}

const prev = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")).repos as any[]) : [];
const byRepo = new Map(prev.map((r) => [norm(r.repo).toLowerCase(), r]));
const today = new Date().toISOString().slice(0, 10);
const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "lineage-learnings-licenses" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
for (const repo of [...repos].sort()) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repo);
  if (!m) {
    console.log(`${repo}: not a GitHub repository, skipped`);
    continue;
  }
  const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/license`, { headers, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) {
    byRepo.set(repo.toLowerCase(), { repo, spdx: null, name: null, url: null, source: `GitHub API /repos/${m[1]}/${m[2]}/license (404: no licence file detected)`, read_on: today });
    console.log(`${repo}: no licence file detected`);
    continue;
  }
  if (!r.ok) {
    console.log(`${repo}: GitHub answered ${r.status}; kept the previous record`);
    continue;
  }
  const j: any = await r.json();
  const spdx = j.license?.spdx_id ?? null;
  byRepo.set(repo.toLowerCase(), { repo, spdx, name: j.license?.name ?? null, url: j.html_url ?? null, source: `GitHub API /repos/${m[1]}/${m[2]}/license`, read_on: today });
  console.log(`${repo}: ${spdx}`);
}
const out = { v: 1, _note: "Written by scripts/learnings/licenses.ts from GitHub's licence detection; spdx null or NOASSERTION means not determined.", repos: [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo)) };
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`${out.repos.length} repositories in ${OUT}`);
