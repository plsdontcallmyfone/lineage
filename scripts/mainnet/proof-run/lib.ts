// Shared pieces of the mainnet proof run of 2026-10-13 (owner: "yes run mainnet proof"): the record file, the
// keyed RPC (never printed), the one key that may sign (the throwaway test launcher) and a headless page
// whose Wallet Standard wallet signs with that key AFTER this process simulated the transaction and the
// caller's guard accepted its cost. Headless Chromium only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadKeypair, Rpc, signBytes } from "@units/chain";
import { decodeMessage, parseWire, placeSignature } from "../../../packages/chain/src/browser/wire.ts";
import { applyNetworkProfile, rpcUrlFor, stateFor } from "../../../packages/chain/src/profile-node.ts";

export const ROOT = join(import.meta.dir, "..", "..", "..");
export const RECORD = join(ROOT, "scripts/mainnet/PROOF-RUN-2026-10-13.json");
export const SITE = (process.env.PROOF_SITE ?? "https://main-157-245-71-188.sslip.io").replace(/\/+$/, "");
export const KEY = join(homedir(), ".config/units/mainnet-test/launch-keys/launcher.json");
export const WALLET = "8ZZsG4yHY4BFyoEo1F9QGAwo562LTU4RaoutXq5MAwkh";
export const SHOTS = process.env.PROOF_SHOTS ?? join(ROOT, "work", "proof-run-2026-10-13");
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
export const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

export function record(): Record<string, any> {
  return existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : { run: "mainnet proof run 2026-10-13", site: SITE, wallet: WALLET, steps: {}, defects: [] };
}
export function saveStep(step: string, patch: Record<string, unknown>) {
  const r = record();
  r.steps[step] = { ...(r.steps[step] ?? {}), ...patch, at: new Date().toISOString() };
  writeFileSync(RECORD, JSON.stringify(r, null, 2) + "\n");
}

export async function chain() {
  const profile = applyNetworkProfile();
  const state = stateFor(profile) as Record<string, any> | null;
  if (profile.network !== "mainnet" || !state || state.test === true) throw new Error("the active profile is not the official mainnet deployment");
  const rpc = Rpc.http(rpcUrlFor(profile), "confirmed");
  if ((await rpc.call<string>("getGenesisHash")) !== MAINNET_GENESIS) throw new Error("the RPC endpoint is not mainnet");
  const wallet = loadKeypair(KEY);
  if (wallet.id !== WALLET) throw new Error("the key file is not the test launcher");
  return { profile, state, rpc, wallet };
}

export const j = async (p: string) => {
  const r = await fetch(`${SITE}${p}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!r) return { status: 0, body: null as any };
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

/** Simulates an unsigned or signed wire (signatures not verified, its own blockhash replaced) and returns the wallet's lamport change. */
export async function simulateFor(rpc: Rpc, b64: string, watch: string[]) {
  const v = (await rpc.call<any>("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: watch } }])).value;
  return v as { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts: ({ lamports: number; data: [string, string]; owner: string } | null)[] | null };
}

export interface SignAsk { index: number; b64: string; bytes: number; version: string; programs: string[]; sim_err: unknown; sim_logs_tail: string[]; units: number | null; wallet_delta_lamports: string | null }

/**
 * A headless page on the live site with a wallet that signs with the test key. Every transaction the page hands the
 * wallet is simulated HERE first (unless `noSim`, for batches whose later transactions need the earlier ones); `guard`
 * sees the simulations and returns a reason to refuse or null. With send false the wallet refuses everything.
 */
export async function openPage(o: { send: boolean; guard: (asks: SignAsk[]) => string | null | Promise<string | null>; noSim?: boolean }) {
  const { rpc, wallet } = await chain();
  mkdirSync(SHOTS, { recursive: true });
  const pw = await import(join(ROOT, "node_modules/.bun/playwright-core@1.63.0/node_modules/playwright-core/index.mjs"));
  const exe = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  const browser = await pw.chromium.launch({ headless: true, ...(existsSync(exe) ? { executablePath: exe } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const requests: { asks: SignAsk[]; refused: string | null; at: string }[] = [];
  const messages: string[] = [];
  await ctx.exposeFunction("__proofSignAll", async (b64s: string[]) => {
    const before = await rpc.getBalance(wallet.id);
    const asks: SignAsk[] = [];
    for (const [index, b64] of b64s.entries()) {
      const wire = new Uint8Array(Buffer.from(b64, "base64"));
      const d = decodeMessage(parseWire(wire).message);
      const sim = o.noSim ? null : await simulateFor(rpc, b64, [wallet.id]).catch((e) => ({ err: `simulate failed: ${(e as Error).message.slice(0, 200)}`, logs: null, accounts: null } as any));
      asks.push({ index, b64, bytes: wire.length, version: String(d.version), programs: [...new Set(d.instructions.map((i: any) => i.programId as string))], sim_err: sim ? sim.err : "not simulated",
        sim_logs_tail: (sim?.logs ?? []).slice(-6), units: sim?.unitsConsumed ?? null, wallet_delta_lamports: sim?.accounts?.[0] ? (BigInt(sim.accounts[0].lamports) - before).toString() : null });
    }
    let refused = !o.send ? "dry run: the wallet refuses every transaction" : null;
    if (!refused && !o.noSim && asks.some((a) => a.sim_err)) refused = `simulation failed: ${JSON.stringify(asks.find((a) => a.sim_err)!.sim_err).slice(0, 200)}`;
    if (!refused) refused = await o.guard(asks);
    requests.push({ asks, refused, at: new Date().toISOString() });
    if (refused) throw new Error(refused);
    return b64s.map((b64) => {
      const wire = new Uint8Array(Buffer.from(b64, "base64"));
      return Buffer.from(placeSignature(wire, wallet.id, signBytes(wallet, parseWire(wire).message))).toString("base64");
    });
  });
  await ctx.exposeFunction("__proofSignMsg", (b64: string) => {
    messages.push(Buffer.from(b64, "base64").toString("utf8").slice(0, 400));
    return Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64");
  });
  await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    try { localStorage.setItem("units-wallet", "units Test Wallet"); } catch {}
    const chains = ["solana:mainnet"];
    const account = { address, publicKey: new Uint8Array(pub), chains, features: ["solana:signTransaction", "solana:signMessage"], label: "test" };
    const w = {
      version: "1.0.0", name: "units Test Wallet", chains, accounts: [] as unknown[],
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
            ((await (window as any).__proofSignAll(inputs.map((i) => b64(i.transaction)))) as string[]).map((s) => ({ signedTransaction: unb64(s) })) },
        "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__proofSignMsg(b64(i.message))) }))) },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message.slice(0, 300)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(`console: ${String(m.text()).slice(0, 300)}`); });
  const sends: { at: string; method: string; status: number; result: string }[] = [];
  page.on("response", async (r: any) => {
    try {
      if (!r.url().endsWith("/chain/rpc") || r.request().method() !== "POST") return;
      const body = JSON.parse(r.request().postData() ?? "{}");
      if (!["sendBundle", "sendTransaction"].includes(body.method)) return;
      sends.push({ at: new Date().toISOString(), method: body.method, status: r.status(), result: (await r.text().catch(() => "")).slice(0, 400) });
    } catch {}
  });
  const shot = (n: string) => page.screenshot({ path: join(SHOTS, `${n}.png`), fullPage: true }).catch(() => {});
  const text = async (sel: string) => ((await page.locator(sel).first().innerText().catch(() => "")) as string).replace(/\s+/g, " ").trim();
  const connected = () => page.locator("#cn-btn.on").waitFor({ timeout: 60_000 });
  return { browser, page, requests, messages, errors, sends, shot, text, connected, rpc, wallet };
}
