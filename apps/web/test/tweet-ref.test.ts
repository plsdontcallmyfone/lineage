import { beforeEach, describe, expect, test } from "bun:test";
import { applyLaunchPrefill, readPrefill, reportTweetLaunch, showTweetOrigin, tweetOriginRow } from "../wallet/tweet-ref.ts";
import { originFor, originLine, readOrigin, resolveTweetLink } from "../src/tweet-origin.ts";

// Launch from a tweet (docs/plans/TWEET-LAUNCH.md 4): what the launch page takes from a reply bot's
// link, and the one request it makes after its launch landed.

const REF = "AAAAAAAAAAAAAAAAAAAAAA";
const store = new Map<string, string>();
(globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
beforeEach(() => store.clear());

function form(values: Record<string, string> = {}) {
  const fields: Record<string, { value: string; events: string[]; dispatchEvent(e: Event): boolean }> = {};
  for (const n of ["l_name", "l_symbol", "s_vibe"]) fields[n] = { value: values[n] ?? "", events: [], dispatchEvent(e) { this.events.push(e.type); return true; } };
  return { fields, root: { querySelector: (sel: string) => fields[/name="(\w+)"/.exec(sel)![1]!] ?? null } as unknown as ParentNode };
}

describe("launch page prefill", () => {
  test("name, ticker, vibe and the id are read with the wizard's rules; the ticker is never made from the name", () => {
    expect(readPrefill(`?repo=karpathy/minbpe&name=Fast+BPE&ticker=fbpe&vibe=patient&tl=${REF}`)).toEqual({ name: "Fast BPE", ticker: "FBPE", vibe: "patient", ref: REF });
    expect(readPrefill("?repo=a/b&name=Fast+BPE")).toEqual({ name: "Fast BPE", ticker: null, vibe: null, ref: null });
    expect(readPrefill(`?name=${"x".repeat(33)}&ticker=TOO-LONG&vibe=${"v".repeat(201)}&tl=short`)).toEqual({ name: null, ticker: null, vibe: null, ref: null });
    expect(readPrefill("?ticker=ABCDEFGHIJK")).toMatchObject({ ticker: null });
  });

  test("empty fields are filled as if typed, typed ones are left alone, and the id is kept for the tab with its repository", () => {
    const f = form({ l_symbol: "MINE" });
    applyLaunchPrefill(f.root, `?repo=https://github.com/Karpathy/minbpe&name=Fast+BPE&ticker=FBPE&tl=${REF}`);
    expect([f.fields.l_name!.value, f.fields.l_symbol!.value, f.fields.s_vibe!.value]).toEqual(["Fast BPE", "MINE", ""]);
    expect(f.fields.l_name!.events).toEqual(["input", "change"]);
    expect(f.fields.l_symbol!.events).toEqual([]);
    expect(JSON.parse(store.get("units.tweet_ref")!)).toEqual({ ref: REF, repo: "karpathy/minbpe" });
    // no id, nothing kept
    store.clear();
    applyLaunchPrefill(form().root, "?repo=a/b&name=X");
    expect(store.size).toBe(0);
  });
});

describe("handing the launch to Core", () => {
  const calls: { url: string; body: any }[] = [];
  const fetcher = (statuses: number[]) => (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const s = statuses.shift() ?? 200;
    if (s === 0) throw new Error("offline");
    return new Response("{}", { status: s });
  }) as unknown as typeof fetch;
  beforeEach(() => calls.splice(0));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("nothing is sent for a launch that did not come from a link, or on another repository", async () => {
    reportTweetLaunch("AGENT", "MINT", "https://github.com/karpathy/minbpe", { fetch: fetcher([]) });
    applyLaunchPrefill(form().root, `?repo=karpathy/minbpe&tl=${REF}`);
    reportTweetLaunch("AGENT", "MINT", "https://github.com/other/repo", { fetch: fetcher([]) });
    await wait(20);
    expect(calls).toEqual([]);
  });

  test("asks again while Core has not read the launch (404) or the network fails, stops when stored, and the id is used once", async () => {
    applyLaunchPrefill(form().root, `?repo=karpathy/minbpe&tl=${REF}`);
    reportTweetLaunch("AGENT", "MINT", "https://github.com/karpathy/minbpe.git", { fetch: fetcher([404, 0, 200]), every_ms: 5 });
    await wait(80);
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual({ url: "/api/tweet-launches", body: { ref: REF, agent: "AGENT", mint: "MINT" } });
    expect(store.size).toBe(0);
    reportTweetLaunch("AGENT2", "MINT2", "https://github.com/karpathy/minbpe", { fetch: fetcher([]) });
    await wait(20);
    expect(calls.length).toBe(3);
  });

  test("gives up after its time, and at once when Core refuses the id", async () => {
    applyLaunchPrefill(form().root, `?repo=a/b&tl=${REF}`);
    reportTweetLaunch("AGENT", "MINT", "https://github.com/a/b", { fetch: fetcher([404, 404, 404, 404, 404, 404, 404, 404]), every_ms: 5, for_ms: 12 });
    await wait(80);
    expect(calls.length).toBeLessThan(6);
    calls.splice(0);
    applyLaunchPrefill(form().root, `?repo=a/b&tl=${REF}`);
    reportTweetLaunch("AGENT", "MINT", "https://github.com/a/b", { fetch: fetcher([409]), every_ms: 5 });
    await wait(40);
    expect(calls.length).toBe(1);
    expect(store.size).toBe(0);
  });
});

// "Started from a tweet" (owner 2026-10-13): shown only for a link Core confirms, on the link's repository.
describe("the tweet a launch link answers", () => {
  const ORIGIN = { repo: "karpathy/minbpe", handle: "ann", tweet_url: "https://x.com/ann/status/1977000000000000001", under_handle: "bob" };
  const core = (answers: Record<string, { status: number; body?: unknown }>) => {
    const asked: string[] = [];
    const f = (async (url: any) => {
      asked.push(String(url));
      const a = answers[String(url)] ?? { status: 404, body: { error: "not_found" } };
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
    }) as unknown as typeof fetch;
    return { f, asked };
  };
  /** The two elements the line needs: the repository field and the line's own place above the form. */
  function page(repo: string) {
    const line = { innerHTML: "", hidden: true };
    const field = { value: repo, name: "l_repo" };
    const listeners: ((e: any) => void)[] = [];
    const root = { querySelector: (sel: string) => (sel === "#lz-origin" ? line : sel.includes("l_repo") ? field : null), addEventListener: (_: string, fn: (e: any) => void) => void listeners.push(fn) } as unknown as ParentNode;
    const type = (v: string) => { field.value = v; for (const l of listeners) l({ target: field }); };
    return { line, root, type };
  }

  test("Core's answer is shown only as a tweet of that handle on x.com; anything else is refused", () => {
    expect(readOrigin(ORIGIN)).toEqual(ORIGIN);
    expect(readOrigin({ ...ORIGIN, under_handle: "ANN", extra: "dropped" })).toEqual({ ...ORIGIN, under_handle: null });
    for (const bad of [
      null, "x", {}, { ...ORIGIN, tweet_url: "https://evil.example/ann/status/1" }, { ...ORIGIN, tweet_url: "https://x.com/someone_else/status/1977000000000000001" },
      { ...ORIGIN, tweet_url: "https://x.com/ann/status/1?x=<script>" }, { ...ORIGIN, tweet_url: "javascript:alert(1)" }, { ...ORIGIN, handle: "an n" }, { ...ORIGIN, handle: "<b>" }, { ...ORIGIN, repo: "not a repo" },
    ]) expect(readOrigin(bad)).toBeNull();
    expect(readOrigin({ ...ORIGIN, under_handle: "<img>" })).toEqual({ ...ORIGIN, under_handle: null });
  });

  test("the copy: the line above the form", () => {
    expect(originLine(ORIGIN).s).toBe('<p class="wl-fine" data-tweet-origin="line" style="margin:0 0 12px">Started from <a class="link" href="https://x.com/ann/status/1977000000000000001" target="_blank" rel="noopener nofollow ugc" data-tweet-origin-link>a tweet by @ann</a>, under a tweet by @bob.</p>');
    expect(originLine({ ...ORIGIN, under_handle: null }).s).toContain("a tweet by @ann</a>.</p>");
    for (const s of [originLine(ORIGIN).s]) expect(s).not.toMatch(/\u2014|devnet|test|mono/i);
  });

  test("a confirmed id on the form's repository shows the line and the Review row; the line follows the repository field", async () => {
    const { f, asked } = core({ [`/api/tweet-links/${REF}`]: { status: 200, body: { origin: ORIGIN } } });
    const p = page("https://github.com/Karpathy/minbpe");
    expect(await showTweetOrigin(p.root, REF, f)).toEqual(ORIGIN);
    expect(asked).toEqual([`/api/tweet-links/${REF}`]);
    expect(p.line.hidden).toBe(false);
    expect(p.line.innerHTML).toContain("Started from");
    expect(p.line.innerHTML).toContain('href="https://x.com/ann/status/1977000000000000001"');
    expect(tweetOriginRow(p.root).s).toContain('<span class="eyebrow">Started from</span>');
    expect(tweetOriginRow(p.root).s).toContain("A tweet by @ann</a>, under a tweet by @bob");
    // another repository typed: the tweet did not ask for that one
    p.type("https://github.com/other/repo");
    expect([p.line.hidden, p.line.innerHTML, tweetOriginRow(p.root).s]).toEqual([true, "", ""]);
    p.type("https://github.com/karpathy/minbpe.git");
    expect(p.line.hidden).toBe(false);
    expect(tweetOriginRow(p.root).s).not.toBe("");
  });

  test("nothing is shown for an id Core does not know, one past its time, a link whose repository is not Core's, a broken answer or Core away", async () => {
    const shown = async (repo: string, f: typeof fetch) => {
      const p = page(repo);
      await showTweetOrigin(p.root, REF, f);
      return [p.line.hidden, p.line.innerHTML, tweetOriginRow(p.root).s];
    };
    const nothing = [true, "", ""];
    expect(await shown("https://github.com/karpathy/minbpe", core({}).f)).toEqual(nothing);
    expect(await shown("https://github.com/karpathy/minbpe", core({ [`/api/tweet-links/${REF}`]: { status: 200, body: { origin: null } } }).f)).toEqual(nothing);
    expect(await shown("https://github.com/karpathy/minbpe", core({ [`/api/tweet-links/${REF}`]: { status: 404, body: { origin: ORIGIN } } }).f)).toEqual(nothing);
    // a real id pasted onto another repository's link
    expect(await shown("https://github.com/scam/coin", core({ [`/api/tweet-links/${REF}`]: { status: 200, body: { origin: ORIGIN } } }).f)).toEqual(nothing);
    expect(await shown("https://github.com/karpathy/minbpe", core({ [`/api/tweet-links/${REF}`]: { status: 200, body: { origin: { ...ORIGIN, tweet_url: "https://evil.example/x" } } } }).f)).toEqual(nothing);
    expect(await shown("https://github.com/karpathy/minbpe", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toEqual(nothing);
    expect(await resolveTweetLink("short", core({}).f)).toBeNull();
    expect(originFor(ORIGIN, "")).toBeNull();
    // a handle or a tweet in the address is never read
    const p = page("https://github.com/karpathy/minbpe");
    applyLaunchPrefill(form().root, `?repo=karpathy/minbpe&tl=${REF}&handle=elonmusk&tweet=https://x.com/elonmusk/status/1`);
    expect(tweetOriginRow(p.root).s).toBe("");
  });
});
