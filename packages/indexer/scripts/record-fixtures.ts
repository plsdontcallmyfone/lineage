#!/usr/bin/env bun
// Records real devnet transactions (and the decoding context of their token) as unit-test fixtures:
//   bun packages/indexer/scripts/record-fixtures.ts
// Run once; the tests never touch the network. The RPC URL is resolved and never printed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rpc } from "@lineage/chain";
import { devnetRpcUrl, redactRpc } from "@lineage/chain/src/endpoint.ts";
import { openDb } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import { throttledTransport } from "../src/rpc.ts";

const FIX: { name: string; mint: string; sig: string; what: string }[] = [
  { name: "dbc-buy", mint: "3AvZ77ZdVPx7yxtqA4UP11DoaPdjdgP3AUbkSnidsmY4", what: "DBC swap2 buy with 100,000 tLINE (onchain/DEVNET.md trade 1)",
    sig: "22t5VJqUFFotAMBi2MqNyHeT9MGgWvAReRvGQgAnfXyQsMjVTJun1YzrG3pK7GBwAQcQfCKbfKpKvcBgrZmrVMpb" },
  { name: "dbc-sell", mint: "3AvZ77ZdVPx7yxtqA4UP11DoaPdjdgP3AUbkSnidsmY4", what: "DBC sell",
    sig: "pemem7Vi8A9bwKbDFTyZ2RqSjrJzuKj3uJwHUK9tL22wTVhMYiQfR58Smzf6fBkNZX8WGga3a6mVGSaoBTdx6Mw" },
  { name: "launch", mint: "3AvZ77ZdVPx7yxtqA4UP11DoaPdjdgP3AUbkSnidsmY4", what: "launch_agent of the minbpe TEST agent",
    sig: "m6i7TWPRyteP74E9EgikqYJ3fDNbeFHYwzCB9EA3EysyuAkzMA2naZAJVnZNB2CvBsonakNAX3Qvm6fYZHDy8Te" },
  { name: "crank-fees", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "crank_fees on the curve (L1 graduation run)",
    sig: "5GE692Wbb7g3XxKy8nfXuCk6SEmBy6f92vuU625pQhTuUa8Ns1pt9iSyPjhzahQthQzmWGmZn9fzrpvkAaN4VcHC" },
  { name: "curve-fill", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "PartialFill buy that completes the curve",
    sig: "4HRQQZLrssiiE628hihVX1mdHtrey9eUqNChFtYCK6YWkXHj5HBC2nesajzsJzVUKiduE2taJjYt4vv6E5iF2foc" },
  { name: "migration", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "Meteora DBC migration_damm_v2",
    sig: "2t7gGK2G5AVY5h7ETNVCgwkwmZVsaga2W1Hfr53eVkoTJcoXCKuhg8eTseKAZeh2XiSokTjypxeGYwD8zpbjt5ZU" },
  { name: "graduate", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "lineage_launch graduate",
    sig: "45KsTw5VkWHEaWFm2SekcYqVPhbNxdK6sJnsbuNTKyw3pW5VDFeDXeQLSRs15FDaMrwEZKHAFvraVCFNa8BJLtZU" },
  { name: "repoint", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "lineage_launch repoint_position",
    sig: "3zn9K1ZAzuy6QjY9bCyGSpumkaAMH3199dAu5QzP8JAiDL8u52yJPV13o53DWdrBg6tXtwRqQ1LoPfEJPPLPcRif" },
  { name: "damm-buy", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "DAMM v2 buy with 200,000 tLINE",
    sig: "4GtTHiSzF39LJtndbTgwtfLDBwioBWee6uGm1qrvwHqZWrEKAfTmAxhpLf6AvakuXFUqAKo6MiHWGHZ6F1tcHyf2" },
  { name: "damm-sell", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "DAMM v2 sell of 4011979457935 base units",
    sig: "3NnnED1Q2GYDaioL27Zv2p8aKyPrmZmiG4qemqxWa66qCn2rc5wthkEu2M5f53PhzToPtci7bFB2o9wVRyZK8EXn" },
  { name: "crank-pool-fees", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "crank_pool_fees (repointed position)",
    sig: "dC5P7KcVvgGvTGcFNkzfnjppuob9Xhv8B3g76RfnWmje547UNCYNaXAfipqkv237NoVDX1u15u2Xc4skFD1vxVt" },
  { name: "add-liquidity", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "DAMM v2 add_liquidity + permanent_lock_position (deployer)",
    sig: "482eBJmn5S3xcAgyYF2xhxmiLspDHyUHHMm2c4WtGcF6of14yK81hAzQQvkCiRzYzN4x13e5WXaBUrQ1Ts2S4wFM" },
  { name: "damm-buy-2", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "DAMM v2 buy with 200,000 tLINE (repointed position)",
    sig: "ejSb3Y45BcLphC1f5WQ1kKjTxkiujtMx5ZrH6s3GcdCr4NFjaY6Q7U1FsaTxMm9btpGH89VUANc8i6Cv1BGRMWx" },
  { name: "damm-sell-2", mint: "AbBT1Mh3mQJgMfVVfKj8zUZhD4mLw5NqbJptFUacb9Zz", what: "DAMM v2 sell of 2641779346064 base units",
    sig: "5KNVbANFmNnqaicQTp46YZk4ktiuU77qu2178UuexndurXcGKW4HVSoSM3anYYgAJkrJ8ufBUMXYe5VtkBFWiWEA" },
];
const only = process.argv.slice(2);

const url = devnetRpcUrl();
console.log(`rpc ${redactRpc(url)}`);
const rpc = new Rpc(throttledTransport(url).transport);
const db = openDb(":memory:");
const ix = new Indexer(db, rpc);
await ix.discover();
await ix.refreshState();
const dir = join(import.meta.dir, "../test/fixtures");
for (const f of FIX.filter((x) => !only.length || only.includes(x.name))) {
  const t = db.query("SELECT * FROM tokens WHERE mint = ?").get(f.mint) as Record<string, string | number | null>;
  const ctx = {
    mint: f.mint, lineMint: ix.lineMint, dbcPool: t.dbc_pool, dbcBaseVault: t.dbc_base_vault, dbcQuoteVault: t.dbc_quote_vault,
    dammPool: t.damm_pool, dammBaseVault: t.damm_base_vault, dammQuoteVault: t.damm_quote_vault, baseDecimals: t.decimals, quoteDecimals: ix.lineDecimals,
  };
  const tx = await rpc.call("getTransaction", [f.sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) throw new Error(`${f.name}: not found`);
  writeFileSync(join(dir, `${f.name}.json`), JSON.stringify({ name: f.name, what: f.what, recorded_at: new Date().toISOString(), ctx, tx }, null, 1) + "\n");
  console.log(`${f.name} ok`);
}
