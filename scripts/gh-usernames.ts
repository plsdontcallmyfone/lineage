#!/usr/bin/env bun
// Generates random GitHub usernames for the purchasable account pool (SPEC 13.9) and checks that
// each is free on GitHub. It never creates accounts: a person registers each one by hand.
//
// Usage: bun scripts/gh-usernames.ts [--count 20] [--style random8|word|syllable|mixed] [--no-check] [--out file]
// Default random8: 8 characters from a-z0-9 drawn with a cryptographic RNG (owner decision 2026-10-07).
//
// Names follow GitHub's rules (1 to 39 characters, letters, digits and single inner hyphens).
// Pronounceable names are the default: strings like "x7q-k2z9" read as a bot farm and draw
// abuse review faster.
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const COUNT = Number(opt("count") ?? 20);
const STYLE = opt("style") ?? "random8";
const CHECK = !argv.includes("--no-check");

const ADJ = ["amber", "brisk", "calm", "cedar", "clever", "cobalt", "coral", "crisp", "dawn", "deft", "dusky", "eager", "ember", "fable", "fern", "frost", "gentle", "glade", "hazel", "ivory", "jade", "keen", "lucid", "lunar", "maple", "mellow", "misty", "noble", "olive", "opal", "pale", "quiet", "rapid", "russet", "sage", "silver", "sly", "solar", "steady", "stone", "sunny", "swift", "tidal", "umber", "vivid", "warm", "wild", "willow", "young", "zesty"];
const NOUN = ["anchor", "badger", "beacon", "birch", "bramble", "canyon", "cinder", "comet", "cove", "crane", "delta", "dune", "falcon", "finch", "fjord", "flint", "grove", "harbor", "heron", "hollow", "island", "kestrel", "lagoon", "lantern", "ledger", "lynx", "marsh", "meadow", "otter", "pebble", "pine", "prairie", "quarry", "raven", "reef", "ridge", "river", "robin", "sparrow", "spruce", "summit", "thicket", "thistle", "tundra", "valley", "walnut", "wren", "yarrow", "zephyr"];
const ONSET = ["b", "br", "c", "d", "dr", "f", "g", "gr", "h", "j", "k", "l", "m", "n", "p", "pr", "r", "s", "st", "t", "tr", "v", "w", "z"];
const VOWEL = ["a", "e", "i", "o", "u", "ai", "ea", "io", "ou"];
const CODA = ["", "", "n", "r", "l", "s", "x", "m", "nd", "rk"];
// never produce names that read as a brand, a person or something offensive
const BLOCK = /(git|hub|admin|support|staff|security|official|anthropic|claude|openai|github|microsoft|lineage|veemo|cellumo|sol|bot|ass|sex|nazi|kill)/;

const pick = <T>(xs: T[]) => xs[randomInt(xs.length)]!;
const syllables = (n: number) => Array.from({ length: n }, () => pick(ONSET) + pick(VOWEL) + pick(CODA)).join("");

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function candidate(): string {
  // owner decision 2026-10-07: 8 fully random characters (crypto RNG), lowercase letters and digits
  if (STYLE === "random8") return Array.from({ length: 8 }, () => ALNUM[randomInt(ALNUM.length)]).join("");
  const style = STYLE === "mixed" ? pick(["word", "word", "syllable"]) : STYLE;
  const digits = randomInt(10, 9999).toString();
  if (style === "syllable") return `${syllables(2)}${pick(["", "-"])}${syllables(1)}${randomInt(2) ? digits : ""}`;
  return `${pick(ADJ)}-${pick(NOUN)}${randomInt(3) ? `-${digits}` : digits}`;
}

const VALID = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const valid = (n: string) => VALID.test(n) && !BLOCK.test(n);

/** 404 from the users API means the login is not taken (it may still be reserved by GitHub). */
async function available(name: string): Promise<boolean | null> {
  const p = Bun.spawnSync(["gh", "api", "-i", `users/${name}`]);
  const head = p.stdout.toString().split("\n")[0] ?? "";
  if (head.includes(" 404")) return true;
  if (head.includes(" 200")) return false;
  return null; // rate limited or offline: unknown
}

const out: { name: string; available: boolean | null }[] = [];
const seen = new Set<string>();
let tries = 0;
while (out.length < COUNT && tries < COUNT * 50) {
  tries++;
  const n = candidate();
  if (seen.has(n) || !valid(n)) continue;
  seen.add(n);
  const a = CHECK ? await available(n) : null;
  if (a === false) continue;
  out.push({ name: n, available: a });
}
for (const r of out) console.log(`${r.name}${r.available === true ? "" : r.available === null ? "   (not checked)" : ""}`);
console.log(`\n${out.length} names, ${out.filter((r) => r.available).length} confirmed free on GitHub right now. Availability can change before someone registers them.`);
if (opt("out")) writeFileSync(opt("out")!, out.map((r) => r.name).join("\n") + "\n");
