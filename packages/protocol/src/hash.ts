import { createHash } from "node:crypto";
import type { Hex } from "./types.ts";

/** Sorted-key JSON with no whitespace. Rejects values that have no stable encoding. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): Hex {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Domain-separated hash of a tuple. SPEC writes H(a | b | c); the encoding is the canonical JSON
 * array of the parts, which is unambiguous even when a part contains the separator.
 */
export function H(...parts: (string | number)[]): Hex {
  return sha256Hex(canonicalJson(parts));
}

export function hashJson(value: unknown): Hex {
  return sha256Hex(canonicalJson(value));
}
