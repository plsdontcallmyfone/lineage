// Wallet Standard discovery and signing without a dependency (https://github.com/wallet-standard).
// Phantom, Solflare and Backpack register themselves through the `wallet-standard:register-wallet`
// event; the page announces itself with `wallet-standard:app-ready`. Only `standard:connect` and
// `solana:signTransaction` are used: the wallet signs, the page sends to devnet itself.

export interface StdAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
  label?: string;
}
export interface StdWallet {
  name: string;
  icon: string;
  version: string;
  chains: readonly string[];
  accounts: readonly StdAccount[];
  features: Record<string, any>;
}

export const DEVNET_CHAIN = "solana:devnet";
const wallets: StdWallet[] = [];
const listeners = new Set<() => void>();

const usable = (w: StdWallet) => !!w.features?.["standard:connect"] && !!w.features?.["solana:signTransaction"];

export function startDiscovery() {
  if ((window as any).__lineageWalletDiscovery) return;
  (window as any).__lineageWalletDiscovery = true;
  const api = {
    register(...ws: StdWallet[]) {
      for (const w of ws) if (usable(w) && !wallets.some((x) => x === w || x.name === w.name)) wallets.push(w);
      for (const l of listeners) l();
      return () => {
        for (const w of ws) {
          const i = wallets.indexOf(w);
          if (i >= 0) wallets.splice(i, 1);
        }
        for (const l of listeners) l();
      };
    },
  };
  window.addEventListener("wallet-standard:register-wallet", (e: any) => {
    try {
      e.detail(api);
    } catch {
      /* a wallet's callback threw; ignore it */
    }
  });
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    /* old browser */
  }
}

export const discovered = () => [...wallets];
export const onWallets = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Window providers that exist without a Wallet Standard registration (an outdated extension). */
export function legacyOnly(): string[] {
  const w = window as any;
  const out: string[] = [];
  if (w.phantom?.solana && !wallets.some((x) => /phantom/i.test(x.name))) out.push("Phantom");
  if (w.solflare && !wallets.some((x) => /solflare/i.test(x.name))) out.push("Solflare");
  if (w.backpack && !wallets.some((x) => /backpack/i.test(x.name))) out.push("Backpack");
  return out;
}

export async function connect(w: StdWallet, silent = false): Promise<StdAccount | null> {
  const r = await w.features["standard:connect"].connect(silent ? { silent: true } : undefined);
  const accounts: readonly StdAccount[] = r?.accounts ?? w.accounts;
  return accounts.find((a) => a.chains?.includes?.(DEVNET_CHAIN) || !a.chains?.length) ?? accounts[0] ?? null;
}

export async function disconnect(w: StdWallet) {
  await w.features["standard:disconnect"]?.disconnect?.().catch?.(() => undefined);
}

export function onChange(w: StdWallet, f: () => void): (() => void) | null {
  return w.features["standard:events"]?.on?.("change", f) ?? null;
}

/** The wallet signs `wire` (it may hold other signatures already) for devnet and returns the wire. */
export async function signTransaction(w: StdWallet, account: StdAccount, wire: Uint8Array): Promise<Uint8Array> {
  const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: wire, chain: DEVNET_CHAIN });
  if (!out?.signedTransaction) throw new Error("the wallet returned no signed transaction");
  return new Uint8Array(out.signedTransaction);
}

/** Whether the wallet signs version 0 transactions (Wallet Standard `supportedTransactionVersions`; plan C). */
export const signsV0 = (w: StdWallet): boolean => !!w.features?.["solana:signTransaction"]?.supportedTransactionVersions?.includes?.(0);
