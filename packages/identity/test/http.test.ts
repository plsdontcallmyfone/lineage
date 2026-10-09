import { describe, expect, test } from "bun:test";
import { handler, MAX_BODY, readCapped } from "../src/http.ts";

// The identity routes bypass the gate (they receive pasted GitHub tokens), so they bound their own input.
describe("identity http input bounds", () => {
  test("readCapped stops at the cap, with or without a content-length", async () => {
    expect(await readCapped(new Request("http://x/", { method: "POST", body: "a".repeat(10) }), 16)).toBe("a".repeat(10));
    expect(await readCapped(new Request("http://x/", { method: "POST", body: "a".repeat(17) }), 16)).toBeNull();
    let pulled = 0;
    const Stream = globalThis.ReadableStream as any; // untyped: keeps the DOM stream types out of this program
    const body = new Stream({
      pull(c: any) {
        pulled++;
        if (pulled > 1000) return c.close();
        c.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readCapped(new Request("http://x/", { method: "POST", body, duplex: "half" } as any), 4096)).toBeNull();
    expect(pulled).toBeLessThan(20); // stopped reading early, did not buffer the whole stream
  });

  test("an oversized body is 413 and an Origin of null is refused as cross-origin, never a 500", async () => {
    const svc = { checkToken: async () => ({ ok: true }) } as any;
    const h = handler(svc, () => {});
    const post = (body: string, headers: Record<string, string> = {}) =>
      h(new Request("https://site.test/identity/token/check", { method: "POST", body, headers: { "content-type": "application/json", host: "site.test", ...headers } }), "1.2.3.4");
    expect((await post("x".repeat(MAX_BODY + 1))).status).toBe(413);
    expect((await post("{}", { origin: "null" })).status).toBe(403);
    expect((await post("{}", { origin: "https://evil.test" })).status).toBe(403);
    expect((await post(JSON.stringify({ token: "t" }), { origin: "https://site.test" })).status).toBe(200);
  });
});
