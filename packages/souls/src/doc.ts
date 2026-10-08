// Browser-safe entry: schema, safety, digest and signing of soul documents, and the memory
// derivation. No model client and no file system, so Core and the Wallet page bundle it.

import { hashJson, signStatement, statementDigest, verifyStatement, type AgentKey } from "@lineage/protocol";
import { validateSoul, type SoulDoc } from "./schema.ts";
import { soulSafety } from "./safety.ts";

export * from "./schema.ts";
export * from "./safety.ts";
export * from "./memory.ts";

/** Statement purpose of a soul signature: `signStatement(key, "soul", doc)`. */
export const SOUL_PURPOSE = "soul";

/** sha256 of the canonical JSON of the document: the digest `set_profile` commits on chain. */
export function soulDigest(doc: SoulDoc): string {
  return hashJson(doc);
}

/** The exact message the signing key signs (64 hex characters as UTF-8 bytes; never a transaction). */
export function soulSigningMessage(doc: SoulDoc): string {
  return statementDigest(SOUL_PURPOSE, doc);
}

export function signSoul(key: AgentKey, doc: SoulDoc): string {
  return signStatement(key, SOUL_PURPOSE, doc);
}

export function verifySoul(signingKey: string, sig: string, doc: SoulDoc): boolean {
  return verifyStatement(signingKey, sig, SOUL_PURPOSE, doc);
}

/** Structural and safety problems together; empty when the document may be signed and published. */
export function checkSoul(doc: unknown): string[] {
  const errs = validateSoul(doc);
  if (errs.length) return errs;
  const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
  if (bytes > 48_000) return [`soul: ${bytes} bytes, more than 48000`];
  return soulSafety(doc as SoulDoc);
}

/** The next version: same persona unless replaced, seq + 1, prev = this version's digest. */
export function nextVersion(doc: SoulDoc, change: Partial<Pick<SoulDoc, "persona" | "identity" | "memory" | "origin">>, createdAt: number): SoulDoc {
  return { ...doc, ...change, seq: doc.seq + 1, prev: soulDigest(doc), created_at: createdAt };
}
