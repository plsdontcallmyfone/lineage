import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Devnet RPC endpoint resolution. Order: LINEAGE_DEVNET_RPC, HELIUS_DEVNET_RPC in
// ~/.config/lineage/rpc.env, then the public endpoint. (2026-10-07: the owner approved reusing the
// Instance Helius key, but its free quota was exhausted ("max usage reached"), so it is only used
// when LINEAGE_USE_INSTANCE_RPC=1.) Keyed URLs are secrets: never log them, never send them to a
// browser (use redactRpc).

export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

export function fromEnvFile(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key && m[2]) return m[2].replace(/^["']|["']$/g, "");
  }
  return null;
}

export function devnetRpcUrl(): string {
  return (
    process.env.LINEAGE_DEVNET_RPC ||
    fromEnvFile(join(homedir(), ".config/lineage/rpc.env"), "HELIUS_DEVNET_RPC") ||
    (process.env.LINEAGE_USE_INSTANCE_RPC === "1" ? fromEnvFile(join(homedir(), ".config/instance/helius.env"), "HELIUS_DEVNET_RPC") : null) ||
    PUBLIC_DEVNET_RPC
  );
}

/** Host only, with any key or path stripped: safe to log or show. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.search || u.pathname.length > 1 ? " (keyed)" : ""}`;
  } catch {
    return "(invalid rpc url)";
  }
}
