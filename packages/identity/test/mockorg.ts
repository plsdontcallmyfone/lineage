// GitHub organization endpoints on top of the mirror's MockGitHub (docs/plans/GITHUB-ORG.md): org
// memberships (invite, accept, publicize), repository transfer, organization repositories, and the
// X-OAuth-Scopes header of classic tokens. Behaviour follows GitHub's REST docs (Organization members,
// Repositories), API 2022-11-28.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { MockGitHub } from "../../mirror/test/mockgh.ts";

export interface Membership {
  role: "admin" | "member";
  state: "pending" | "active";
}

export class MockOrgGitHub extends MockGitHub {
  readonly orgs = new Map<string, { members: Map<string, Membership>; public: Set<string> }>();
  /** classic scopes per login (absent: a fine-grained token, no header) */
  readonly scopes = new Map<string, string[]>();
  /** transient failures to inject: "<METHOD> <path>" -> remaining count */
  readonly failNext = new Map<string, { status: number; message: string; count: number }>();
  readonly orgCalls: string[] = [];

  addOrg(org: string, owner: string) {
    this.orgs.set(org, { members: new Map([[owner.toLowerCase(), { role: "admin", state: "active" }]]), public: new Set() });
  }

  private me(init?: RequestInit) {
    const t = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    return this.users.find((u) => u.token === t) ?? null;
  }

  // the parent's handler (its instance field, set before this class's fields initialise)
  private readonly base: MockGitHub["fetch"] = Reflect.get(this, "fetch");
  override readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const p = u.pathname;
    const me = this.me(init);
    const json = (d: unknown, status = 200) => new Response(d === null ? null : JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    const key = `${method} ${p}`;
    const f = this.failNext.get(key);
    if (f && f.count > 0) {
      f.count--;
      return json({ message: f.message }, f.status);
    }
    let m: RegExpExecArray | null;
    if (me && method === "GET" && p === "/user") {
      const r = await this.base(url, init);
      const s = this.scopes.get(me.login);
      const h = new Headers(r.headers);
      if (s) h.set("x-oauth-scopes", s.join(", "));
      return new Response(await r.text(), { status: r.status, headers: h });
    }
    const can = (need: string[]) => {
      const s = me ? this.scopes.get(me.login) : undefined;
      return !s || s.some((x) => need.includes(x));
    };
    if ((m = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(p)) && me) {
      this.orgCalls.push(`${key} as ${me.login}`);
      const o = this.orgs.get(m[1]!);
      const mm = o?.members.get(me.login.toLowerCase());
      if (!o || !mm) return json({ message: "Not Found" }, 404);
      if (method === "GET") return json({ state: mm.state, role: mm.role, organization: { login: m[1] } });
      if (method === "PATCH") {
        if (!can(["admin:org", "write:org"])) return json({ message: "Must have admin rights" }, 403);
        mm.state = "active";
        return json({ state: "active", role: mm.role });
      }
    }
    if ((m = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(p)) && me) {
      this.orgCalls.push(`${key} as ${me.login}`);
      const o = this.orgs.get(m[1]!);
      const mine = o?.members.get(me.login.toLowerCase());
      if (!o || !mine || mine.state !== "active") return json({ message: "Not Found" }, 404);
      const who = m[2]!.toLowerCase();
      if (method === "GET") {
        const x = o.members.get(who);
        return x ? json({ state: x.state, role: x.role }) : json({ message: "Not Found" }, 404);
      }
      if (method === "PUT") {
        if (mine.role !== "admin" || !can(["admin:org", "write:org"])) return json({ message: "You must be an admin" }, 403);
        const x = o.members.get(who) ?? { role: "member" as const, state: "pending" as const };
        o.members.set(who, x);
        return json({ state: x.state, role: x.role });
      }
    }
    if ((m = /^\/orgs\/([^/]+)\/public_members(?:\/([^/]+))?$/.exec(p))) {
      this.orgCalls.push(`${key} as ${me?.login ?? "-"}`);
      const o = this.orgs.get(m[1]!);
      if (!o) return json({ message: "Not Found" }, 404);
      if (!m[2] && method === "GET") return json(u.searchParams.get("page") && u.searchParams.get("page") !== "1" ? [] : [...o.public].map((login) => ({ login })));
      const who = m[2]!.toLowerCase();
      if (method === "GET") return o.public.has(who) ? new Response(null, { status: 204 }) : json({ message: "Not Found" }, 404);
      if (method === "PUT") {
        // GitHub: a user can publicize only their own membership
        if (!me || me.login.toLowerCase() !== who || o.members.get(who)?.state !== "active" || !can(["admin:org", "write:org"])) return json({ message: "Forbidden" }, 403);
        o.public.add(who);
        return new Response(null, { status: 204 });
      }
    }
    if ((m = /^\/users\/([^/]+)\/repos$/.exec(p)) && method === "GET") {
      const dir = join(this.root, m[1]!);
      if (!existsSync(dir) || (u.searchParams.get("page") ?? "1") !== "1") return json([]);
      return json(readdirSync(dir).filter((n) => n.endsWith(".git")).map((n) => {
        const full = `${m![1]}/${n.slice(0, -4)}`;
        return { name: n.slice(0, -4), full_name: full, fork: this.forks.has(full), owner: { login: m![1] } };
      }));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/transfer$/.exec(p)) && method === "POST" && me) {
      const from = `${m[1]}/${m[2]}`;
      const to = `${JSON.parse(String(init?.body ?? "{}")).new_owner}/${m[2]}`;
      if (me.login !== m[1] || !existsSync(this.bare(from))) return json({ message: "Not Found" }, 404);
      if (existsSync(this.bare(to))) return json({ message: "Repository already exists" }, 422);
      mkdirSync(dirname(this.bare(to)), { recursive: true });
      renameSync(this.bare(from), this.bare(to));
      const parent = this.forks.get(from);
      if (parent) (this.forks.delete(from), this.forks.set(to, parent));
      this.defaults.set(to, this.defaults.get(from) ?? "main");
      this.moved.set(from, to);
      return json({ full_name: from }, 202);
    }
    if ((m = /^\/orgs\/([^/]+)\/repos$/.exec(p)) && method === "POST" && me) {
      const name = JSON.parse(String(init?.body ?? "{}")).name;
      const full = `${m[1]}/${name}`;
      mkdirSync(dirname(this.bare(full)), { recursive: true });
      spawnSync("git", ["init", "-q", "--bare", "-b", "main", this.bare(full)]);
      this.defaults.set(full, "main");
      return json({ full_name: full, default_branch: "main" }, 201);
    }
    // a transferred repository: GitHub redirects the old name (API and git)
    if ((m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p)) && this.moved.has(m[1]!)) {
      return this.fetch(url.replace(`/repos/${m[1]}`, `/repos/${this.moved.get(m[1]!)}`), init);
    }
    return this.base(url, init);
  };
  readonly moved = new Map<string, string>();
}
