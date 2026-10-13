// A mock GitHub for the fee-claim flow (docs/plans/GITHUB-FEE-CLAIMS.md D6 and section 11): the
// three OAuth endpoints Core calls, the user lookups, gists, and repositories with the signed-in
// user's `permissions` (admin or not), by name, by numeric id and as the user's own list. Tests and a staging Core point
// UNITS_GITHUB_OAUTH_BASE and UNITS_GITHUB_API at it (with UNITS_GITHUB_OAUTH_MOCK=1) until the
// owner creates the real OAuth app. It signs nothing and proves nothing: Core marks its sessions
// "mock" and never accepts them on mainnet.
//
//   bun scripts/claims/mock-github.ts --port 9667 --user 583231:octocat [--user 9919:github]
//       [--repo 1296269:octocat/Hello-World:octocat]      (id:owner/name:admin[,admin])
//
// The authorize page signs in as ?login=<login> when given, else as the first user.

export interface MockUser {
  id: number;
  login: string;
  name?: string;
  /** "Organization" for an account that owns repositories and cannot sign in. */
  type?: "User" | "Organization";
}

export interface MockRepo {
  id: number;
  /** owner/name; the owner is one of the mock's users (a person or an organisation) */
  full_name: string;
  /** logins with admin on the repository (a personal owner is always one of them) */
  admins: string[];
  /** logins that can see it in their own list without admin (push only) */
  members?: string[];
  private?: boolean;
  /** earlier owner/name values: GitHub answers them with a redirect to the id */
  former?: string[];
}

export interface MockGithub {
  url: string;
  users: MockUser[];
  repos: MockRepo[];
  /** the `scope` parameter of every authorize request ("" when none was sent) */
  scopes: string[];
  gists: Map<string, { owner: string; content: string; public: boolean }>;
  /** Adds a public gist owned by `login` and returns its URL in github.com form. */
  addGist(login: string, content: string, opts?: { id?: string; public?: boolean }): string;
  calls: { authorize: number; token: number; user: number };
  /** every request made with a sign-in token, as "METHOD path" (what Core did while it held one) */
  tokenCalls: string[];
  /** access tokens the mock issued that are still valid (it never expires one) */
  issued(): number;
  stop(): void;
}

export function startMockGithub(opts: { port: number; users: MockUser[]; repos?: MockRepo[]; clientId?: string; clientSecret?: string }): MockGithub {
  const repos = opts.repos ?? [];
  const scopes: string[] = [];
  const tokenCalls: string[] = [];
  const codes = new Map<string, string>(); // code -> login
  const tokens = new Map<string, string>(); // access token -> login
  const gists = new Map<string, { owner: string; content: string; public: boolean }>();
  const calls = { authorize: 0, token: 0, user: 0 };
  const find = (login: string) => opts.users.find((u) => u.login.toLowerCase() === login.toLowerCase());
  const view = (u: MockUser) => ({ id: u.id, login: u.login, name: u.name ?? null, type: u.type ?? "User", avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4` });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const has = (list: string[] | undefined, login: string | undefined) => !!login && !!list?.some((x) => x.toLowerCase() === login.toLowerCase());
  /** A repository as GitHub returns it; `permissions` only for a signed-in user, as on github.com. */
  const repoView = (r: MockRepo, login: string | undefined) => {
    const owner = find(r.full_name.split("/")[0]!);
    const admin = has(r.admins, login) || (owner?.type !== "Organization" && owner?.login.toLowerCase() === login?.toLowerCase());
    return { id: r.id, name: r.full_name.split("/")[1], full_name: r.full_name, private: !!r.private, html_url: `https://github.com/${r.full_name}`,
      owner: owner ? view(owner) : { id: 0, login: r.full_name.split("/")[0], type: "User", avatar_url: null },
      ...(login ? { permissions: { admin, maintain: admin, push: admin || has(r.members, login), triage: admin || has(r.members, login), pull: true } } : {}) };
  };
  const rand = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/login/oauth/authorize") {
        calls.authorize++;
        scopes.push(u.searchParams.get("scope") ?? "");
        const user = find(u.searchParams.get("login") ?? opts.users[0]!.login);
        const redirect = u.searchParams.get("redirect_uri");
        if (!user || !redirect || (opts.clientId && u.searchParams.get("client_id") !== opts.clientId)) return json({ message: "bad authorize request" }, 400);
        const code = rand();
        codes.set(code, user.login);
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", u.searchParams.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }
      if (u.pathname === "/login/oauth/access_token" && req.method === "POST") {
        calls.token++;
        const b = (await req.json().catch(() => ({}))) as { code?: string; client_secret?: string };
        const login = b.code ? codes.get(b.code) : undefined;
        if (!login || (opts.clientSecret && b.client_secret !== opts.clientSecret)) return json({ error: "bad_verification_code" });
        codes.delete(b.code!); // a code works once
        const token = `mock_${rand()}`;
        tokens.set(token, login);
        return json({ access_token: token, token_type: "bearer", scope: "" });
      }
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const signedIn = tokens.get(bearer);
      if (signedIn) tokenCalls.push(`${req.method} ${u.pathname}`);
      if (bearer.startsWith("mock_") && !signedIn) return json({ message: "Bad credentials" }, 401);
      if (u.pathname === "/user") {
        calls.user++;
        const login = signedIn;
        const user = login ? find(login) : undefined;
        return user ? json(view(user)) : json({ message: "Bad credentials" }, 401);
      }
      let m = /^\/users\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const user = find(decodeURIComponent(m[1]!));
        return user ? json(view(user)) : json({ message: "Not Found" }, 404);
      }
      m = /^\/user\/(\d+)$/.exec(u.pathname);
      if (m) {
        const user = opts.users.find((x) => x.id === Number(m![1]));
        return user ? json(view(user)) : json({ message: "Not Found" }, 404);
      }
      // repositories: by name (a former name redirects to the id, as GitHub does after a rename or transfer), by id, and the signed-in user's list
      m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const name = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`.toLowerCase();
        const moved = repos.find((r) => r.former?.some((f) => f.toLowerCase() === name));
        if (moved) return new Response(null, { status: 301, headers: { location: `${api.url}/repositories/${moved.id}` } });
        const r = repos.find((x) => x.full_name.toLowerCase() === name);
        return r && (!r.private || has(r.admins, signedIn) || has(r.members, signedIn)) ? json(repoView(r, signedIn)) : json({ message: "Not Found" }, 404);
      }
      m = /^\/repositories\/(\d+)$/.exec(u.pathname);
      if (m) {
        const r = repos.find((x) => x.id === Number(m![1]));
        return r && (!r.private || has(r.admins, signedIn) || has(r.members, signedIn)) ? json(repoView(r, signedIn)) : json({ message: "Not Found" }, 404);
      }
      if (u.pathname === "/user/repos") {
        if (!signedIn) return json({ message: "Requires authentication" }, 401);
        const per = Number(u.searchParams.get("per_page") ?? 30), page = Number(u.searchParams.get("page") ?? 1);
        const mine = repos.filter((r) => !r.private && (has(r.admins, signedIn) || has(r.members, signedIn) || r.full_name.toLowerCase().startsWith(`${signedIn.toLowerCase()}/`)));
        return json(mine.slice((page - 1) * per, page * per).map((r) => repoView(r, signedIn)));
      }
      m = /^\/users\/([^/]+)\/repos$/.exec(u.pathname);
      if (m) {
        const per = Number(u.searchParams.get("per_page") ?? 30), page = Number(u.searchParams.get("page") ?? 1);
        const own = repos.filter((r) => !r.private && r.full_name.toLowerCase().startsWith(`${decodeURIComponent(m![1]!).toLowerCase()}/`));
        return json(own.slice((page - 1) * per, page * per).map((r) => repoView(r, undefined)));
      }
      m = /^\/gists\/([0-9a-f]+)$/.exec(u.pathname);
      if (m) {
        const g = gists.get(m[1]!);
        const owner = g ? find(g.owner) : undefined;
        if (!g || !owner) return json({ message: "Not Found" }, 404);
        return json({ id: m[1], public: g.public, owner: view(owner), files: { "units-fee-claim.md": { content: g.content, truncated: false } } });
      }
      if (u.pathname === "/mock/gists" && req.method === "POST") {
        const b = (await req.json()) as { login: string; content: string; id?: string };
        return json({ url: api.addGist(b.login, b.content, { id: b.id }) });
      }
      return json({ message: "Not Found" }, 404);
    },
  });
  const api: MockGithub = {
    url: `http://127.0.0.1:${server.port}`,
    users: opts.users,
    repos,
    scopes,
    gists,
    calls,
    tokenCalls,
    issued: () => tokens.size,
    addGist(login, content, o = {}) {
      const id = o.id ?? rand().slice(0, 32);
      gists.set(id, { owner: login, content, public: o.public ?? true });
      return `https://gist.github.com/${login}/${id}`;
    },
    stop: () => server.stop(true),
  };
  return api;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf("--port") + 1] ?? 9667);
  const users: MockUser[] = [];
  args.forEach((a, i) => {
    if (a === "--user") {
      const [id, login] = (args[i + 1] ?? "").split(":");
      if (id && login) users.push({ id: Number(id), login });
    }
  });
  if (!users.length) users.push({ id: 583231, login: "octocat", name: "The Octocat" });
  const repos: MockRepo[] = [];
  args.forEach((a, i) => {
    if (a === "--repo") {
      const [id, full, admins] = (args[i + 1] ?? "").split(":");
      if (id && full) repos.push({ id: Number(id), full_name: full, admins: (admins ?? "").split(",").filter(Boolean) });
    }
  });
  const m = startMockGithub({ port, users, repos });
  console.log(`mock GitHub on ${m.url}: ${users.map((u) => `${u.login} (${u.id})`).join(", ")}`);
}
