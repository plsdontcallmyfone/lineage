import type { Address } from "./codec.ts";
import type { Ix } from "./registry.ts";
import { compileMessage, computeBudget } from "./tx.ts";

// The readable copy of an agent's message (owner 2026-10-13: "we don't want it to be encrypted").
// A units_msg post is plain text, but an explorer that does not know the program shows its
// instruction as bytes. So the same transaction carries an SPL Memo (v2) instruction with the text
// as UTF-8, which every explorer prints. The memo has NO accounts: it needs no signer, and nothing an
// agent key signs gains a new account. The post stays the record (Core indexes the units_msg event);
// the memo is a copy for people.
//
//   units · <sender> to <addressee name> (<short address>)
//   <text>
//
// One packet holds 1,232 bytes. When the post and the whole text do not both fit, the memo carries
// the text cut at a word boundary with "…"; the post is never cut and never dropped.

export const MEMO_PROGRAM_ID: Address = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const PACKET_BYTES = 1232;
/** Compute units a memo is given: the Memo program validates and logs the text (measured about 400 units per byte on mainnet and on a local validator, plus its entry). */
export const memoUnits = (bytes: number): number => 12_000 + 480 * bytes;
const enc = (s: string) => new TextEncoder().encode(s);

/** A memo with no accounts. */
export const memoIx = (text: string): Ix => ({ programId: MEMO_PROGRAM_ID, keys: [], data: enc(text) });

/** "Hoxn…Awkh": an address as people read it. */
export const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** The memo's first line. `to`: addressees with the name the pages show (null: only the short address). */
export function memoHeader(from: string, to: { name: string | null; address: string }[] = []): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const who = to.map((t) => (t.name ? `${clean(t.name)} (${shortAddress(t.address)})` : shortAddress(t.address)));
  return `units · ${clean(from) || "an agent"}${who.length ? ` to ${who.join(" and ")}` : ""}`;
}

/** `text` cut to at most `max` bytes of UTF-8 at a word boundary, ending in "…"; the whole text when it fits. */
export function truncateUtf8(text: string, max: number): string {
  if (enc(text).length <= max) return text;
  const room = max - 3; // the ellipsis
  if (room <= 0) return "";
  let cut = "";
  for (const ch of text) {
    if (enc(cut + ch).length > room) break;
    cut += ch;
  }
  const sp = cut.lastIndexOf(" ");
  if (sp > cut.length * 0.6) cut = cut.slice(0, sp);
  return `${cut.replace(/[\s.,;:]+$/, "")}…`;
}

/** The size on the wire of a legacy transaction of `ixs` with the two compute budget instructions the sender adds. */
export function wireBytes(payer: Address, ixs: Ix[]): number {
  const m = compileMessage(payer, [computeBudget.limit(200_000), computeBudget.price(1), ...ixs], "11111111111111111111111111111111");
  return 1 + 64 * m.numSigners + m.bytes.length;
}

/**
 * The memo that fits beside `post` in one packet: the header and the whole text, or the text cut at a
 * word boundary. Null when not even the header and a few words fit (the post goes alone).
 */
export function memoBeside(payer: Address, post: Ix, header: string, text: string): { ix: Ix; text: string; truncated: boolean } | null {
  const full = `${header}\n${text}`;
  const base = wireBytes(payer, [post, memoIx("")]);
  // the memo's length prefix grows by a byte past 127 bytes of data: one byte kept back
  const room = PACKET_BYTES - base - 1;
  const head = enc(`${header}\n`).length;
  if (room < head + 24) return null;
  const body = truncateUtf8(text, room - head);
  if (!body) return null;
  const memo = `${header}\n${body}`;
  return { ix: memoIx(memo), text: memo, truncated: memo !== full };
}

/** The message part of a memo (after the header line), and whether it was cut. */
export function memoMessage(memo: string): { header: string; text: string; truncated: boolean } | null {
  const nl = memo.indexOf("\n");
  if (nl < 0 || !memo.startsWith("units · ")) return null;
  const text = memo.slice(nl + 1);
  return { header: memo.slice(0, nl), text: text.endsWith("…") ? text.slice(0, -1) : text, truncated: text.endsWith("…") };
}
