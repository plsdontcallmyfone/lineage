// Swap path proof (SPEC 14.9): builds the real "pay in SOL or USDC, swap to $LINE, then deposit"
// transaction for a mainnet wallet and simulates it on mainnet (sigVerify false,
// replaceRecentBlockhash true). Nothing is signed and nothing is sent: the wallet is a read-only
// public address and every signature slot is zeros.
//
//   bun scripts/swap/simulate.ts [--pay SOL|USDC|both] [--taker <address>] [--usd 10] [--record]
//
// RPC: LINEAGE_MAINNET_RPC when set (printed redacted), else the public mainnet endpoint.
// $LINE does not exist on mainnet yet, so the target is config/swap.json's stand-in mint. The
// deposit is the launch deposit's transferChecked (packages/chain launch.prepay) into a stand-in
// compute vault: the associated token account of launchPdas.computeVault(agent) for a sample agent
// address, created idempotently in the same transaction, because units_launch is not deployed on
// mainnet (refresh_awake is left out for the same reason). --record writes the Jupiter responses
// to packages/chain/test/fixtures/ for the unit tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ata,
  compileMessageV0,
  decodeTokenAccount,
  launchPdas,
  parsePrepayConfig,
  parseSwapConfig,
  planSwapThen,
  PAY_ASSETS,
  quoteForTarget,
  Rpc,
  sha256,
  token,
  TOKEN_PROGRAM,
  toAddress,
  usdToBase,
  type Fetch,
  type Ix,
  type PayAsset,
} from "../../packages/chain/src/index.ts";
import { redactRpc } from "../../packages/chain/src/endpoint.ts";

const ROOT = join(import.meta.dir, "../..");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
/** Binance's public hot wallet: a well-known read-only address holding SOL and USDC. Never signed for. */
const DEFAULT_TAKER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
/** A sample agent address (any 32 bytes; only its compute vault PDA is derived). */
const SAMPLE_AGENT = toAddress(sha256("lineage swap path sample agent"));

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const pays: Exclude<PayAsset, "LINE">[] = (() => {
  const p = arg("pay", "both").toUpperCase();
  return p === "BOTH" ? ["SOL", "USDC"] : [p as "SOL" | "USDC"];
})();
const taker = arg("taker", DEFAULT_TAKER);
const record = process.argv.includes("--record");

const cfg = parseSwapConfig(JSON.parse(readFileSync(join(ROOT, "config/swap.json"), "utf8")));
const prepay = parsePrepayConfig(JSON.parse(readFileSync(join(ROOT, "config/network.json"), "utf8")).prepay);
const usd = arg("usd", prepay.default_usd);
const need = usdToBase(usd, prepay.line_per_usd, cfg.target_decimals);

const rpcUrl = process.env.LINEAGE_MAINNET_RPC || PUBLIC_MAINNET_RPC;
const rpc = Rpc.http(rpcUrl, "confirmed");

const recorded: Record<string, unknown[]> = {};
const recordingFetch: Fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  const key = new URL(url).searchParams;
  if (res.ok) (recorded[`${key.get("inputMint")}`] ??= []).push({ amount: key.get("amount"), body: JSON.parse(text) });
  return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
};
const pause = () => new Promise<void>((r) => setTimeout(r, 2500)); // keyless Jupiter: 0.5 requests per second

const units = (v: bigint, d: number) => {
  const neg = v < 0n, a = neg ? -v : v, s = a.toString().padStart(d + 1, "0");
  return `${neg ? "-" : v > 0n ? "+" : ""}${s.slice(0, -d)}.${s.slice(-d)}`;
};

function unsignedWire(msg: { bytes: Uint8Array; numSigners: number }): Uint8Array {
  const out = new Uint8Array(1 + 64 * msg.numSigners + msg.bytes.length);
  out[0] = msg.numSigners;
  out.set(msg.bytes, 1 + 64 * msg.numSigners);
  return out;
}

let checks = 0, passed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

async function main() {
  console.log(`RPC ${redactRpc(rpcUrl)}; taker ${taker} (read-only, never signed for)`);
  const genesis = await rpc.call<string>("getGenesisHash");
  check("RPC is mainnet-beta", genesis === MAINNET_GENESIS, genesis);
  if (genesis !== MAINNET_GENESIS) process.exit(1);
  console.log(`target ${cfg.target_symbol} ${cfg.target_mint} (${cfg.target_status} for $LINE), ${cfg.target_decimals} decimals`);
  console.log(`deposit ${usd} USD at the ${prepay.rate_status.toUpperCase()} rate ${prepay.line_per_usd} per USD = ${units(need, cfg.target_decimals).slice(1)} ${cfg.target_symbol} (${need} base units)`);

  const vaultOwner = launchPdas.computeVault(SAMPLE_AGENT);
  const tp = cfg.target_token_program;
  const takerTarget = ata(taker, cfg.target_mint, tp);
  const vault = ata(vaultOwner, cfg.target_mint, tp);
  const action: Ix[] = [
    token.createAtaIdempotent(taker, vaultOwner, cfg.target_mint, tp),
    token.transferChecked(takerTarget, cfg.target_mint, vault, taker, need, cfg.target_decimals, tp),
  ];

  for (const pay of pays) {
    console.log(`\n== pay in ${pay}`);
    const q = await quoteForTarget({ cfg, pay, need, taker, fetch: recordingFetch, pause, apiKey: process.env.JUPITER_API_KEY });
    const r = q.route;
    const d = PAY_ASSETS[pay].decimals;
    console.log(`route ${r.path}; in ${units(r.inAmount, d).slice(1)} ${pay}; quoted out ${units(r.outAmount, cfg.target_decimals).slice(1)}; minimum out after ${r.slippageBps} bps ${units(r.minOut, cfg.target_decimals).slice(1)}; price impact ${r.priceImpactPct.toFixed(4)}%; ${q.probes} Jupiter calls`);
    check(`${pay}: quote guarantees the deposit after slippage`, r.minOut >= need, `${r.minOut} >= ${need}`);

    const plan = planSwapThen({ payer: taker, build: q.build, action, cuLimit: 600_000, maxCuPrice: cfg.max_cu_price_micro_lamports });
    console.log(`plan: ${plan.mode === "one" ? "one v0 transaction" : "two transactions (one signing request)"}; ${plan.txs.map((t) => `${t.ixs.length} instructions, ${t.size} bytes, ${t.tables.length} lookup tables`).join("; ")}`);
    check(`${pay}: swap and deposit fit one transaction`, plan.mode === "one");

    const { blockhash } = await rpc.getLatestBlockhash();
    const tx = plan.txs[0]!;
    const msg = compileMessageV0(taker, tx.ixs, blockhash, tx.tables);
    const all = [...msg.keys, ...msg.loaded.writable, ...msg.loaded.readonly];
    const watch = [taker, ata(taker, PAY_ASSETS[pay].mint, TOKEN_PROGRAM), takerTarget, vault];
    const names = ["taker SOL", `taker ${pay === "SOL" ? "wSOL" : "USDC"} account`, `taker ${cfg.target_symbol} account`, `stand-in compute vault ${cfg.target_symbol} account`];
    const missing = watch.filter((w) => !all.includes(w));
    if (missing.length) console.log(`(not in the message: ${missing.join(", ")})`);
    const before = await rpc.getMultipleAccounts(watch);
    const sim = await rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts: ({ lamports: number; data: [string, string] } | null)[] | null } }>(
      "simulateTransaction",
      [Buffer.from(unsignedWire(msg)).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: watch } }],
    );
    const v = sim.value;
    check(`${pay}: simulation succeeds`, v.err === null, v.err === null ? `${v.unitsConsumed} compute units` : JSON.stringify(v.err));
    if (v.err !== null) console.log((v.logs ?? []).slice(-15).join("\n"));
    const after = v.accounts ?? [];
    console.log("simulated balance changes:");
    const tokenAmt = (data: Uint8Array | null) => (data && data.length >= 165 ? decodeTokenAccount(data).amount : 0n);
    const net = { lamports: 0n };
    watch.forEach((a, i) => {
      const b = before[i], x = after[i];
      const lam = (x ? BigInt(x.lamports) : 0n) - (b ? b.lamports : 0n);
      const tb = i === 0 ? null : tokenAmt(b?.data ?? null);
      const ta = i === 0 ? null : tokenAmt(x ? new Uint8Array(Buffer.from(x.data[0], "base64")) : null);
      const tokenDelta = tb !== null && ta !== null ? ta - tb : null;
      const dec = i === 1 ? d : cfg.target_decimals;
      if (i === 0 || (i === 1 && pay === "SOL")) net.lamports += lam;
      console.log(`  ${names[i]!.padEnd(40)} ${a}  lamports ${units(lam, 9)} SOL${tokenDelta !== null ? `, tokens ${units(tokenDelta, dec)}` : ""}${!b && x ? " (created)" : ""}`);
      if (i === 3 && v.err === null) check(`${pay}: the vault receives exactly the deposit`, tokenDelta === need, `${tokenDelta} = ${need}`);
      if (i === 2 && v.err === null && tokenDelta !== null) check(`${pay}: the taker keeps the swap surplus (>= 0)`, tokenDelta >= 0n, `${tokenDelta}`);
    });
    console.log(`  net SOL of the taker (native plus wSOL, fees and rent included): ${units(net.lamports, 9)} SOL`);
  }

  if (record) {
    const dir = join(ROOT, "packages/chain/test/fixtures");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "jupiter-build.json");
    writeFileSync(file, JSON.stringify({ recorded_at: new Date().toISOString(), taker, need: need.toString(), target: cfg.target_mint, responses: recorded }, null, 1) + "\n");
    console.log(`\nrecorded ${Object.values(recorded).flat().length} Jupiter responses to ${file.slice(ROOT.length + 1)}`);
  }
  console.log(`\n${passed}/${checks} checks passed; nothing was signed or sent`);
  process.exit(passed === checks ? 0 : 1);
}

await main();
