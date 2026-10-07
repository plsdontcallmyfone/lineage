import { sha256Hex } from "./hash.ts";
import type { Hex } from "./types.ts";

/**
 * Deterministic PRNG seeded from a hex string (sfc32). Used wherever a random choice must be
 * recomputable from public inputs: assignment, bootstrap resampling, canary selection.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: Hex) {
    const h = sha256Hex("rng:" + seed);
    this.a = parseInt(h.slice(0, 8), 16) >>> 0;
    this.b = parseInt(h.slice(8, 16), 16) >>> 0;
    this.c = parseInt(h.slice(16, 24), 16) >>> 0;
    this.d = parseInt(h.slice(24, 32), 16) >>> 0;
    for (let i = 0; i < 15; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (n <= 0) throw new Error("Rng.int: n must be positive");
    return Math.floor(this.next() * n);
  }
}
