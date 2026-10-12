// A mock GitHub for the fee-claim flow (docs/plans/GITHUB-FEE-CLAIMS.md D6): the three OAuth
// endpoints Core calls, the user lookups, and gists. Tests and a staging Core point
// UNITS_GITHUB_OAUTH_BASE and UNITS_GITHUB_API at it (with UNITS_GITHUB_OAUTH_MOCK=1) until the
// owner creates the real OAuth app. It signs nothing and proves nothing: Core marks its sessions
// "mock" and never accepts them on mainnet.
//
//   bun scripts/claims/mock-github.ts --port 9667 --user 583231:octocat [--user 9919:github]
//
// The authorize page signs in as ?login=<login> when given, else as the first user.

export interface MockUser {
  id: number;
  login: string;
  name?: string;
}

export interface MockGithub {
  url: string;
  users: MockUser[];
  gists: Map<string, { owner: string; content: string; public: boolean }>;
  /** Adds a public gist owned by `login` and returns its URL in github.com form. */
  addGist(login: string, content: string, opts?: { id?: string; public?: boolean }): string;
  calls: { authorize: number; token: number; user: number };
  stop(): void;
}

export function startMockGithub(opts: { port: number; users: MockUser[]; clientId?: string; clientSecret?: string }): MockGithub {
  const codes = new Map<string, string>(); // code -> login
  const tokens = new Map<string, string>(); // access token -> login
  const gists = new Map<string, { owner: string; content: string; public: boolean }>();
  const calls = { authorize: 0, token: 0, user: 0 };
  const find = (login: string) => opts.users.find((u) => u.login.toLowerCase() === login.toLowerCase());
  const view = (u: MockUser) => ({ id: u.id, login: u.login, name: u.name ?? null, type: "User", avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4` });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const rand = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/login/oauth/authorize") {
        calls.authorize++;
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
      if (u.pathname === "/user") {
        calls.user++;
        const login = tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
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
    gists,
    calls,
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
  const m = startMockGithub({ port, users });
  console.log(`mock GitHub on ${m.url}: ${users.map((u) => `${u.login} (${u.id})`).join(", ")}`);
}
