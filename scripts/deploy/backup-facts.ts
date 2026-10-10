#!/usr/bin/env bun
// Public facts about the site's secrets+state data, for backups (docs/DEPLOY-SITE.md "Backups"). Never
// prints a secret: only public keys, a sha256 of the identity key file, record names and whether each
// identity record authenticates under that key.
//
//   bun scripts/deploy/backup-facts.ts facts --part state|identity --root <dir>
//       <dir> is "/" on the server, or an extracted snapshot's files/ directory on the owner's machine
//   bun scripts/deploy/backup-facts.ts compare <snapshot facts.json> <live facts.json>
//       exit 0 when every key in the snapshot equals the live one by public key (and, for identity, the
//       key file and every record match); keys made after the snapshot are reported, not failed
//
// The parts (scripts/deploy/backup.sh secrets):
//   state     the hosted runtime's agent keys (var/lib/lineage/runtime/keys/<pubkey>.json) and the
//             site's own keys made on the server (home/lineage/.config/lineage/site/*.json)
//   identity  the identity service's key file (etc/lineage-identity/master.key) and its encrypted
//             records (var/lib/lineage/identity/records/<kind>/<id>.enc)
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EncryptedStore } from "../../packages/identity/src/store.ts";
import { pubOf } from "./site-keys.ts";

export const RUNTIME_KEYS = "var/lib/lineage/runtime/keys";
export const SITE_KEYS_DIR = "home/lineage/.config/lineage/site";
export const IDENTITY_DIR = "var/lib/lineage/identity";
export const IDENTITY_KEY = "etc/lineage-identity/master.key";

export interface StateFacts {
  part: "state";
  runtime_keys: Record<string, string>;
  /** runtime key files whose name is not their public key */
  misnamed: string[];
  site_keys: Record<string, string>;
}
export interface IdentityFacts {
  part: "identity";
  key_sha256: string | null;
  records: string[];
  /** records that decrypt and authenticate under the key file */
  authenticated: number;
}
export type Facts = StateFacts | IdentityFacts;

function keyDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) out[f.slice(0, -5)] = pubOf(join(dir, f));
  return out;
}

export function facts(part: string, root: string): Facts {
  if (part === "state") {
    const runtime_keys = keyDir(join(root, RUNTIME_KEYS));
    return {
      part,
      runtime_keys,
      misnamed: Object.entries(runtime_keys).filter(([n, p]) => n !== p).map(([n]) => n),
      site_keys: keyDir(join(root, SITE_KEYS_DIR)),
    };
  }
  if (part === "identity") {
    const keyFile = join(root, IDENTITY_KEY);
    const recDir = join(root, IDENTITY_DIR, "records");
    const records: string[] = [];
    if (existsSync(recDir))
      for (const kind of readdirSync(recDir).sort())
        for (const f of existsSync(join(recDir, kind)) ? readdirSync(join(recDir, kind)).sort() : [])
          if (f.endsWith(".enc")) records.push(`${kind}/${f.slice(0, -4)}`);
    if (!existsSync(keyFile)) return { part, key_sha256: null, records, authenticated: 0 };
    const key_sha256 = createHash("sha256").update(readFileSync(keyFile)).digest("hex");
    let authenticated = 0;
    const store = new EncryptedStore(join(root, IDENTITY_DIR), keyFile);
    for (const r of records) {
      const [kind, id] = r.split("/") as [string, string];
      try {
        store.get(kind, id);
        authenticated++;
      } catch {
        // counted as not authenticated; the record's content is never shown
      }
    }
    return { part, key_sha256, records, authenticated };
  }
  throw new Error(`unknown part ${part} (state or identity)`);
}

/** Lines describing the comparison, and whether the snapshot matches the live data. */
export function compare(snap: Facts, live: Facts): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const bad = (m: string) => {
    ok = false;
    lines.push(`FAIL ${m}`);
  };
  if (snap.part !== live.part) return { ok: false, lines: [`FAIL parts differ (${snap.part}, ${live.part})`] };
  if (snap.part === "state" && live.part === "state") {
    for (const [label, a, b] of [["runtime agent keys", snap.runtime_keys, live.runtime_keys], ["site keys", snap.site_keys, live.site_keys]] as const) {
      const names = Object.keys(a);
      const same = names.filter((n) => b[n] === a[n]);
      for (const n of names) if (!(n in b)) bad(`${label}: ${n} is in the snapshot but not live`);
      else if (b[n] !== a[n]) bad(`${label}: ${n} differs (snapshot ${a[n]}, live ${b[n]})`);
      const newer = Object.keys(b).filter((n) => !(n in a));
      lines.push(`${same.length === names.length && names.length > 0 ? "ok  " : names.length === 0 ? "note" : "FAIL"} ${label}: ${same.length} of ${names.length} in the snapshot equal the live ones by public key${newer.length ? `; ${newer.length} live key(s) made after the snapshot` : ""}`);
    }
    if (snap.misnamed.length) bad(`runtime key files not named by their public key: ${snap.misnamed.join(", ")}`);
  } else if (snap.part === "identity" && live.part === "identity") {
    if (!snap.key_sha256) bad("identity key file missing from the snapshot");
    else if (snap.key_sha256 !== live.key_sha256) bad("identity key file differs from the live one");
    else lines.push("ok   identity key file equals the live one (by sha256)");
    if (snap.authenticated !== snap.records.length) bad(`${snap.records.length - snap.authenticated} of ${snap.records.length} snapshot records do not authenticate under the snapshot's key`);
    else lines.push(`ok   ${snap.authenticated} of ${snap.records.length} identity records decrypt and authenticate under the snapshot's key`);
    const gone = snap.records.filter((r) => !live.records.includes(r));
    const newer = live.records.filter((r) => !snap.records.includes(r));
    lines.push(`note identity records: ${snap.records.length} in the snapshot, ${live.records.length} live${gone.length ? `, ${gone.length} removed since` : ""}${newer.length ? `, ${newer.length} added since` : ""}`);
  }
  return { ok, lines };
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (n: string) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  if (cmd === "facts") {
    console.log(JSON.stringify(facts(arg("part") ?? "", arg("root") ?? "/")));
  } else if (cmd === "compare") {
    const [a, b] = rest as [string, string];
    const r = compare(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")));
    for (const l of r.lines) console.log(l);
    process.exit(r.ok ? 0 : 1);
  } else {
    console.error("usage: backup-facts.ts facts --part state|identity --root <dir> | compare <snapshot.json> <live.json>");
    process.exit(2);
  }
}
