import { expect, test } from "bun:test";
import { hashJson } from "@units/protocol";
import { BOUNTY_ACCOUNT_LEN, BOUNTY_LEDGER_LEN, planBounty, type PlanInput } from "../wallet/bounty-plan.ts";
import { bountyCard, bpsPct, span, targetWords, type BountyRow } from "../src/pages/bounties.ts";
import { state } from "../src/api.ts";
import { setUsdReading } from "../src/usd.ts";

// The post form's rules (docs/plans/OPEN-BOUNTIES.md 4.1, 5): every limit is the onchain BountyConfig,
// the lowest requirement is the metric's own minimum, the reward entered in dollars becomes an exact
// coin amount at the current price, and the review's SOL figure is the rent of the accounts created.

const cfg = { maxBountyOutBps: 5000, selfHostedInCap: 0n, windowS: 86400, minTtlS: 60, maxTtlS: 2_592_000, refundGraceS: 60, minAmount: 2_000_000_000n, paused: false };
const base: PlanInput = {
  usd: 500, unitsText: null, priceUsd: 0.02, decimals: 6, hours: 72, nowS: 1_800_000_000, lineageId: "ab".repeat(32),
  metric: { name: "encode_ir", min_improvement_bps: 100 }, pct: 10, note: "  make it faster  ", cfg, vaultBalance: 100_000_000_000n, ledger: null,
  rent: { bounty: 3_201_600n, vault: 2_074_080n, ledger: 1_566_000n },
};

test("a valid plan: exact coin amount from dollars, deadline, terms and their digest, the target condition, the rent", () => {
  const p = planBounty(base);
  if (!p.ok) throw new Error(p.error);
  expect(p.amount).toBe(25_000_000_000n); // $500 at $0.02 with six decimals
  expect(p.deadline).toBe(1_800_000_000n + 72n * 3600n);
  expect(p.minImprovementBps).toBe(1000);
  expect(p.terms).toEqual({ v: 1, kind: "improvement", lineage_id: "ab".repeat(32), metric: "encode_ir", min_improvement_bps: 1000, note: "make it faster" });
  expect(p.termsDigest).toBe(hashJson(p.terms));
  expect(p.conditionValue).toBe(hashJson("encode_ir"));
  expect(p.rentLamports).toBe(3_201_600n + 2_074_080n + 1_566_000n);
  expect(p.rentReturned).toBe(2_074_080n);
  // the ledger exists after an agent's first bounty: its rent is not paid again
  const again = planBounty({ ...base, ledger: { outWindow: 0n, outBase: 0n, outAmount: 0n } });
  expect(again.ok && again.rentLamports).toBe(3_201_600n + 2_074_080n);
  // no dollar price: the reward is entered in the coin
  const coin = planBounty({ ...base, usd: null, priceUsd: null, unitsText: "2500.5" });
  expect(coin.ok && coin.amount).toBe(2_500_500_000n);
});

test("every onchain limit refuses in words", () => {
  const err = (over: Partial<PlanInput>) => {
    const p = planBounty({ ...base, ...over });
    return p.ok ? "ok" : p.error;
  };
  expect(err({ usd: 10 })).toMatch(/smallest reward/i);
  expect(err({ usd: 5000 })).toMatch(/compute balance holds/i);
  expect(err({ usd: 1500 })).toMatch(/at most 50% of its compute balance/i); // 75,000 of 100,000
  // inside a window the cap counts what was already escrowed against the balance at the window's first open
  const w = BigInt(Math.floor(1_800_000_000 / 86400));
  expect(err({ ledger: { outWindow: w, outBase: 60_000_000_000n, outAmount: 10_000_000_000n } })).toMatch(/at most 50%/i); // 10,000 + 25,000 > 30,000
  expect(err({ ledger: { outWindow: w - 1n, outBase: 60_000_000_000n, outAmount: 10_000_000_000n } })).toBe("ok"); // a new window starts from the balance now
  expect(err({ hours: 0.01 })).toMatch(/deadline/i);
  expect(err({ hours: 24 * 31 })).toMatch(/deadline/i);
  expect(err({ pct: 0.5 })).toMatch(/at least 1%/i);
  expect(err({ pct: 100 })).toMatch(/below 100%/i);
  expect(err({ pct: Number.NaN })).toMatch(/improvement/i);
  expect(err({ usd: null, unitsText: null })).toMatch(/reward/i);
  expect(err({ usd: 500, priceUsd: null })).toMatch(/reward/i);
  expect(err({ cfg: { ...cfg, paused: true } })).toMatch(/paused/i);
  expect(err({ cfg: { ...cfg, maxBountyOutBps: 0 } })).toMatch(/at most 0%/i);
});

test("the account sizes are the program's (8 byte discriminator plus the struct)", async () => {
  const src = await Bun.file(new URL("../../../onchain/programs/units-launch/src/bounty.rs", import.meta.url)).text();
  const size: Record<string, number> = { Pubkey: 32, u64: 8, i64: 8, u8: 1, "[u8; 32]": 32 };
  const len = (name: string) => {
    const body = new RegExp(`pub struct ${name} \\{([^}]*)\\}`).exec(src)![1]!;
    return 8 + [...body.matchAll(/pub \w+: ([^,]+),/g)].reduce((a, m) => a + size[m[1]!.trim()]!, 0);
  };
  expect(BOUNTY_ACCOUNT_LEN).toBe(len("Bounty"));
  expect(BOUNTY_LEDGER_LEN).toBe(len("BountyLedger"));
});

test("the page's words: target, percentages, spans, and a card with the reward in dollars and the coin amount", () => {
  expect(bpsPct(1000)).toBe("10%");
  expect(bpsPct(250)).toBe("2.5%");
  expect(span(2_592_000)).toBe("30 days");
  expect(span(90_000)).toBe("1 day 1 hour");
  expect(span(60)).toBe("1 minute");
  const row: BountyRow = {
    bounty_id: "B".repeat(44), payer: "P".repeat(44), opener: "O".repeat(44), payee: null, amount: "25000000000", deadline: 1_800_259_200, created_at: 1_800_000_000, min_epoch: 3,
    status: "open", state: "open", lineage_id: "ab".repeat(32), repo: "https://github.com/keis/base58", recipe_name: "base58-py", condition_kind: "target",
    metric: { name: "encode_ir", kind: "perf", direction: "lower" }, any_target: false, required: { bps: 1000, source: "terms" }, note: null, working: ["W".repeat(44)],
    winner: null, released_to: null, released_epoch: null, closed_at: null, chain_sig: null,
  };
  expect(targetWords(row)).toBe("Lower encode_ir by at least 10% in one verified change");
  expect(targetWords({ ...row, metric: { ...row.metric!, direction: "higher" } })).toBe("Raise encode_ir by at least 10% in one verified change");
  expect(targetWords({ ...row, metric: null, required: null, any_target: true })).toBe("Any verified improvement on this unit");
  state.cfg = { token_decimals: 6 } as never;
  setUsdReading({ ok: true, usd: 0.02, read_at: 1, age_s: 0, sol_usd: 150, pair: "SOL", venue: "pool" });
  const card = bountyCard(row, new Map(), 1_800_000_000).s;
  expect(card).toContain("$500.00");
  expect(card).toContain("25,000.00 $UNITS");
  expect(card).toContain("3 days left");
  expect(card).toContain("1 agent");
  expect(card).toContain('href="/bounties/' + "B".repeat(44));
  expect(card).not.toContain(String.fromCharCode(0x2014));
  const won = bountyCard({ ...row, state: "decided", working: [], winner: { gen_id: "cd".repeat(32), author: "A".repeat(44), height: 7, epoch: 4, improvement_bps: 1500, accepted_at: 1 } }, new Map(), 1_800_000_000).s;
  expect(won).toContain("Won, payout pending");
  expect(won).toContain("generation 7");
  expect(won).toContain("15% better");
});

// ---------- bounties any wallet posts (the escrow program) ----------

import { OPEN_BOUNTY_ACCOUNT_LEN } from "../../../packages/chain/src/open-bounty.ts";
import { ESCROW_BOUNTY_ACCOUNT_LEN, planEscrowBounty, type EscrowInput } from "../wallet/bounty-plan.ts";

const ecfg = { minAmount: 1_000_000n, minTtlS: 3600, maxTtlS: 2_592_000, refundGraceS: 86_400, contestS: 3600, feeBps: 0, paused: false };
const ebase: EscrowInput = {
  usd: 500, unitsText: null, priceUsd: 0.02, decimals: 6, hours: 72, nowS: 1_800_000_000, lineageId: "ab".repeat(32), metric: { name: "encode_ir", min_improvement_bps: 100 },
  pct: 10, note: " make it faster ", cfg: ecfg, walletCoin: 30_000_000_000n, walletLamports: 50_000_000n, rent: { bounty: 3_250_320n, vault: 2_074_080n }, feeLamports: 5_300n,
};

test("any wallet: the exact coin amount from dollars, the terms the chain enforces, the rent, and what the winner receives", () => {
  expect(ESCROW_BOUNTY_ACCOUNT_LEN).toBe(OPEN_BOUNTY_ACCOUNT_LEN);
  const p = planEscrowBounty(ebase);
  if (!p.ok) throw new Error(p.error);
  expect(p.amount).toBe(25_000_000_000n);
  expect(p.deadline).toBe(1_800_000_000n + 72n * 3600n);
  expect(p.minImprovementBps).toBe(1000);
  expect(p.terms).toEqual({ v: 1, kind: "improvement", lineage_id: "ab".repeat(32), metric: "encode_ir", min_improvement_bps: 1000, note: "make it faster" });
  expect([p.termsDigest, p.targetDigest]).toEqual([hashJson(p.terms), hashJson("encode_ir")]);
  expect([p.rentLamports, p.rentReturned]).toEqual([3_250_320n + 2_074_080n, 2_074_080n]);
  expect([p.winnerGets, p.fee]).toEqual([25_000_000_000n, 0n]);
  const fee = planEscrowBounty({ ...ebase, cfg: { ...ecfg, feeBps: 250 } });
  expect(fee.ok && [fee.winnerGets, fee.fee]).toEqual([24_375_000_000n, 625_000_000n]);
});

test("any wallet: a wallet that holds SOL but not enough of the coin is told exactly what it needs", () => {
  const p = planEscrowBounty({ ...ebase, walletCoin: 12_500_000_000n });
  expect(p.ok).toBe(false);
  if (p.ok) return;
  expect(p.short).toEqual({ coin: 12_500_000_000n, needCoin: 12_500_000_000n, lamports: 50_000_000n, needLamports: 0n });
  expect(p.error).toBe("This wallet cannot post this bounty yet: the reward is 25,000 coins and this wallet holds 12,500: it needs 12,500 more.");
  const none = planEscrowBounty({ ...ebase, walletCoin: 0n, walletLamports: 1_000n });
  expect(!none.ok && none.short).toEqual({ coin: 0n, needCoin: 25_000_000_000n, lamports: 1_000n, needLamports: 3_250_320n + 2_074_080n + 5_300n - 1_000n });
  expect(!none.ok && none.error).toContain("posting costs 0.005330 SOL and this wallet holds 0.000001");
});

test("any wallet: a reward far beyond the wallet quotes what the wallet really holds, never a stand-in figure", () => {
  // $3,300,000 of a coin worth $0.00000033 is about 1e19 base units: above a 62-bit balance, inside the chain's 64 bits. The
  // message names this wallet's own 11 coins.
  const p = planEscrowBounty({ ...ebase, usd: 3_300_000, priceUsd: 3.3e-7, walletCoin: 11_000_000n });
  expect(p.ok).toBe(false);
  if (p.ok) return;
  const amount = BigInt(Math.floor((3_300_000 / 3.3e-7) * 1e6));
  expect(amount > 2n ** 62n).toBe(true);
  expect(p.short).toEqual({ coin: 11_000_000n, needCoin: amount - 11_000_000n, lamports: 50_000_000n, needLamports: 0n });
  expect(p.error).toContain("this wallet holds 11:");
  // a figure the chain's 64 bits cannot hold is refused as such
  const huge = planEscrowBounty({ ...ebase, usd: 1e12, priceUsd: 3.3e-7 });
  expect(!huge.ok && huge.error).toBe("That reward is more of the coin than exists.");
});

test("any wallet: every onchain limit refuses in words", () => {
  const err = (over: Partial<EscrowInput>) => {
    const p = planEscrowBounty({ ...ebase, ...over });
    return p.ok ? null : p.error;
  };
  expect(err({ cfg: { ...ecfg, paused: true } })).toBe("Bounties are paused.");
  expect(err({ usd: 0.01 })).toBe("The smallest reward is 1 coins.");
  expect(err({ hours: 0.5 })).toContain("The deadline is between 60 minutes and 30 days away.");
  expect(err({ hours: 31 * 24 })).toContain("The deadline is between");
  expect(err({ pct: 0.5 })).toBe("This metric counts an improvement of at least 1%; require that or more.");
  expect(err({ pct: 100 })).toBe("The improvement required is below 100%.");
  expect(err({ usd: null, priceUsd: null, unitsText: "abc" })).toBe("Enter the reward.");
  expect(err({ priceUsd: null })).toContain("there is no dollar price right now");
});
