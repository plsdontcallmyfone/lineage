// No RPC key in what a browser downloads (M3, SPEC 14.10). Builds the deployable static output
// (scripts/deploy/vercel/build.ts: dashboard bundle, wallet bundle, pages, docs) under the mainnet
// profile with a sentinel keyed RPC in the environment, plus the two bundles the dashboard server
// builds, and greps every byte for the sentinel, for any key-bearing RPC URL, and for the real keys
// in ~/.config/lineage/rpc.env (read here, never printed).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chainBrowserPlugin } from "../../../packages/chain/src/browser/plugin.ts";

const ROOT = join(import.meta.dir, "../../..");
const SENTINEL = "m3leaksentinel7b2f9c4e1d";
const env = { ...process.env, LINEAGE_NETWORK: "mainnet", LINEAGE_MAINNET_RPC: `https://mainnet.rpc.invalid/?api-key=${SENTINEL}`, HELIUS_MAINNET_RPC: `https://mainnet.rpc.invalid/?api-key=${SENTINEL}` };

/** Secret values that must never appear: the sentinel, and the real keys of the local rpc.env (values only, not printed). */
function secrets(): string[] {
  const out = [SENTINEL];
  const f = join(homedir(), ".config/lineage/rpc.env");
  if (existsSync(f))
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*[A-Z0-9_]+\s*=\s*"?([^"\s]+)"?\s*$/.exec(line);
      if (!m) continue;
      try {
        const u = new URL(m[1]!);
        for (const v of u.searchParams.values()) if (v.length >= 8) out.push(v);
        for (const seg of u.pathname.split("/")) if (seg.length >= 16) out.push(seg);
      } catch {
        /* not a URL */
      }
    }
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const out = mkdtempSync(join(tmpdir(), "lineage-leak-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function check(name: string, text: string) {
  for (const s of secrets()) expect({ name, leaked: text.includes(s) }).toEqual({ name, leaked: false });
  expect({ name, keyedUrl: /api-key=|helius-rpc\.com/i.test(text) }).toEqual({ name, keyedUrl: false });
}

describe("built browser output carries no RPC key", () => {
  test("static deploy output (vercel build) under the mainnet profile", () => {
    const r = Bun.spawnSync(["bun", join(ROOT, "scripts/deploy/vercel/build.ts"), "--out", out], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const all = files(out);
    expect(all.some((f) => f.endsWith("assets/wallet.js"))).toBe(true);
    expect(all.some((f) => f.endsWith("assets/app.js"))).toBe(true);
    for (const f of all) {
      if (/\.(woff2|png|jpg|ico)$/.test(f)) continue;
      check(f.slice(out.length + 1), readFileSync(f, "utf8"));
    }
  }, 120_000);

  test("the dashboard server's bundles (app and wallet) with the env set as on the server", async () => {
    const saved = { n: process.env.LINEAGE_NETWORK, r: process.env.LINEAGE_MAINNET_RPC };
    process.env.LINEAGE_NETWORK = env.LINEAGE_NETWORK;
    process.env.LINEAGE_MAINNET_RPC = env.LINEAGE_MAINNET_RPC;
    try {
      const app = await Bun.build({ entrypoints: [join(ROOT, "apps/web/src/main.ts")], target: "browser", minify: true });
      const wallet = await Bun.build({ entrypoints: [join(ROOT, "apps/web/wallet/main.ts")], target: "browser", format: "esm", minify: true, plugins: [chainBrowserPlugin] });
      expect(app.success && wallet.success).toBe(true);
      const a = await app.outputs[0]!.text();
      const w = await wallet.outputs[0]!.text();
      check("app.js", a);
      check("wallet.js", w);
      // the browser reaches the chain only through the same-origin proxy
      expect(w).toContain("/chain/rpc");
      expect(w).not.toMatch(/https:\/\/api\.mainnet-beta\.solana\.com/);
    } finally {
      if (saved.n === undefined) delete process.env.LINEAGE_NETWORK;
      else process.env.LINEAGE_NETWORK = saved.n;
      if (saved.r === undefined) delete process.env.LINEAGE_MAINNET_RPC;
      else process.env.LINEAGE_MAINNET_RPC = saved.r;
    }
  }, 120_000);
});

test("the grep catches a planted key (the check is live)", () => {
  expect(() => check("planted", `fetch("https://mainnet.rpc.invalid/?api-key=${SENTINEL}")`)).toThrow();
  expect(() => check("planted", `x="https://x.helius-rpc.com/"`)).toThrow();
});
