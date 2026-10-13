import { beforeEach, describe, expect, test } from "bun:test";
import { applyLaunchPrefill, readPrefill, reportTweetLaunch } from "../wallet/tweet-ref.ts";

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
