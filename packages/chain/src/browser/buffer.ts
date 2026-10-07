// The slice of Node's Buffer that packages/chain and packages/protocol use (base64 and hex
// conversion, concat, byteLength), installed as globalThis.Buffer when the page has none.
// Import this module first in a browser entry: protocol's auth.ts calls Buffer.from at load.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < b.length ? B64[n & 63]! : "=");
  }
  return s;
}
function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const c of clean) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export class BrowserBuffer extends Uint8Array {
  static override from(v: any, enc?: any, _x?: any): BrowserBuffer {
    let bytes: Uint8Array;
    if (typeof v === "string") {
      if (enc === "base64") bytes = fromBase64(v);
      else if (enc === "hex") bytes = Uint8Array.from(v.match(/../g) ?? [], (h: string) => parseInt(h, 16));
      else bytes = new TextEncoder().encode(v);
    } else bytes = Uint8Array.from(v as ArrayLike<number>);
    const out = new BrowserBuffer(bytes.length);
    out.set(bytes);
    return out;
  }
  static concat(list: Uint8Array[]): BrowserBuffer {
    const out = new BrowserBuffer(list.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of list) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  }
  static byteLength(s: string): number {
    return new TextEncoder().encode(s).length;
  }
  static isBuffer(x: unknown): boolean {
    return x instanceof BrowserBuffer;
  }
  override toString(enc?: string): string {
    if (enc === "base64") return toBase64(this);
    if (enc === "hex") return Array.from(this, (x) => x.toString(16).padStart(2, "0")).join("");
    return new TextDecoder().decode(this);
  }
}

export const base64Encode = toBase64;
export const base64Decode = fromBase64;

if (!(globalThis as any).Buffer) (globalThis as any).Buffer = BrowserBuffer;
