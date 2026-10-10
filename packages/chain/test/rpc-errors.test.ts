// RPC answers of every shape become readable errors (the Profile once showed "getMultipleAccounts:
// undefined" for the site gate's 429 body `{error: "rate_limited", message}`), and busy reads are
// retried with backoff, honouring Retry-After. The wallet page uses the same transport on /chain/rpc.
import { describe, expect, test } from "bun:test";
import { BUSY_MESSAGE, httpTransport, retryDelayMs, rpcErrorOf, RpcError } from "../src/rpc.ts";

const GATE_429 = { error: "rate_limited", message: "too many requests from this address; slow down" };

describe("rpcErrorOf", () => {
  test("the gate's 429 body (string error, top-level message) is readable", () => {
    const e = rpcErrorOf("getMultipleAccounts", 429, GATE_429)!;
    expect(e.message).toBe(`getMultipleAccounts: ${BUSY_MESSAGE}`);
    expect(e.message).not.toContain("undefined");
    expect(e.code).toBe(429);
  });
  test("a string error with a message on any status", () => {
    expect(rpcErrorOf("getSlot", 403, { error: "forbidden", message: "same origin only" })!.message).toBe("getSlot: same origin only");
    expect(rpcErrorOf("getSlot", 400, { error: "bad_request" })!.message).toBe("getSlot: bad_request");
  });
  test("the standard JSON-RPC error keeps message, code and data", () => {
    const e = rpcErrorOf("sendTransaction", 200, { jsonrpc: "2.0", error: { code: -32002, message: "preflight failed", data: { logs: ["x"] } } })!;
    expect([e.message, e.code, e.data]).toEqual(["sendTransaction: preflight failed", -32002, { logs: ["x"] }]);
    expect(rpcErrorOf("m", 200, { error: { code: -1 } })!.message).toBe("m: RPC error -1");
  });
  test("no body, a bare message, a missing result; a result is not an error", () => {
    expect(rpcErrorOf("m", 502, null)!.message).toBe("m: HTTP 502");
    expect(rpcErrorOf("m", 500, { message: "upstream down" })!.message).toBe("m: upstream down");
    expect(rpcErrorOf("m", 200, { jsonrpc: "2.0" })!.message).toBe("m: no result in the answer");
    expect(rpcErrorOf("m", 200, { jsonrpc: "2.0", result: null })).toBeNull();
  });
  test("retry delay: Retry-After when given (capped), else exponential", () => {
    expect([1, 2, 3, 6].map((a) => retryDelayMs(a, null))).toEqual([400, 800, 1600, 8000]);
    expect(retryDelayMs(1, "2")).toBe(2000);
    expect(retryDelayMs(1, "60")).toBe(8000);
    expect(retryDelayMs(2, "soon")).toBe(800);
  });
});

function scripted(answers: { status: number; body: unknown; retryAfter?: string }[]) {
  let i = 0;
  const f = (async () => {
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return new Response(a.body === undefined ? "not json" : JSON.stringify(a.body), { status: a.status, headers: a.retryAfter ? { "retry-after": a.retryAfter } : {} });
  }) as unknown as typeof fetch;
  return { f, calls: () => i };
}

describe("httpTransport", () => {
  test("429s from the gate are retried with backoff, then the read goes through", async () => {
    const s = scripted([{ status: 429, body: GATE_429, retryAfter: "1" }, { status: 429, body: GATE_429 }, { status: 200, body: { jsonrpc: "2.0", result: 42 } }]);
    const waits: number[] = [];
    const lines: string[] = [];
    const t = httpTransport("/chain/rpc", { fetch: s.f, sleep: async (ms) => void waits.push(ms), onRetry: (n, w) => lines.push(`retry ${n} in ${w}`) });
    expect(await t("getSlot", [])).toBe(42);
    expect(waits).toEqual([1000, 800]);
    expect(lines).toEqual(["retry 1 in 1000", "retry 2 in 800"]);
  });

  test("still busy after the retries: a readable error, not undefined", async () => {
    const s = scripted([{ status: 429, body: GATE_429 }]);
    const t = httpTransport("/chain/rpc", { fetch: s.f, retries: 3, sleep: async () => {} });
    const e = (await t("getMultipleAccounts", []).catch((x) => x)) as RpcError;
    expect(e).toBeInstanceOf(RpcError);
    expect(e.message).toBe(`getMultipleAccounts: ${BUSY_MESSAGE}`);
    expect(s.calls()).toBe(4);
  });

  test("5xx without JSON is retried; RPC-level errors are thrown at once", async () => {
    const s = scripted([{ status: 502, body: undefined }, { status: 200, body: { error: { code: -32601, message: "method not allowed here" } } }]);
    const t = httpTransport("/chain/rpc", { fetch: s.f, sleep: async () => {} });
    await expect(t("getFoo", [])).rejects.toThrow("getFoo: method not allowed here");
    expect(s.calls()).toBe(2);
  });

  test("a 4xx string error is thrown readable, without retrying", async () => {
    const s = scripted([{ status: 403, body: { error: "forbidden", message: "same origin only" } }]);
    const t = httpTransport("/chain/rpc", { fetch: s.f, sleep: async () => {} });
    await expect(t("sendTransaction", [])).rejects.toThrow("sendTransaction: same origin only");
    expect(s.calls()).toBe(1);
  });
});
