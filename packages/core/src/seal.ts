import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { base58Decode, base58Encode, H, type AgentKey } from "./protocol.ts";

// Sealed messages for C2 (SPEC 12.3): an anonymous-sender box to the recipient's X25519 key,
// carried inside the sender's signed envelope (the box alone does not authenticate its sender, the
// envelope signature does). Construction, all from node:crypto:
//
//   eph        = fresh X25519 key pair per message
//   shared     = X25519(eph.secret, recipient.public)
//   key        = HKDF-SHA256(shared, salt = eph.public | recipient.public, info = "lineage-msg-seal-v1", 32 bytes)
//   ciphertext = base64( eph.public | AES-256-GCM(key, nonce = 12 zero bytes, plaintext) | 16-byte tag )
//
// The nonce can be fixed because the key is unique per message (a fresh ephemeral key each time).
// AES-256-GCM rather than ChaCha20-Poly1305 because Bun's node:crypto has no ChaCha20-Poly1305.
// The encryption key is never the ed25519 signing key: a worker derives it from its key seed under
// its own domain, H("lineage-x25519-v1", seed), and publishes it with a signed statement.

export const SEAL_SCHEME = "x25519-hkdf-sha256-aes256gcm-v1";
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const INFO = Buffer.from("lineage-msg-seal-v1");

export interface EncryptionKey {
  /** base58 X25519 public key, what the agent publishes */
  public: string;
  /** 32-byte X25519 secret */
  secret: Uint8Array;
}

function privObj(secret: Uint8Array) {
  return createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(secret)]), format: "der", type: "pkcs8" });
}

function pubObj(pub: Uint8Array) {
  return createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(pub)]), format: "der", type: "spki" });
}

function rawPublic(secret: Uint8Array): Buffer {
  return createPublicKey(privObj(secret)).export({ format: "der", type: "spki" }).subarray(X_SPKI.length);
}

export function encryptionKeyFromSecret(secret: Uint8Array): EncryptionKey {
  if (secret.length !== 32) throw new Error("an X25519 secret is 32 bytes");
  return { public: base58Encode(rawPublic(secret)), secret: Uint8Array.from(secret) };
}

/** The agent's message encryption key, derived from its key seed under its own domain. */
export function deriveEncryptionKey(k: AgentKey): EncryptionKey {
  return encryptionKeyFromSecret(Buffer.from(H("lineage-x25519-v1", Buffer.from(k.secret.subarray(0, 32)).toString("hex")), "hex"));
}

/** True when `s` is a base58 X25519 public key node:crypto accepts. */
export function isEncryptionKey(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 50) return false;
  try {
    const raw = base58Decode(s);
    if (raw.length !== 32) return false;
    pubObj(raw);
    return true;
  } catch {
    return false;
  }
}

function boxKey(shared: Buffer, ephPub: Uint8Array, recPub: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(ephPub), Buffer.from(recPub)]), INFO, 32));
}

/** Seals `plaintext` to a recipient's published encryption key. Returns base64. */
export function seal(plaintext: string, recipient: string): string {
  const recPub = base58Decode(recipient);
  if (recPub.length !== 32) throw new Error("recipient encryption key must be 32 bytes");
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(X_SPKI.length);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pubObj(recPub) });
  const c = createCipheriv("aes-256-gcm", boxKey(shared, ephPub, recPub), Buffer.alloc(12), { authTagLength: 16 });
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return Buffer.concat([ephPub, ct, c.getAuthTag()]).toString("base64");
}

/** Opens a sealed box with the recipient's key; null when it was not sealed to this key or was altered. */
export function open(ciphertext: string, key: EncryptionKey): string | null {
  try {
    const raw = Buffer.from(ciphertext, "base64");
    if (raw.length < 32 + 16) return null;
    const ephPub = raw.subarray(0, 32);
    const tag = raw.subarray(raw.length - 16);
    const body = raw.subarray(32, raw.length - 16);
    const recPub = rawPublic(key.secret);
    const shared = diffieHellman({ privateKey: privObj(key.secret), publicKey: pubObj(ephPub) });
    const d = createDecipheriv("aes-256-gcm", boxKey(shared, ephPub, recPub), Buffer.alloc(12), { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
