// Shared by the headless checks of the Bounties pages (scripts/bounties/*.proof.ts): a free port of
// this repository's test block, a Wallet Standard test wallet that really signs messages and
// refuses every transaction, and the page's own rules (no monospace, no em dash, no sideways scroll).
import { execFileSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import { signBytes, type Signer } from "@units/chain";

export const WALLET_NAME = "units Test Wallet";
/** The first port of 9666, 9668, 9669, 9663 nobody listens on (never 9662 or 9664). */
export function freePort(): number {
  for (const p of [9666, 9668, 9669, 9663]) {
    let pid = "";
    try { pid = execFileSync("lsof", ["-nP", "-t", `-iTCP:${p}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(); } catch { /* free */ }
    if (!pid) return p;
  }
  throw new Error("no free port among 9666, 9668, 9669, 9663");
}

export async function testWallet(ctx: BrowserContext, wallet: Signer, log: string[] = []) {
  await ctx.exposeFunction("__unitsSignMsg", (b64: string) => { log.push("signMessage"); return Buffer.from(signBytes(wallet, new Uint8Array(Buffer.from(b64, "base64")))).toString("base64"); });
  await ctx.exposeFunction("__unitsRefusedTx", () => { log.push("signTransaction refused"); });
  await ctx.addInitScript(({ address, pub, name }: { address: string; pub: number[]; name: string }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet", "solana:mainnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "test" };
    const w: any = {
      version: "1.0.0", name, chains: ["solana:devnet", "solana:mainnet"], accounts: [] as unknown[],
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async () => { await (window as any).__unitsRefusedTx(); throw new Error("this check sends no transaction"); } },
        "solana:signMessage": { version: "1.0.0",
          signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__unitsSignMsg(b64(i.message))) }))) },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
    try { localStorage.setItem("lineage-wallet", name); } catch { /* the page connects by hand */ }
  }, { address: wallet.id, pub: Array.from(wallet.secret.subarray(32)), name: WALLET_NAME });
}

/** The page's own rules on what is rendered under `sel`. */
export async function pageRules(page: Page, sel: string) {
  return page.evaluate((s) => {
    const root = document.querySelector(s)!;
    const mono = [...root.querySelectorAll("*")].filter((e) => /mono|courier|menlo|consolas/i.test(getComputedStyle(e).fontFamily)).map((e) => e.className || e.tagName).slice(0, 5);
    const text = (root as HTMLElement).innerText;
    return { mono, emDash: text.includes(String.fromCharCode(0x2014)), wide: document.documentElement.scrollWidth > window.innerWidth + 1, text,
      status: /devnet|testnet|\bmock\b|not open yet|coming soon|\bbeta\b|\bTBA\b/i.exec(text)?.[0] ?? null };
  }, sel);
}
export const CLEAN = { mono: [], emDash: false, wide: false, status: null };
