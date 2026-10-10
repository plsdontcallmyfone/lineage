// Privy login for the site (owner, 2026-10-10): a React island loaded on demand by the header's
// Connect button (src/connect.ts). It mounts PrivyProvider in a detached root, opens Privy's own
// modal (external Solana wallets through Wallet Standard, or email with an embedded Solana wallet),
// and hands the connected wallet's Wallet Standard object to the site's one wallet session
// (wallet/standard.ts adoptWallet), so every signing flow keeps working unchanged. Only the public
// app id is here: the app secret is server-side only and never reaches the browser or the repo.
import { PrivyProvider, useConnectWallet, useLogin, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { adoptWallet, disconnectWallet, session, setDisconnectHook, walletChain } from "../wallet/standard.ts";

const APP_ID = "cmufv13cc00r70cl7brzv4ywm";
const DEVNET_RPC = "https://api.devnet.solana.com";

type Api = { open: () => void; logout: () => Promise<void> };
let api: Api | null = null;
let ready: Promise<Api> | null = null;
let resolveReady: ((a: Api) => void) | null = null;

function Bridge({ autoOpen }: { autoOpen: boolean }) {
  const { ready: pReady, authenticated, logout } = usePrivy();
  const { wallets, ready: wReady } = useWallets();
  const { login } = useLogin();
  const { connectWallet } = useConnectWallet();
  const opened = useRef(false);

  // the site's session follows Privy's first Solana wallet
  useEffect(() => {
    if (!wReady) return;
    const w = wallets[0];
    const cur = session().account?.address;
    if (w && w.address !== cur) {
      const std: any = w.standardWallet;
      const account = (std.accounts ?? []).find((a: any) => a.address === w.address) ?? { address: w.address, publicKey: new Uint8Array(), chains: [walletChain()], features: [] };
      adoptWallet(std, account, "privy");
    }
  }, [wReady, wallets]);

  useEffect(() => {
    if (!pReady) return;
    api = {
      open: () => (authenticated ? connectWallet({ walletChainType: "solana-only" }) : login()),
      logout: async () => {
        for (const w of wallets) await w.disconnect().catch(() => undefined);
        await logout().catch(() => undefined);
      },
    };
    resolveReady?.(api);
    if (autoOpen && !opened.current && !authenticated) {
      opened.current = true;
      api.open();
    }
  }, [pReady, authenticated, wallets, login, connectWallet, logout, autoOpen]);
  return null;
}

/** Mounts Privy once; `open` shows its login modal as soon as it is ready. */
export function startPrivy(open: boolean): Promise<Api> {
  if (ready) {
    if (open) void ready.then((a) => a.open());
    return ready;
  }
  ready = new Promise((r) => (resolveReady = r));
  const host = document.createElement("div");
  host.id = "privy-root";
  document.body.appendChild(host);
  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  createRoot(host).render(
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["wallet", "email"],
        appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#ff7a17" : "#e06510", walletChainType: "solana-only", showWalletLoginFirst: true, walletList: ["detected_solana_wallets", "phantom", "solflare", "backpack", "wallet_connect_qr_solana"] },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors({ shouldAutoConnect: true }) } },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, ethereum: { createOnLogin: "off" } },
        solana: { rpcs: { "solana:devnet": { rpc: createSolanaRpc(DEVNET_RPC), rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_RPC.replace(/^http/, "ws")), blockExplorerUrl: "https://explorer.solana.com/?cluster=devnet" } } },
      }}
    >
      <Bridge autoOpen={open} />
    </PrivyProvider>,
  );
  // disconnecting from the header also logs out of Privy
  setDisconnectHook(async () => (await ready)?.logout());
  return ready;
}

export async function privyLogout() {
  const a = await ready;
  await a?.logout();
  await disconnectWallet(false);
}
