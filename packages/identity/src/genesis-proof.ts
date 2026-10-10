// The GitHub genesis proof file (docs/plans/GITHUB-GENESIS.md 1.2): `lineage-proof.json` in the
// agent's profile repository <login>/<login>. Pure and dependency-light so Core, the identity service,
// the hosted runtime and scripts/identity/verify-genesis.ts share one definition.
//
//   statement = { v: 1, kind: "lineage-github-genesis", agent, mint, launch_tx, soul_digest, target_repo,
//                 github_login, network, site, issued_at, signer }
//   file      = { ...statement, sig }      sig = signStatement(key, "github-genesis", statement)
//
// `signer` and `sig` are null when the agent's key was not available to sign (self-hosted agents).

import { canonicalJson, signStatement, verifyStatement, type AgentKey } from "../../protocol/src/index.ts";

export const GENESIS_PURPOSE = "github-genesis";
export const GENESIS_KIND = "lineage-github-genesis";
export const GENESIS_FILE = "lineage-proof.json";
// Rebrand (docs/plans/REBRAND-UNITS.md 3.9): readers accept the units names too; GENESIS_KIND and
// GENESIS_FILE are what the writer uses until the signing switch.
export const GENESIS_KINDS = ["units-github-genesis", "lineage-github-genesis"] as const;
/** Proof file names a reader looks for, newest name first. */
export const GENESIS_FILES = ["units-proof.json", "lineage-proof.json"] as const;
export const GENESIS_FIELDS = ["agent", "github_login", "issued_at", "kind", "launch_tx", "mint", "network", "signer", "site", "soul_digest", "target_repo", "v"] as const;

export interface GenesisStatement {
  v: 1;
  kind: (typeof GENESIS_KINDS)[number];
  agent: string;
  mint: string | null;
  launch_tx: string | null;
  soul_digest: string | null;
  target_repo: string | null;
  github_login: string;
  network: string;
  site: string | null;
  issued_at: number;
  signer: string | null;
}

export type GenesisFile = GenesisStatement & { sig: string | null };
/** What the runtime is asked to sign: everything but the signer it fills in. */
export type UnsignedGenesis = Omit<GenesisStatement, "signer">;

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

const strOrNull = (v: unknown, max: number, re?: RegExp) => v === null || (typeof v === "string" && v.length > 0 && v.length <= max && (!re || re.test(v)));

/** Why an object is not a genesis statement (without sig), or null. `unsignedOk` allows signer null. */
export function genesisShapeError(x: unknown, o: { withSig?: boolean; withSigner?: boolean } = {}): string | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return "not an object";
  const s = x as Record<string, unknown>;
  const want = [...GENESIS_FIELDS.filter((f) => o.withSigner !== false || f !== "signer"), ...(o.withSig ? ["sig"] : [])].sort();
  const keys = Object.keys(s).sort();
  if (keys.join(",") !== want.join(",")) return `fields must be exactly ${want.join(",")}`;
  if (s.v !== 1 || !(GENESIS_KINDS as readonly unknown[]).includes(s.kind)) return `v must be 1 and kind ${GENESIS_KINDS.join(" or ")}`;
  if (typeof s.agent !== "string" || !ADDR.test(s.agent)) return "agent is not an address";
  if (!strOrNull(s.mint, 44, ADDR)) return "mint is not an address";
  if (!strOrNull(s.launch_tx, 100, SIG)) return "launch_tx is not a transaction signature";
  if (!strOrNull(s.soul_digest, 64, /^[0-9a-f]{64}$/)) return "soul_digest is not 64 hex";
  if (!strOrNull(s.target_repo, 300, /^https:\/\/[^\s]+$/)) return "target_repo is not an https URL";
  if (typeof s.github_login !== "string" || !LOGIN.test(s.github_login)) return "github_login is not a lowercase GitHub login";
  if (typeof s.network !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(s.network)) return "network is not a profile name";
  if (!strOrNull(s.site, 300, /^https?:\/\/[^\s]+$/)) return "site is not a URL";
  if (typeof s.issued_at !== "number" || !Number.isInteger(s.issued_at) || s.issued_at <= 0) return "issued_at must be unix seconds";
  if (o.withSigner !== false && !strOrNull(s.signer, 44, ADDR)) return "signer is not an address";
  if (o.withSig) {
    if (!strOrNull(s.sig, 100, SIG)) return "sig is not a signature";
    if ((s.sig === null) !== (s.signer === null)) return "signer and sig are both set or both null";
  }
  return null;
}

/** The statement a file signs: the file without `sig`. */
export function genesisStatementOf(f: GenesisFile): GenesisStatement {
  const { sig: _sig, ...st } = f;
  return st;
}

export function signGenesis(key: AgentKey, st: UnsignedGenesis): GenesisFile {
  const statement: GenesisStatement = { ...st, signer: key.id };
  return { ...statement, sig: signStatement(key, GENESIS_PURPOSE, statement) };
}

/** The file text (keys sorted, two-space indent, trailing newline); its bytes are what GitHub serves. */
export function genesisFileText(f: GenesisFile): string {
  return JSON.stringify(JSON.parse(canonicalJson(f)), null, 2) + "\n";
}

export type GenesisCheck = { ok: true; file: GenesisFile } | { ok: false; reason: string; file?: GenesisFile };

/**
 * Offline check of a proof file: shape, then the signature for its own `signer`. `expect` adds the
 * agent, the login, and the key the caller knows the agent had at issued_at (Core: identity.keyAt).
 */
export function verifyGenesis(raw: unknown, expect: { agent?: string; login?: string; key?: string | null } = {}): GenesisCheck {
  let x = raw;
  if (typeof raw === "string") {
    try {
      x = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  const why = genesisShapeError(x, { withSig: true });
  if (why) return { ok: false, reason: why };
  const f = x as GenesisFile;
  if (expect.agent && f.agent !== expect.agent) return { ok: false, reason: `the proof is for agent ${f.agent}`, file: f };
  if (expect.login && f.github_login !== expect.login.toLowerCase()) return { ok: false, reason: `the proof names login ${f.github_login}`, file: f };
  if (!f.signer || !f.sig) return { ok: false, reason: "the proof is not signed yet", file: f };
  if (expect.key !== undefined && expect.key !== f.signer) return { ok: false, reason: expect.key ? "the signer is not the agent's registry signing key at issued_at" : "the agent had no signing key at issued_at", file: f };
  if (!verifyStatement(f.signer, f.sig, GENESIS_PURPOSE, genesisStatementOf(f))) return { ok: false, reason: "signature does not verify for the signer", file: f };
  return { ok: true, file: f };
}
