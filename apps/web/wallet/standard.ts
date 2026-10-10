// Wallet Standard discovery, the one wallet session of the site, and signing, without a dependency
// (https://github.com/wallet-standard). Phantom, Solflare and Backpack register themselves through the
// `wallet-standard:register-wallet` event; the page announces itself with `wallet-standard:app-ready`.
// Only `standard:connect`, `solana:signTransaction` and `solana:signMessage` are used: the wallet
// signs, the page sends to devnet itself.
//
// Both bundles (the dashboard's /assets/app.js and the wallet bundle /assets/wallet.js) include this
// file, so its state lives on `window.__lineageWallet`: one list of wallets and one connection,
// whichever bundle loaded first. The header's Connect button owns the connection; the Launch wizard,
// Profile, the token page's trade box and the social buttons all read it and follow its changes. The
// chosen wallet's name is kept in localStorage ("lineage-wallet") and reconnected silently on load.

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
export interface Session {
  wallet: StdWallet | null;
  account: StdAccount | null;
  /** a silent reconnect is in flight */
  restoring: boolean;
  error: string | null;
}

export const DEVNET_CHAIN = "solana:devnet";
const KEY = "lineage-wallet";

interface Shared {
  started: boolean;
  wallets: StdWallet[];
  listeners: Set<() => void>;
  session: Session;
  sessionListeners: Set<(s: Session) => void>;
  unsubChange: (() => void) | null;
  triedRestore: boolean;
}
const G: Shared = ((window as any).__lineageWallet ??= {
  started: false,
  wallets: [],
  listeners: new Set(),
  session: { wallet: null, account: null, restoring: false, error: null },
  sessionListeners: new Set(),
  unsubChange: null,
  triedRestore: false,
} satisfies Shared);

const usable = (w: StdWallet) => !!w.features?.["standard:connect"] && !!w.features?.["solana:signTransaction"];

export function startDiscovery() {
  if (G.started) return;
  G.started = true;
  const api = {
    register(...ws: StdWallet[]) {
      for (const w of ws) if (usable(w) && !G.wallets.some((x) => x === w || x.name === w.name)) G.wallets.push(w);
      for (const l of G.listeners) l();
      return () => {
        for (const w of ws) {
          const i = G.wallets.indexOf(w);
          if (i >= 0) G.wallets.splice(i, 1);
        }
        for (const l of G.listeners) l();
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

export const discovered = () => [...G.wallets];
export const onWallets = (f: () => void) => {
  G.listeners.add(f);
  return () => G.listeners.delete(f);
};

/** Window providers that exist without a Wallet Standard registration (an outdated extension). */
export function legacyOnly(): string[] {
  const w = window as any;
  const out: string[] = [];
  if (w.phantom?.solana && !G.wallets.some((x) => /phantom/i.test(x.name))) out.push("Phantom");
  if (w.solflare && !G.wallets.some((x) => /solflare/i.test(x.name))) out.push("Solflare");
  if (w.backpack && !G.wallets.some((x) => /backpack/i.test(x.name))) out.push("Backpack");
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

// ------------------------------------------------------------------------------------------------
// the session

export const session = (): Session => G.session;
export const connectedAddress = () => G.session.account?.address ?? null;
/** Called now and on every change of the connection. */
export function onSession(f: (s: Session) => void): () => void {
  G.sessionListeners.add(f);
  return () => G.sessionListeners.delete(f);
}
function emit(patch: Partial<Session>) {
  G.session = { ...G.session, ...patch };
  for (const f of [...G.sessionListeners]) {
    try {
      f(G.session);
    } catch {
      /* a listener's page is gone */
    }
  }
}
export function rememberedWallet(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Connects the named wallet (or the only/first one) and keeps the choice for the next load. */
export async function connectWallet(name?: string, silent = false): Promise<StdAccount | null> {
  startDiscovery();
  const w = (name ? G.wallets.find((x) => x.name === name) : G.wallets[0]) ?? null;
  if (!w) {
    if (!silent) emit({ error: "No Wallet Standard wallet found in this browser. Install Phantom, Solflare or Backpack and reload." });
    return null;
  }
  try {
    const acc = await connect(w, silent);
    if (!acc) throw new Error("the wallet returned no account");
    try {
      localStorage.setItem(KEY, w.name);
    } catch {
      /* storage blocked */
    }
    G.unsubChange?.();
    G.unsubChange = onChange(w, () => {
      const a = w.accounts[0];
      if (!a) return void disconnectWallet(false);
      if (a.address !== G.session.account?.address) emit({ account: a });
    });
    emit({ wallet: w, account: acc, error: null, restoring: false });
    return acc;
  } catch (e) {
    emit({ restoring: false, error: silent ? null : `Connect failed: ${(e as Error).message}` });
    return null;
  }
}

export async function disconnectWallet(tellWallet = true) {
  const w = G.session.wallet;
  G.unsubChange?.();
  G.unsubChange = null;
  if (w && tellWallet) await disconnect(w);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  emit({ wallet: null, account: null, error: null, restoring: false });
}

/** Silent reconnect to the remembered wallet once it registers (once per page load). */
export function restoreSession() {
  startDiscovery();
  const tryNow = () => {
    if (G.triedRestore || G.session.account) return;
    const name = rememberedWallet();
    if (!name) return;
    if (!G.wallets.some((w) => w.name === name)) {
      if (!G.session.restoring) emit({ restoring: true });
      return;
    }
    G.triedRestore = true;
    void connectWallet(name, true);
  };
  tryNow();
  onWallets(tryNow);
  // a wallet that never registers: stop showing "restoring"
  setTimeout(() => {
    if (G.session.restoring && !G.session.account) emit({ restoring: false });
  }, 4000);
}

// ------------------------------------------------------------------------------------------------
// signing

/** The wallet signs `wire` (it may hold other signatures already) for devnet and returns the wire. */
export async function signTransaction(w: StdWallet, account: StdAccount, wire: Uint8Array): Promise<Uint8Array> {
  const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: wire, chain: DEVNET_CHAIN });
  if (!out?.signedTransaction) throw new Error("the wallet returned no signed transaction");
  return new Uint8Array(out.signedTransaction);
}

/** Whether the wallet signs version 0 transactions (Wallet Standard `supportedTransactionVersions`; plan C). */
export const signsV0 = (w: StdWallet): boolean => !!w.features?.["solana:signTransaction"]?.supportedTransactionVersions?.includes?.(0);
