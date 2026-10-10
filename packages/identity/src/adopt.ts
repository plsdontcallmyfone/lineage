// Adopting an existing GitHub account for an agent, without the reserve (devnet v2 relaunch,
// 2026-10-10; onchain/DEVNET.md "Devnet v2"). Two cases, both run by the operator on the server as the
// identity user with the input on stdin (`main.ts adopt`), so no token is ever in argv or a log:
//
//   import  { agent, mint, launcher, repo, launched_at, cred: { login, github_id, token, ssh_private_key,
//             ssh_public_key, ssh_signing_key_id, assigned_at } }
//           an account provisioned before the service existed (TSOUL's owunqwxs, assigned to it in the
//           operator's pool file) becomes the agent's purchased identity. The token must answer
//           GET /user for that login.
//   rekey   { agent, mint, launcher, repo, launched_at, from_agent }
//           an agent relaunched under a new agent key (its earlier key was not kept) keeps its earlier
//           agent's account: the credential is copied to the new agent id. The earlier agent's state
//           stays as history.
//
// Either way the agent's state is `ready` (purchased) before its launch is seen, so the watcher never
// assigns it a reserve account. The genesis proof and README follow with `main.ts genesis --agent`.

import type { AgentState, CredRecord, ReserveRecord } from "./records.ts";
import { setStatus } from "./records.ts";
import type { EncryptedStore } from "./store.ts";

const ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AdoptInput {
  agent: string;
  mint: string;
  launcher: string;
  repo: string;
  launched_at: number;
  from_agent?: string;
  cred?: { login: string; github_id: number; token: string; ssh_private_key: string; ssh_public_key: string; ssh_signing_key_id: number | null; assigned_at: string };
}

export interface AdoptResult {
  agent: string;
  login: string;
  github_id: number;
  status: "ready";
  how: "import" | "rekey";
  from_agent: string | null;
}

/** GET /user with the token answers this login (read only). */
export async function tokenLogin(token: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "lineage-identity" },
    signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for the token`);
  return String(((await r.json()) as { login?: unknown }).login ?? "");
}

export async function adopt(store: EncryptedStore, input: AdoptInput, o: { now?: Date; fetch?: typeof fetch } = {}): Promise<AdoptResult> {
  const now = o.now ?? new Date();
  for (const k of ["agent", "mint", "launcher"] as const) if (typeof input[k] !== "string" || !ID.test(input[k])) throw new Error(`${k} must be a base58 address`);
  if (typeof input.repo !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new Error("repo must be a github.com repository URL");
  if (!Number.isFinite(input.launched_at)) throw new Error("launched_at (unix seconds) is required");
  if (!!input.from_agent === !!input.cred) throw new Error("give exactly one of from_agent (rekey) or cred (import)");

  let rec: CredRecord;
  if (input.from_agent) {
    if (!ID.test(input.from_agent) || input.from_agent === input.agent) throw new Error("from_agent must be another agent id");
    const prev = store.get<CredRecord>("cred", input.from_agent);
    if (!prev) throw new Error(`no credential for ${input.from_agent}`);
    rec = { ...prev, agent: input.agent, mode: "purchased" };
  } else {
    const c = input.cred!;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(c.login) || !Number.isInteger(c.github_id)) throw new Error("cred.login and cred.github_id are required");
    if (!c.ssh_private_key.includes("PRIVATE KEY") || !c.ssh_public_key.startsWith("ssh-ed25519 ")) throw new Error("cred needs the OpenSSH signing key pair");
    const login = await tokenLogin(c.token, o.fetch);
    if (login.toLowerCase() !== c.login.toLowerCase()) throw new Error(`the token belongs to another account than ${c.login}`);
    rec = { v: 1, agent: input.agent, mode: "purchased", login: c.login, github_id: c.github_id, token: c.token, ssh_private_key: c.ssh_private_key,
      ssh_public_key: c.ssh_public_key, ssh_signing_key_id: c.ssh_signing_key_id, assigned_at: c.assigned_at };
  }
  const other = store.list("cred").find((a) => a !== input.agent && a !== input.from_agent && store.get<CredRecord>("cred", a)?.login === rec.login);
  if (other) throw new Error(`${rec.login} is already the account of ${other}`);
  store.put("cred", input.agent, rec);
  // a reserve record of this login (if the server has one) names the agent now
  const res = store.get<ReserveRecord>("reserve", rec.login);
  if (res) store.put("reserve", rec.login, { ...res, status: "assigned", assigned_agent: input.agent, note: `adopted ${now.toISOString()}` });

  const at = now.toISOString();
  const s: AgentState = store.get<AgentState>("state", input.agent) ?? {
    v: 1, agent: input.agent, mint: input.mint, launcher: input.launcher, repo: input.repo, mode: "purchased", status: "app", reason: null, login: null,
    github_id: null, ssh_public_key: null, scopes: null, token_kind: null, expires_at: null, launched_at: input.launched_at, first_seen_at: at, updated_at: at,
    attempts: 0, last_statement_at: 0, history: [],
  };
  Object.assign(s, { mint: input.mint, launcher: input.launcher, repo: input.repo, mode: "purchased", login: rec.login, github_id: rec.github_id, ssh_public_key: rec.ssh_public_key,
    launched_at: input.launched_at });
  store.put("state", input.agent, setStatus(s, "ready", input.from_agent ? `account of ${input.from_agent}, relaunched under a new agent key` : "imported account", now));
  return { agent: input.agent, login: rec.login, github_id: rec.github_id, status: "ready", how: input.from_agent ? "rekey" : "import", from_agent: input.from_agent ?? null };
}
