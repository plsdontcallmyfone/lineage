// Signed statements that bind a pasted token, or a revocation, to one launch (plan B: "bound to the
// launch with a statement the launcher signs"). The signature covers statementDigest("identity", s)
// (packages/protocol), i.e. a 64-hex string, which is what a wallet's signMessage signs when given
// those bytes, so a browser wallet and an agent key produce the same kind of signature. The service
// accepts a statement signed by the launch's launcher (AgentLaunch.launcher) or by the agent's current
// signing key (the registry), within MAX_SKEW_S of its clock, and never one older than the last it
// accepted for that agent (no replay).

import { createHash } from "node:crypto";
import { statementDigest, verifyStatement } from "../../protocol/src/auth.ts";

export const PURPOSE = "identity";
export const MAX_SKEW_S = 600;
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface TokenStatement {
  v: 1;
  kind: "lineage-identity-token";
  agent: string;
  mint: string;
  signer: string;
  /** sha256 hex of the exact token string submitted with the statement */
  token_sha256: string;
  created_at: number;
}

export interface RevokeStatement {
  v: 1;
  kind: "lineage-identity-revoke";
  agent: string;
  mint: string;
  signer: string;
  created_at: number;
}

export type IdentityStatement = TokenStatement | RevokeStatement;

export const tokenSha256 = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** The message the signer signs (hex text; a wallet signs its UTF-8 bytes). */
export const statementMessage = (s: IdentityStatement) => statementDigest(PURPOSE, s);

/** Shape, freshness and signature of a statement; returns the reason it is refused, or null. */
export function checkStatement(s: unknown, sig: unknown, kind: IdentityStatement["kind"], nowS: number): string | null {
  if (!s || typeof s !== "object") return "statement missing";
  const x = s as Record<string, unknown>;
  const keys = Object.keys(x).sort().join(",");
  const want = kind === "lineage-identity-token" ? "agent,created_at,kind,mint,signer,token_sha256,v" : "agent,created_at,kind,mint,signer,v";
  if (keys !== want) return `statement fields must be exactly ${want}`;
  if (x.v !== 1 || x.kind !== kind) return `statement kind must be ${kind}`;
  for (const k of ["agent", "mint", "signer"]) if (typeof x[k] !== "string" || !ADDR.test(x[k] as string)) return `statement ${k} is not an address`;
  if (kind === "lineage-identity-token" && (typeof x.token_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.token_sha256))) return "statement token_sha256 must be 64 lowercase hex";
  if (typeof x.created_at !== "number" || !Number.isInteger(x.created_at)) return "statement created_at must be unix seconds";
  if (Math.abs(nowS - x.created_at) > MAX_SKEW_S) return `statement created_at is more than ${MAX_SKEW_S} s from the service clock`;
  if (typeof sig !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) return "signature missing";
  if (!verifyStatement(x.signer as string, sig, PURPOSE, x)) return "signature does not verify for the statement's signer";
  return null;
}
