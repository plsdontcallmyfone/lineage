// A staging Core for the pools and fee-claims proofs (docs/plans/AGENT-POOLS.md, GITHUB-FEE-CLAIMS.md):
// scripts/pools/staging-core.ts against devnet, without the chain bridge and without the Core
// authority key (so it can never post an epoch or a slash), both feature flags on for this one process, the pool keeper and the claim attestor keys
// from their own files, and a mock GitHub for OAuth and gists. The public devnet site is not
// touched: its Core keeps the flags off.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startMockGithub, type MockGithub, type MockUser } from "../claims/mock-github.ts";

const ROOT = join(import.meta.dir, "..", "..");
const KEYS = join(homedir(), ".config", "units", "devnet");

export interface Staging {
  core: string;
  mock: MockGithub;
  pid: number;
  adminKeyPath: string;
  stop(): void;
}

function busy(port: number): string {
  try {
    return execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export async function startStaging(o: { corePort: number; mockPort: number; users: MockUser[]; dataDir: string; claimPage?: string; log?: (m: string) => void }): Promise<Staging> {
  for (const p of [o.corePort, o.mockPort]) if (busy(p)) throw new Error(`port ${p} is in use by pid ${busy(p)}; not binding`);
  const log = o.log ?? (() => {});
  mkdirSync(o.dataDir, { recursive: true });
  // the devnet state without the Core authority key: a read-only bridge
  const state = JSON.parse(readFileSync(join(ROOT, "scripts", "devnet", "devnet.json"), "utf8"));
  delete state.core_authority_key;
  const chainFile = join(o.dataDir, "chain.json");
  writeFileSync(chainFile, JSON.stringify(state, null, 2));
  const adminKeyPath = join(KEYS, "pools-proof-core-admin.json");
  const mock = startMockGithub({ port: o.mockPort, users: o.users, clientId: "units-staging", clientSecret: "staging-secret" });
  const env = {
    ...process.env,
    UNITS_NETWORK: "devnet",
    UNITS_FEATURE_AGENT_POOLS: "1",
    UNITS_FEATURE_GITHUB_FEE_CLAIMS: "1",
    UNITS_POOL_KEEPER_KEY: join(KEYS, "pools-keeper.json"),
    UNITS_FEE_CLAIMS_ATTESTOR_KEY: join(KEYS, "claims-attestor.json"),
    UNITS_GITHUB_API: mock.url,
    UNITS_GITHUB_OAUTH_BASE: mock.url,
    UNITS_GITHUB_OAUTH_MOCK: "1",
    UNITS_GITHUB_OAUTH_CLIENT_ID: "units-staging",
    UNITS_GITHUB_OAUTH_CLIENT_SECRET: "staging-secret",
    UNITS_GITHUB_OAUTH_REDIRECT: `http://127.0.0.1:${o.corePort}/v1/fee-claims/oauth/callback`,
    UNITS_CLAIM_PAGE: o.claimPage ?? "http://127.0.0.1:9666/claim",
    UNITS_GITHUB_TOKEN: "",
  };
  const child: ChildProcess = spawn("bun", ["scripts/pools/staging-core.ts", "--data", join(o.dataDir, "core"), "--port", String(o.corePort), "--chain", chainFile,
    "--admin-key", adminKeyPath], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: string[] = [];
  child.stdout!.on("data", (d) => out.push(String(d)));
  child.stderr!.on("data", (d) => out.push(String(d)));
  const core = `http://127.0.0.1:${o.corePort}`;
  const stop = () => {
    mock.stop();
    if (child.pid && child.exitCode === null) process.kill(child.pid); // our own child, by PID
  };
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode !== null) {
      mock.stop();
      throw new Error(`staging Core exited: ${out.join("").slice(-1500)}`);
    }
    try {
      if ((await fetch(`${core}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok) {
        log(`staging Core on ${core} (pid ${child.pid}), mock GitHub on ${mock.url}`);
        for (const l of out.join("").split("\n").filter((l) => /fee claims|agent pools|chain mode/.test(l))) log(`  ${l}`);
        return { core, mock, pid: child.pid!, adminKeyPath, stop };
      }
    } catch {
      /* not up yet */
    }
  }
  stop();
  throw new Error(`staging Core did not start: ${out.join("").slice(-1500)}`);
}
