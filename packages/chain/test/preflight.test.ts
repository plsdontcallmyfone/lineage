// The launch page simulates nothing (owner 2026-10-12); the RPC node's own preflight refuses a
// transaction that would fail when it is first submitted (src/browser/client.ts sendWire).
import { describe, expect, test } from "bun:test";
import { PreflightRefused, preflightRefusal, sendWire } from "../src/browser/client.ts";
import { RpcError, type Rpc } from "../src/rpc.ts";

const WIRE = Uint8Array.from([1, ...new Uint8Array(64).fill(7), 1, 0, 0, 0]);

describe("preflight", () => {
  test("a -32002 answer is a refusal carrying the program error and the logs; anything else is not", () => {
    const r = preflightRefusal(new RpcError("sendTransaction: Transaction simulation failed", -32002, { err: { InstructionError: [2, { Custom: 1 }] }, logs: ["a", "b"] }));
    expect(r).toBeInstanceOf(PreflightRefused);
    expect(r!.unsent).toBe(true);
    expect(r!.logs).toEqual(["a", "b"]);
    expect(r!.message).toContain("was not sent and nothing was charged");
    expect(r!.message).not.toMatch(/simulat/i);
    expect(preflightRefusal(new RpcError("sendTransaction: busy", 429))).toBeNull();
    expect(preflightRefusal(new Error("network"))).toBeNull();
  });

  test("sendWire with preflight: the first submission asks for the node's check, and a refusal is thrown before anything is polled", async () => {
    const calls: { method: string; params: any[] }[] = [];
    const rpc = {
      commitment: "confirmed",
      call: async (method: string, params: any[]) => {
        calls.push({ method, params });
        throw new RpcError("sendTransaction: Transaction simulation failed", -32002, { err: "BlockhashNotFound", logs: [] });
      },
    } as unknown as Rpc;
    await expect(sendWire(rpc, WIRE, 100, undefined, { preflight: true })).rejects.toBeInstanceOf(PreflightRefused);
    expect(calls.length).toBe(1);
    expect(calls[0]!.params[1]).toMatchObject({ skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  });

  test("sendWire with preflight: once the node took it, it is confirmed as before and rebroadcasts skip the check", async () => {
    const calls: any[] = [];
    const rpc = {
      commitment: "confirmed",
      call: async (method: string, params: any[]) => (calls.push([method, params[1]]), "sig"),
      getSignatureStatuses: async () => [{ slot: 9, err: null, confirmationStatus: "confirmed" }],
      getTransaction: async () => ({ meta: { fee: 5000, logMessages: ["ok"] } }),
      getBlockHeight: async () => 1,
    } as unknown as Rpc;
    const c = await sendWire(rpc, WIRE, 100, undefined, { preflight: true });
    expect(c.err).toBeNull();
    expect(c.fee).toBe(5000);
    expect(calls.length).toBe(1);
    expect(calls[0][1].skipPreflight).toBe(false);
  });
});
