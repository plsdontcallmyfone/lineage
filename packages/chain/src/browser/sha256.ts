// SHA-256 in plain TypeScript (FIPS 180-4), synchronous, for the browser build: WebCrypto's digest
// is async, and PDAs, discriminators and protocol hashes are computed synchronously.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private n = 0;
  private len = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array | string): this {
    const d = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.len += d.length;
    let i = 0;
    while (i < d.length) {
      const take = Math.min(64 - this.n, d.length - i);
      this.buf.set(d.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === 64) {
        this.block(this.buf);
        this.n = 0;
      }
    }
    return this;
  }

  private block(b: Uint8Array) {
    const w = this.w;
    for (let t = 0; t < 16; t++) w[t] = (b[t * 4]! << 24) | (b[t * 4 + 1]! << 16) | (b[t * 4 + 2]! << 8) | b[t * 4 + 3]!;
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!, c = w[t - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = this.h as unknown as number[];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[t]! + w[t]!) | 0;
      const S0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const maj = (a! & bb!) ^ (a! & c!) ^ (bb! & c!);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d! + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    const H = this.h;
    H[0] = (H[0]! + a!) | 0; H[1] = (H[1]! + bb!) | 0; H[2] = (H[2]! + c!) | 0; H[3] = (H[3]! + d!) | 0;
    H[4] = (H[4]! + e!) | 0; H[5] = (H[5]! + f!) | 0; H[6] = (H[6]! + g!) | 0; H[7] = (H[7]! + h!) | 0;
  }

  digest(): Uint8Array {
    const bits = this.len * 8;
    const pad = new Uint8Array(((this.n < 56 ? 56 : 120) - this.n) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 2 ** 32), lo = bits >>> 0;
    const L = pad.length;
    pad[L - 8] = hi >>> 24; pad[L - 7] = hi >>> 16; pad[L - 6] = hi >>> 8; pad[L - 5] = hi;
    pad[L - 4] = lo >>> 24; pad[L - 3] = lo >>> 16; pad[L - 2] = lo >>> 8; pad[L - 1] = lo;
    this.update(pad);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const v = this.h[i]!;
      out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v;
    }
    return out;
  }
}

export const sha256Bytes = (...parts: (Uint8Array | string)[]): Uint8Array => {
  const h = new Sha256();
  for (const p of parts) h.update(p);
  return h.digest();
};
