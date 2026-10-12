#!/usr/bin/env bun
// Prints a verifier key's agent id (its public key) and a capabilities file's digest, one per line.
// Never prints the key.   bun scripts/deploy/capacity-host/verifier-id.ts <key.json> <caps.json>
import { readFileSync } from "node:fs";
import { canonicalJson, H, keyFromSolanaJson } from "@units/protocol";

const [keyFile, capsFile] = process.argv.slice(2);
if (!keyFile || !capsFile) throw new Error("usage: verifier-id.ts <key.json> <caps.json>");
console.log(keyFromSolanaJson(JSON.parse(readFileSync(keyFile, "utf8"))).id);
console.log(H("caps", canonicalJson(JSON.parse(readFileSync(capsFile, "utf8")))));
