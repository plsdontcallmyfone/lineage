import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, H } from "./hash.ts";

// Agent identity and request signing, SPEC section 17. Agent ids are base58 ed25519 public keys,
// the same encoding as Solana addresses, so an M1 agent key is also its M2 wallet-bound identity.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface AgentKey {
  /** base58 public key = agent id */
  id: string;
  /** 64 bytes, Solana keypair layout: 32-byte seed then 32-byte public key */
  secret: Uint8Array;
}

export function generateAgentKey(): AgentKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  return { id: base58Encode(pub), secret: Uint8Array.from([...seed, ...pub]) };
}

export function keyFromSolanaJson(json: number[]): AgentKey {
  const secret = Uint8Array.from(json);
  return { id: base58Encode(secret.subarray(32)), secret };
}

function privateKeyObject(secret: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
}

function publicKeyObject(id: string): KeyObject {
  const raw = base58Decode(id);
  if (raw.length !== 32) throw new Error("agent id must be a 32-byte key");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
}

export const requestDigest = (method: string, path: string, body: string, nonce: string): string =>
  H("req", method.toUpperCase(), path, body, nonce);

export function signRequest(key: AgentKey, method: string, path: string, body: string, nonce: string): string {
  return base58Encode(sign(null, Buffer.from(requestDigest(method, path, body, nonce)), privateKeyObject(key.secret)));
}

export function verifyRequest(id: string, sig: string, method: string, path: string, body: string, nonce: string): boolean {
  try {
    return verify(null, Buffer.from(requestDigest(method, path, body, nonce)), publicKeyObject(id), Buffer.from(base58Decode(sig)));
  } catch {
    return false;
  }
}

/** Signs an arbitrary message (calibration records, epoch roots). */
export function signMessage(key: AgentKey, message: string): string {
  return base58Encode(sign(null, Buffer.from(message), privateKeyObject(key.secret)));
}

export function verifyMessage(id: string, sig: string, message: string): boolean {
  try {
    return verify(null, Buffer.from(message), publicKeyObject(id), Buffer.from(base58Decode(sig)));
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// Domain-separated statements (plan IDENTITY-AND-COLLABORATION 2.2). Agent keys are also Solana
// keys, so an agent never signs bytes someone else chose: every signed statement is the 64-hex
// digest H("<domain>-<purpose>-v1", canonicalJson(statement)), which can never parse as a Solana
// transaction message or an SSH signature blob.
//
// Rebrand (docs/plans/REBRAND-UNITS.md 3.6): the domain was "lineage" and becomes "units". Verifiers
// accept both, so every signature made before the switch stays valid; SIGN_DOMAIN is what new
// signatures use, and it moves to "units" only after the verifiers that read them are deployed. A
// statement whose `kind` names one brand ("units-..." or "lineage-...") verifies only under that
// brand's domain, so an old signature can never be relabelled.

const PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;

export type StatementDomain = "lineage" | "units";
/** Every domain a statement signature is accepted under, newest first. */
export const STATEMENT_DOMAINS: readonly StatementDomain[] = ["units", "lineage"];
/** The domain new signatures use (moves to "units" in the signing switch, REBRAND-UNITS.md 5 step 6). */
export const SIGN_DOMAIN: StatementDomain = "lineage";

/** The exact message a statement signature covers (under SIGN_DOMAIN unless a domain is given). */
export function statementDigest(purpose: string, statement: unknown, domain: StatementDomain = SIGN_DOMAIN): string {
  if (!PURPOSE.test(purpose)) throw new Error("statement purpose must be 1-32 lowercase letters, digits or dashes");
  if (!STATEMENT_DOMAINS.includes(domain)) throw new Error("unknown statement domain");
  return H(`${domain}-${purpose}-v1`, canonicalJson(statement));
}

/** Signs a statement for one purpose (team, intent, rotate, profile, link, msg, provenance, credential). */
export function signStatement(key: AgentKey, purpose: string, statement: unknown, domain: StatementDomain = SIGN_DOMAIN): string {
  return signMessage(key, statementDigest(purpose, statement, domain));
}

/** The brand a statement's `kind` names, if any ("units-follow" -> "units", "lineage-follow" -> "lineage"). */
export function kindDomain(statement: unknown): StatementDomain | null {
  const k = statement && typeof statement === "object" ? (statement as { kind?: unknown }).kind : undefined;
  if (typeof k !== "string") return null;
  for (const d of STATEMENT_DOMAINS) if (k.startsWith(`${d}-`)) return d;
  return null;
}

/** The domain a valid signature was made under, or null when it verifies under none it may use. */
export function statementDomainOf(id: string, sig: string, purpose: string, statement: unknown): StatementDomain | null {
  const pinned = kindDomain(statement);
  for (const d of pinned ? [pinned] : STATEMENT_DOMAINS) {
    try {
      if (verifyMessage(id, sig, statementDigest(purpose, statement, d))) return d;
    } catch {
      return null;
    }
  }
  return null;
}

export function verifyStatement(id: string, sig: string, purpose: string, statement: unknown): boolean {
  return statementDomainOf(id, sig, purpose, statement) !== null;
}
