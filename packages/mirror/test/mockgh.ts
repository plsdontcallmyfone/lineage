// A mocked GitHub for the mirror tests: the REST calls the mirror and PR bot make, backed by local bare
// repositories under `root` (the git "host"). Signature verification is real: a commit is Verified
// when its SSH signature checks against the key registered for the committer's noreply email.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sh = (cwd: string, args: string[], allowFail = false) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

export interface MockUser {
  login: string;
  id: number;
  token: string;
  signingKey: string; // public key line
}

export interface MockPull {
  number: number;
  repo: string;
  head: string; // login:branch
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  user: string;
}

export class MockGitHub {
  readonly api = "http://gh.mock";
  readonly users: MockUser[] = [];
  readonly calls: { method: string; path: string; login: string | null }[] = [];
  readonly pulls: MockPull[] = [];
  readonly forks = new Map<string, string>(); // fork -> parent
  readonly defaults = new Map<string, string>(); // repo -> default branch
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  bare(full: string) {
    return join(this.root, `${full}.git`);
  }

  /** Creates an upstream repository with `files` on branch main; returns the commit sha. */
  createRepo(full: string, files: Record<string, string>, owner?: string): string {
    const work = join(this.root, "_work", full.replace("/", "_"));
    mkdirSync(work, { recursive: true });
    sh(work, ["init", "-q", "-b", "main"]);
    for (const [p, b] of Object.entries(files)) {
      mkdirSync(join(work, p, ".."), { recursive: true });
      writeFileSync(join(work, p), b);
    }
    sh(work, ["add", "-A"]);
    sh(work, ["-c", "user.name=up", "-c", "user.email=up@example.invalid", "commit", "-q", "-m", "initial"]);
    const bare = this.bare(full);
    mkdirSync(join(bare, ".."), { recursive: true });
    sh(this.root, ["clone", "-q", "--bare", work, bare]);
    sh(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    this.defaults.set(full, "main");
    void owner;
    return sh(work, ["rev-parse", "HEAD"]).out;
  }

  /** Commits on the default branch of `full` (a maintainer's change, e.g. a merge). */
  commitUpstream(full: string, files: Record<string, string>, msg: string): string {
    const work = join(this.root, "_work", `${full.replace("/", "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    sh(this.root, ["clone", "-q", this.bare(full), work]);
    for (const [p, b] of Object.entries(files)) writeFileSync(join(work, p), b);
    sh(work, ["add", "-A"]);
    sh(work, ["-c", "user.name=maint", "-c", "user.email=maint@example.invalid", "commit", "-q", "-m", msg]);
    sh(work, ["push", "-q", "origin", "HEAD:main"]);
    return sh(work, ["rev-parse", "HEAD"]).out;
  }

  private who(init?: RequestInit): MockUser | null {
    const h = new Headers(init?.headers);
    const t = (h.get("authorization") ?? "").replace(/^Bearer /, "");
    return this.users.find((u) => u.token === t) ?? null;
  }

  private allowedSigners(): string {
    const f = join(this.root, "_allowed_signers");
    writeFileSync(f, this.users.map((u) => `${u.id}+${u.login}@users.noreply.github.com ${u.signingKey}`).join("\n") + "\n");
    return f;
  }

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const me = this.who(init);
    const path = u.pathname;
    this.calls.push({ method, path, login: me?.login ?? null });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    const nf = () => json({ message: "Not Found" }, 404);
    let m: RegExpExecArray | null;
    if (!me) return json({ message: "Bad credentials" }, 401);

    if ((m = /^\/repos\/([^/]+\/[^/]+)\/forks$/.exec(path)) && method === "POST") {
      const up = m[1]!;
      if (!existsSync(this.bare(up))) return nf();
      const fork = `${me.login}/${up.split("/")[1]}`;
      if (!existsSync(this.bare(fork))) {
        mkdirSync(join(this.bare(fork), ".."), { recursive: true });
        sh(this.root, ["clone", "-q", "--bare", this.bare(up), this.bare(fork)]);
        this.forks.set(fork, up);
        this.defaults.set(fork, "main");
      }
      return json({ full_name: fork }, 202);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(path)) && method === "GET") {
      const r = sh(this.bare(m[1]!), ["rev-parse", "--verify", "-q", `refs/heads/${m[2]}`], true);
      return r.ok && existsSync(this.bare(m[1]!)) ? json({ ref: `refs/heads/${m[2]}`, object: { sha: r.out } }) : nf();
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/.exec(path)) && method === "DELETE") {
      const r = sh(this.bare(m[1]!), ["update-ref", "-d", `refs/heads/${m[2]}`], true);
      return r.ok ? new Response(null, { status: 204 }) : json({ message: "Reference does not exist" }, 422);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/branches$/.exec(path))) {
      if (!existsSync(this.bare(m[1]!))) return nf();
      const out = sh(this.bare(m[1]!), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out;
      return json(out.split("\n").filter(Boolean).map((name) => ({ name })));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})$/.exec(path))) {
      const bare = this.bare(m[1]!);
      if (!existsSync(bare) || !sh(bare, ["cat-file", "-e", `${m[2]}^{commit}`], true).ok) return json({ message: "No commit found" }, 422);
      const raw = sh(bare, ["cat-file", "commit", m[2]!]).out;
      let verification = { verified: false, reason: "unsigned" };
      if (raw.includes("gpgsig ")) {
        const ok = sh(bare, ["-c", `gpg.ssh.allowedSignersFile=${this.allowedSigners()}`, "verify-commit", m[2]!], true).ok;
        verification = ok ? { verified: true, reason: "valid" } : { verified: false, reason: "unknown_key" };
      }
      const files = this.commitFiles(bare, m[2]!);
      return json({ sha: m[2], html_url: `https://github.com/${m[1]}/commit/${m[2]}`, commit: { verification, message: sh(bare, ["log", "-1", "--format=%B", m[2]!]).out }, files });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits$/.exec(path))) {
      const bare = this.bare(m[1]!);
      const ref = u.searchParams.get("sha") ?? this.defaults.get(m[1]!) ?? "main";
      const since = u.searchParams.get("since");
      const args = ["log", "--format=%H %ct", ref];
      if (since) args.splice(1, 0, `--since=${since}`);
      const out = sh(bare, args).out;
      if (u.searchParams.get("page") && u.searchParams.get("page") !== "1") return json([]);
      return json(out.split("\n").filter(Boolean).map((l) => ({ sha: l.split(" ")[0] })));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path)) && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const pr: MockPull = { number: this.pulls.length + 1, repo: m[1]!, head: body.head, base: body.base, title: body.title, body: body.body, state: "open", merged: false, user: me.login };
      this.pulls.push(pr);
      return json(this.pullJson(pr), 201);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path)) && method === "GET") {
      const head = u.searchParams.get("head");
      return json(this.pulls.filter((p) => p.repo === m![1] && (!head || p.head === head)).map((p) => this.pullJson(p)));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents(?:\/(.*))?$/.exec(path)) && method === "GET") {
      const bare = this.bare(m[1]!);
      if (!existsSync(bare)) return nf();
      const ref = u.searchParams.get("ref") ?? "main";
      const p = m[2] ?? "";
      const t = sh(bare, ["cat-file", "-t", `${ref}:${p}`], true);
      if (!t.ok) return nf();
      if (t.out === "blob") return json({ type: "file", path: p, encoding: "base64", content: Buffer.from(sh(bare, ["show", `${ref}:${p}`]).out + "\n").toString("base64") });
      const ls = sh(bare, ["ls-tree", `${ref}:${p}`]).out;
      return json(ls.split("\n").filter(Boolean).map((l) => {
        const [meta, name] = l.split("\t") as [string, string];
        return { type: meta.split(" ")[1] === "tree" ? "dir" : "file", name, path: p ? `${p}/${name}` : name };
      }));
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path)) && method === "GET") {
      const p = this.pulls.find((x) => x.repo === m![1] && x.number === Number(m![2]));
      return p ? json(this.pullJson(p)) : nf();
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path)) && method === "GET") {
      const full = m[1]!;
      if (!existsSync(this.bare(full))) return nf();
      const parent = this.forks.get(full);
      return json({ full_name: full, fork: !!parent, parent: parent ? { full_name: parent } : undefined, source: parent ? { full_name: parent } : undefined, size: 1, default_branch: this.defaults.get(full) ?? "main", owner: { login: full.split("/")[0], type: "User" } });
    }
    if (method !== "GET") return json({ message: `mock: ${method} ${path} not supported` }, 405);
    return nf();
  };

  /** The maintainer merges a PR with a merge commit on the base branch. */
  mergePull(number: number): string {
    const p = this.pulls.find((x) => x.number === number)!;
    const [login, branch] = p.head.split(":") as [string, string];
    const work = join(this.root, "_work", `merge_${number}_${Date.now()}`);
    sh(this.root, ["clone", "-q", this.bare(p.repo), work]);
    sh(work, ["fetch", "-q", this.bare(`${login}/${p.repo.split("/")[1]}`), branch]);
    sh(work, ["-c", "user.name=maint", "-c", "user.email=maint@example.invalid", "merge", "-q", "--no-ff", "-m", `Merge pull request #${number}`, "FETCH_HEAD"]);
    sh(work, ["push", "-q", "origin", "HEAD:main"]);
    p.state = "closed";
    p.merged = true;
    return sh(work, ["rev-parse", "HEAD"]).out;
  }

  private pullJson(p: MockPull) {
    return {
      number: p.number, html_url: `https://github.com/${p.repo}/pull/${p.number}`, state: p.state, merged: p.merged, merged_at: p.merged ? new Date().toISOString() : null,
      title: p.title, body: p.body, user: { login: p.user }, base: { ref: p.base, repo: { full_name: p.repo } }, head: { ref: p.head.split(":")[1], label: p.head, repo: { full_name: `${p.head.split(":")[0]}/${p.repo.split("/")[1]}` } },
    };
  }

  private commitFiles(bare: string, sha: string) {
    const parent = sh(bare, ["rev-parse", "-q", "--verify", `${sha}^1`], true);
    const diff = parent.ok ? sh(bare, ["diff", "--no-color", "-U3", parent.out, sha]).out : "";
    const files: { filename: string; patch: string }[] = [];
    for (const part of diff.split(/^diff --git /m).filter(Boolean)) {
      const name = /^a\/(\S+) b\/(\S+)/.exec(part)?.[2] ?? "";
      const at = part.indexOf("\n@@");
      files.push({ filename: name, patch: at >= 0 ? part.slice(at + 1) : "" });
    }
    return files;
  }
}

export function keypair(dir: string, name: string): { privatePath: string; publicKey: string } {
  const privatePath = join(dir, name);
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", privatePath], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return { privatePath, publicKey: readFileSync(`${privatePath}.pub`, "utf8").trim() };
}
