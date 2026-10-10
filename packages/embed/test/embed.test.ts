import { describe, expect, test } from "bun:test";
import { buildCards, LineageClient, pickSession, resolveBases, soulFrom, type SessionSummary, type TokenSummary } from "../src/client.ts";
import { cardHtml, describeEvent, extLink, howSteps, linkFor, statsHtml, timelineLayout, tokenHeadHtml } from "../src/render.ts";
import { answer, complete, didYouMean, editDistance, FACTS, run, type TermEnv } from "../src/terminal.ts";
import { dither, thumbModel } from "../src/thumb.ts";

const tok = (o: Partial<TokenSummary>): TokenSummary =>
  ({ mint: "M1", agent: "A1", name: "TEST minbpe author", symbol: "TMBPE", phase: "curve", migrated: false, price: 0.05, market_cap: 5_000_000, volume_24h: 0, volume_24h_base: 0, trades_24h: 0, change_24h: null, curve_progress: 0.25, quote_reserve: 1, migration_threshold: 4, holders: 3, trades: 2, last_trade_at: null, created_at: 1_791_500_000, launcher: "L", repo_url: "https://github.com/karpathy/minbpe", state_at: null, ...o }) as TokenSummary;
const sess = (o: Partial<SessionSummary>): SessionSummary =>
  ({ session_id: "s1", state: "final", open: true, agent: "A1", lineage_id: "L1", recipe_name: "minbpe", class: "python", repo: "https://github.com/karpathy/minbpe", commit: "c", gen_id: "g", height: 1, proposer: "anthropic", started_at: 1, last_at: 2, ended_at: 3, events: 5, candidate: null, ...o }) as SessionSummary;

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(routes[key]), { headers: { "content-type": "application/json" } });
  };
}

describe("client", () => {
  test("bases from a site origin, and overrides", () => {
    expect(resolveBases({ api: "https://site.example/" }, "x")).toEqual({ core: "https://site.example/api", market: "https://site.example/market", events: "https://site.example/live/events", site: "https://site.example" });
    expect(resolveBases({ core: "http://127.0.0.1:9660/v1" }, "http://h").core).toBe("http://127.0.0.1:9660/v1");
  });

  test("cards: indexer name and ticker, tagline only from a soul, state from sessions", () => {
    const souls = new Map([["A1", soulFrom({ agent: "A1", digest: "d", seq: 1, doc: { persona: { name: "Bea", tagline: "Shaves cycles off tokenizers." } } })], ["A2", null]]);
    const cards = buildCards([tok({}), tok({ mint: "M2", agent: "A2", symbol: "TGRAD", phase: "graduated" })], souls, [sess({ state: "live", events: 3 }), sess({ session_id: "s0", events: 9 })]);
    expect(cards[0]).toMatchObject({ symbol: "TMBPE", name: "TEST minbpe author", tagline: "Shaves cycles off tokenizers.", state: "working" });
    expect(cards[0]!.session!.session_id).toBe("s1");
    expect(cards[1]).toMatchObject({ tagline: null, state: "graduated", session: null });
  });

  test("sessions that did not load make no claim about the agent's work", () => {
    const [c] = buildCards([tok({})], new Map(), null);
    expect(c).toMatchObject({ state: "unknown", sessions_known: false, session: null });
    expect(cardHtml(c!, { href: "#", look: "plain" })).toContain("Sessions did not load");
    expect(cardHtml(c!, { href: "#", look: "plain" })).not.toContain("No authoring session yet");
  });

  test("a transient 502 is retried", async () => {
    let n = 0;
    const c = new LineageClient(resolveBases({ api: "https://s" }, ""), async () =>
      ++n < 3 ? new Response("bad gateway", { status: 502 }) : new Response(JSON.stringify({ generations: 1 }), { headers: { "content-type": "application/json" } }),
    );
    c.retryDelays = [0, 0];
    expect(await c.core<any>("stats")).toEqual({ generations: 1 });
    expect(n).toBe(3);
    let m = 0;
    const d = new LineageClient(resolveBases({ api: "https://s" }, ""), async () => {
      if (++m < 2) throw new TypeError("Failed to fetch");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    d.retryDelays = [0];
    expect(await d.core<any>("stats")).toEqual({});
  });

  test("pickSession prefers live with events, skips empty ones", () => {
    expect(pickSession([sess({ session_id: "a", events: 0, state: "ended" }), sess({ session_id: "b", events: 4 })])!.session_id).toBe("b");
    expect(pickSession([sess({ session_id: "a", events: 2 }), sess({ session_id: "b", events: 4, state: "live" })])!.session_id).toBe("b");
    expect(pickSession([])).toBeNull();
  });

  test("a missing soul is null through the dashboard (no 404) and directly", async () => {
    const seen: string[] = [];
    const viaWeb = new LineageClient(resolveBases({ api: "https://s" }, ""), fakeFetch({ "agents/A1/soul?optional=1": { _miss: { status: 404 } } }, seen));
    expect(await viaWeb.soul("A1")).toBeNull();
    expect(seen[0]).toBe("https://s/api/agents/A1/soul?optional=1");
    const direct = new LineageClient(resolveBases({ api: "https://s", core: "http://c/v1" }, ""), fakeFetch({}));
    expect(await direct.soul("A1")).toBeNull();
  });

  test("stats: every figure from the API, null when unreadable", async () => {
    const c = new LineageClient(
      resolveBases({ api: "https://s" }, ""),
      fakeFetch({
        "/api/stats": { generations: 20, candidates: 82 },
        "/market/tokens?sort=newest": { tokens: [tok({ volume_24h: 12.5 }), tok({ mint: "M2", agent: "A2", phase: "graduated", volume_24h: 2 })] },
        "sessions?state=live&limit=500": [sess({ state: "live" }), sess({ session_id: "s2", state: "live" }), sess({ session_id: "s3", state: "live", agent: "A2" })],
      }),
    );
    const st = await c.stats();
    expect(st).toEqual({ tokens: 2, graduated: 1, agents_working: 2, generations: 20, candidates: 82, volume_24h: 14.5, sessions_live: 3 });
    expect(Object.keys(st).some((k) => /fee/.test(k))).toBe(false);
    const down = new LineageClient(resolveBases({ api: "https://s" }, ""), fakeFetch({}));
    down.retryDelays = [];
    const s = await down.stats();
    expect(s.tokens).toBeNull();
    expect(s.generations).toBeNull();
    expect(s.volume_24h).toBeNull();
  });
});

describe("render", () => {
  const card = buildCards([tok({ name: "<b>x</b>" })], new Map(), [])[0]!;
  test("card: ticker, name escaped, no description without a soul, tLINE only", () => {
    const h = cardHtml(card, { href: "https://s/tokens/M1", look: "dither" });
    expect(h).toContain("TMBPE");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).not.toContain('part="description"');
    expect(h).toContain("5,000,000");
    expect(h).toContain("tLINE");
    expect(h).not.toMatch(/\$|USD|\u2014/);
    expect(h).toContain("karpathy/minbpe");
    expect(cardHtml({ ...card, tagline: "Faster BPE." }, { href: "#", look: "plain" })).toContain('<p class="tag" part="description">Faster BPE.</p>');
  });
  test("card: only price, market cap, 24h volume, 24h change and what the agent is building; no fees", () => {
    const b = { repo: "https://github.com/karpathy/minbpe", live: false, session_id: "s9", file: null, last: { gen_id: "g", lineage_id: "l", metric: "encode_ir", ratio: 0.9, fixed: null, at: null } };
    const h = cardHtml({ ...card, price: 0.05, volume_24h: 120, change_24h: 0.1, building: b }, { href: "#", look: "plain", sessionHref: (id) => `https://s/sessions/${id}` });
    const labels = [...h.matchAll(/<div><span>([^<]+)<\/span><b>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Price", "Market cap", "24h volume", "24h change"]);
    expect(h).toContain("Last improvement: <b>encode_ir -10%</b>");
    expect(h).toContain('href="https://s/sessions/s9"');
    expect(h).toContain('target="_blank"');
    expect(h).not.toMatch(/fee|compute vault|treasury|split/i);
  });
  test("token header: the four figures, no holders count, no compute vault, no fees", () => {
    const t = { ...tok({ volume_24h: 3, change_24h: -0.02 }), compute_vault: { balance: 9 }, pools: { damm_pool: null }, fees: { to_compute: 1 } } as any;
    const h = tokenHeadHtml(t, null, "#");
    const labels = [...h.matchAll(/<div><span>([^<]+)<\/span><b>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Price", "Market cap", "24h volume", "24h change"]);
    expect(h).not.toMatch(/fee|compute vault|treasury|holders/i);
  });
  test("figures that do not exist render as TBA", () => {
    expect(cardHtml({ ...card, market_cap: null, curve_progress: null }, { href: "#", look: "plain" })).toContain("TBA");
    expect(statsHtml({ tokens: null, graduated: null, agents_working: 0, generations: 3, candidates: null, volume_24h: null, sessions_live: 0 })).toMatch(/TBA[\s\S]*>0<[\s\S]*>3</);
  });
  test("link template", () => {
    expect(linkFor("/coin/{mint}?t={symbol}", "https://s", { mint: "M1", agent: "A", symbol: "TX" })).toBe("/coin/M1?t=TX");
    expect(linkFor(null, "https://s", { mint: "M1", agent: "A", symbol: null })).toBe("https://s/tokens/M1");
  });
  test("timeline: cards never overlap and keep launch order", () => {
    const t = [100, 100, 100 + 86400 * 3, 50];
    const { xs, width } = timelineLayout(t, { step: 200 });
    const order = t.map((v, i) => ({ v, x: xs[i]! })).sort((a, b) => a.x - b.x);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!.x - order[i - 1]!.x).toBeGreaterThanOrEqual(199);
      expect(order[i]!.v).toBeGreaterThanOrEqual(order[i - 1]!.v);
    }
    expect(width).toBeGreaterThan(Math.max(...xs));
  });
  test("how: six steps, each with a live figure", () => {
    const s = howSteps({ tokens: 34, graduated: 1, agents_working: 2, generations: 20, candidates: 82, volume_24h: null, sessions_live: 2 });
    expect(s).toHaveLength(6);
    expect(s.map((x) => x.figure!.value)).toEqual(["34", "TBA", "2", "82", "20", "1"]);
    expect(s.map((x) => x.figure!.label).join(" ")).not.toMatch(/fee/i);
  });
  test("event lines", () => {
    expect(describeEvent({ seq: 1, kind: "edit", at: 0, path: "a.py", start_line: 3, end_line: 5 })).toBe("Editing a.py, lines 3 to 5, text sealed until the verdict");
    expect(describeEvent({ seq: 1, kind: "read", at: 0, path: "a.py", start_line: 3 })).toBe("Reading a.py, line 3");
  });
});

describe("thumb", () => {
  test("model: lines around the latest file event, marks and label", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const m = thumbModel({ repo: "https://github.com/a/b", state: "live", event_list: [{ seq: 1, kind: "read", at: 0, path: "x.py", start_line: 10, end_line: 12 }, { seq: 2, kind: "phase", at: 1, phase: "build" }] }, text, 8);
    expect(m.file).toBe("x.py");
    expect(m.lines[0]!.n).toBe(7);
    expect(m.lines.filter((l) => l.mark === "hl").map((l) => l.n)).toEqual([10, 11, 12]);
    expect(m.lines[m.cursor]!.n).toBe(10);
    expect(m.caption).toBe("Sandbox: build");
    const sealed = thumbModel({ repo: null, state: "sealed", event_list: [{ seq: 1, kind: "edit", at: 0, path: "x.py", start_line: 2, end_line: 2 }] }, text);
    expect(sealed.lines.find((l) => l.n === 2)!.mark).toBe("sealed");
    expect(thumbModel({ repo: null, state: "ended", event_list: [] }, null).lines).toEqual([]);
    // the header names the file and lines for what they are (no drawn address bar)
    const u = thumbModel({ repo: "https://github.com/a/b.git", commit: "1acefe89412b", state: "final", event_list: [{ seq: 1, kind: "read", at: 0, path: "src/x.py", start_line: 3, end_line: 9 }] }, text);
    expect(u.label).toBe("src/x.py, lines 3 to 9, last read");
    expect((u as any).url).toBeUndefined();
  });
  test("dither maps every pixel into the palette", () => {
    const p = { bg: [10, 10, 10], fg: [240, 240, 240], muted: [128, 128, 128], accent: [255, 120, 40], panel: [30, 30, 30] } as any;
    const px = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) px.set(i < 8 ? [128, 128, 128, 255] : [250, 118, 44, 255], i * 4);
    dither(px, 4, 4, p);
    const colors = new Set<string>();
    for (let i = 0; i < 16; i++) colors.add(px.slice(i * 4, i * 4 + 3).join(","));
    for (const c of colors) expect(["10,10,10", "240,240,240", "255,120,40"]).toContain(c);
    expect(colors.has("255,120,40")).toBe(true);
  });
});

describe("terminal", () => {
  const env = (over: Partial<TermEnv["client"]> = {}, ours: string[] = []): TermEnv => ({
    client: {
      tokens: async () => [tok({}), tok({ mint: "M2", agent: "A2", symbol: "TGRAD", phase: "graduated", market_cap: null })],
      bySymbol: async (s) => (s.toUpperCase() === "TMBPE" ? tok({}) : null),
      soul: async () => null,
      sessions: async () => [{ state: "live", recipe_name: "minbpe", events: 4, agent: "A1" }],
      stats: async () => ({ tokens: 2, graduated: 1, agents_working: 1, generations: 20, candidates: 82, volume_24h: 3, sessions_live: 1 }),
      generation: async (id) => ({ gen_id: id, height: 4, effect: { metric: "encode_ir", ratio: 0.0927 }, replays: [{}, {}], accepted_at: 1, candidate_id: "cand1", entry_type: "patch" }),
      lineages: async () => [{ lineage_id: "l1", recipe_name: "minbpe", tip: "f".repeat(64), gen0: "0".repeat(64) }],
      ...over,
    },
    links: { tokens: "/tokens", ours: "/tokens?ours=1", launch: "/spawn", docs: "/docs", explorer: "/explorer", token: (m) => `/tokens/${m}`, site: "https://s" },
    ours,
  });

  test("did you mean, by edit distance", () => {
    expect(editDistance("tokns", "tokens")).toBe(1);
    expect(didYouMean("tokns")).toBe("tokens");
    expect(didYouMean("hlep")).toBe("help");
    expect(didYouMean("xyzzyq")).toBeNull();
  });
  test("unknown command says command not found with a suggestion", async () => {
    const o = await run("stat", env());
    expect(o.html.join("")).toContain("command not found: stat.");
    expect(o.html.join("")).toContain('data-run="stats"');
  });
  test("tab completion of commands and tickers", () => {
    expect(complete("wa").line).toBe("watch ");
    expect(complete("watch tm", ["TMBPE", "TGRAD"]).line).toBe("watch TMBPE");
    expect(complete("s").options).toEqual(["stats", "screen"]);
  });
  test("ask: keyword match, fixed answer, a suggested follow-up that is itself answerable", async () => {
    expect(answer("where do the fees go?")!.id).toBe("fees");
    expect(answer("what happens when it graduates")!.id).toBe("graduation");
    expect(answer("is it on mainnet")!.id).toBe("devnet");
    for (const f of FACTS) expect(answer(f.next)).not.toBeNull();
    const o = await run("ask how does verification work", env());
    expect(o.html.join("")).toContain("How is a change verified?");
    expect(o.html.join("")).toContain("ask What stops a verifier from lying?");
  });
  test("watch resolves a ticker to its agent", async () => {
    expect((await run("watch tmbpe", env())).watch).toEqual({ agent: "A1", label: "TMBPE" });
    expect((await run("watch nope", env())).watch).toBeUndefined();
  });
  test("tokens list is live rows with tLINE figures, TBA for missing ones", async () => {
    const h = (await run("tokens", env())).html.join("");
    expect(h).toContain("5,000,000 tLINE");
    expect(h).toContain("TBA tLINE");
  });
  test("stats and agent: no fee rows; agent shows the five token parameters", async () => {
    const st = (await run("stats", env())).html.join("");
    expect(st).toContain("24h volume, all tokens");
    expect(st).not.toMatch(/fee/i);
    const a = (await run("agent tmbpe", env())).html.join("");
    for (const k of ["Price", "Market cap", "24h volume", "24h change", "Building"]) expect(a).toContain(`>${k}<`);
    expect(a).not.toMatch(/fee|Phase/i);
  });
  test("ours: none configured says so; configured lists them", async () => {
    expect((await run("ours", env())).html.join("")).toContain("No official tokens are configured");
    expect((await run("ours", env({}, ["M2"]))).html.join("")).toContain("TGRAD");
  });
  test("how starts the step-through; verify by recipe name; navigation commands", async () => {
    expect((await run("how", env())).how).toBe(0);
    const v = (await run("verify minbpe", env())).html.join("");
    expect(v).toContain("encode_ir ratio 0.0927");
    expect(v).toContain("bun scripts/verify.ts --core https://s --candidate cand1");
    expect((await run("explorer TMBPE", env())).nav).toBe("/explorer?q=TMBPE");
    expect((await run("launch", env())).nav).toBe("/spawn");
    expect((await run("screen green", env())).tube).toBeTruthy();
  });
  test("no em dashes in any text the kit ships", async () => {
    const all = JSON.stringify(FACTS) + (await run("help", env())).html.join("");
    expect(all).not.toContain("\u2014");
  });
});

// Audit A2 OFF-E1, OFF-E2: no data-driven URL becomes a non-http(s) href or data source.
describe("audit: URL schemes", () => {
  test("resolveBases ignores javascript:, data: and relative overrides and keeps the fallback origin", () => {
    for (const evil of ["javascript:alert(1)//", "data:text/html,x", "//evil.example", "vbscript:x", " javascript:alert(1)"]) {
      const b = resolveBases({ api: evil, core: evil, market: evil, events: evil, site: evil }, "https://site.example");
      expect(b).toEqual({ core: "https://site.example/api", market: "https://site.example/market", events: "https://site.example/live/events", site: "https://site.example" });
    }
    expect(resolveBases({ api: "https://other.example/" }, "https://site.example").site).toBe("https://other.example");
    expect(resolveBases({ core: "http://127.0.0.1:9660/v1" }, "https://site.example").core).toBe("http://127.0.0.1:9660/v1");
  });
  test("a repository URL that is not http(s) is shown as text, never as an href", () => {
    expect(extLink("javascript:alert(1)", "x")).not.toContain("href");
    expect(extLink("https://github.com/a/b", "a/b")).toContain('href="https://github.com/a/b"');
    const t = { ...tok({ repo_url: "javascript:alert(document.domain)" }), compute_vault: { balance: "0" }, pools: { damm_pool: null } } as any;
    expect(tokenHeadHtml(t, null, "https://site.example/tokens/M1")).not.toContain('href="javascript:');
  });
});

