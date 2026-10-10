import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";

// A mock Wallet Standard wallet (https://github.com/wallet-standard) registered in the page, as
// apps/web/scripts/app-check.ts does. It connects and signs messages with a local key, and it REFUSES
// every transaction: the UI suite never signs or sends one. The key is the app-check test wallet
// (~/.config/lineage/devnet/app-launch-test.json, or UI_WALLET_KEY), which launched TLAMP and holds
// devnet tLINE; when it is absent (CI) a throwaway key is generated and the checks that need a funded
// launcher are skipped. The key never leaves this process and is never printed.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export interface TestWallet {
  address: string;
  publicKey: Uint8Array;
  /** true when this is the stored test wallet (funded, with launches); false for a throwaway key */
  stored: boolean;
  signMessage(msg: Uint8Array): Uint8Array;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

let cached: TestWallet | null = null;
export function testWallet(): TestWallet {
  if (cached) return cached;
  const path = process.env.UI_WALLET_KEY ?? join(homedir(), ".config", "lineage", "devnet", "app-launch-test.json");
  let seed: Buffer;
  let pub: Uint8Array;
  let stored = false;
  if (existsSync(path)) {
    const raw = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
    seed = Buffer.from(raw.subarray(0, 32));
    pub = raw.subarray(32, 64);
    stored = true;
  } else {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
    pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  }
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  cached = { address: base58(pub), publicKey: pub, stored, signMessage: (m) => new Uint8Array(sign(null, Buffer.from(m), key)) };
  return cached;
}

/** Registers the mock wallet in every page of the context (before any app script runs). */
export async function installMockWallet(ctx: BrowserContext, w: TestWallet, log: string[]) {
  await ctx.exposeFunction("__uiSignMsg", (b64: string) => {
    log.push("signMessage");
    return Buffer.from(w.signMessage(new Uint8Array(Buffer.from(b64, "base64")))).toString("base64");
  });
  await ctx.exposeFunction("__uiRefusedTx", () => {
    log.push("signTransaction refused");
  });
  await ctx.addInitScript(({ address, pub }: { address: string; pub: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const account = { address, publicKey: new Uint8Array(pub), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"], label: "ui test" };
    const w = {
      version: "1.0.0",
      name: "Lineage UI Test Wallet",
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      chains: ["solana:devnet"],
      accounts: [] as unknown[],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async () => {
            await (window as any).__uiRefusedTx();
            throw new Error("The UI test wallet never signs transactions.");
          },
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: async (...inputs: { message: Uint8Array }[]) =>
            Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await (window as any).__uiSignMsg(b64(i.message))) }))),
        },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: w.address, pub: Array.from(w.publicKey) });
}
