// Lineage harness helper (recipe overlay, protected): a seeded stream of engine transactions for
// the percolator v16 risk engine, shared by lineage_bench and lineage_equiv.
//
// A world is one market group (1, 2 or 4 assets), six portfolio accounts and a list of operations.
// Everything a world is made from (configuration preset, opening prices, the size of the money in
// it, every operation and its parameters) is drawn from the seed and from nothing else, so the
// inputs do not depend on what the engine answers. Parameters that only make sense against
// live state are stored as relative numbers (slots to advance, a price move in basis points, a
// share of an account's capital) and resolved from public account fields when the operation runs.
//
// One operation is one transaction of a wrapper program: it may make several engine calls (a trade
// refreshes both accounts first, as the engine requires for favourable actions). The engine's
// contract is that a failed call runs under transaction rollback (README: "an Err must not commit
// partial mutation"), so the harness restores the state from before the operation whenever a call
// answers Err or panics, and what a failed call left behind is never observed.
use percolator::{
    AutoCrankObservationV16, AutoCrankWorkV16, EngineAssetSlotV16Account, LiquidationRequestV16,
    Market, MarketGroupV16HeaderAccount, MarketGroupV16ViewMut, PortfolioAccountV16Account,
    PortfolioV16View, PortfolioV16ViewMut, ProvenanceHeaderV16, ProvenanceHeaderV16Account,
    RebalanceRequestV16, SideV16, TradeRequestV16, V16Config, V16Result, MAX_ORACLE_PRICE, POS_SCALE,
};
use std::fmt::Debug;
use std::hint::black_box;
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::lineage_rng::Rng;

pub const ACCOUNTS: usize = 6;
pub const MAX_ASSETS: usize = 4;
const MARKET_ID: [u8; 32] = [1; 32];
const OWNER: [u8; 32] = [3; 32];

/// What a harness does with every engine answer and with the state after every operation.
pub trait Rec {
    /// `r` is Err(()) when the call panicked.
    fn call<T: Debug>(&mut self, tag: &'static str, r: &Result<V16Result<T>, ()>);
    fn op_end(&mut self, index: usize, committed: bool, w: &World);
}

#[derive(Clone, Copy, Debug)]
pub struct Shape {
    pub preset: u8,
    pub n_assets: usize,
    pub init_prices: [u64; MAX_ASSETS],
    /// typical deposit, in atoms
    pub scale: u128,
    /// the direction each asset's price trends in, so that one side of the book ends up under
    /// its maintenance margin
    pub drift: [i32; MAX_ASSETS],
}

pub struct World {
    pub header: MarketGroupV16HeaderAccount,
    pub markets: Vec<Market<u64>>,
    pub accounts: Vec<PortfolioAccountV16Account>,
    pub prices: [u64; MAX_ASSETS],
    pub n_assets: usize,
    snap_header: MarketGroupV16HeaderAccount,
    snap_markets: Vec<Market<u64>>,
    snap_accounts: Vec<PortfolioAccountV16Account>,
    snap_prices: [u64; MAX_ASSETS],
    /// the accounts the last save copied, one bit each
    snap_mask: u8,
}

#[derive(Clone, Debug)]
pub enum Op {
    /// One oracle step for every asset (`dt` slots later, each price moved by `moves[i]` bps: the
    /// authenticated target is staged, then the asset accrues to it), then a keeper's sweep: one
    /// auto-crank for every account whose bit is set in `sweep`, and a second one for those in
    /// `again` (the first crank of an account brings it current, the next one acts on what that
    /// showed: it is the second crank that liquidates).
    Tick { dt: u64, moves: [i32; MAX_ASSETS], funding: [i128; MAX_ASSETS], sweep: u8, again: u8 },
    Deposit { a: usize, amount: u128 },
    /// `share` in 1/1000 of the account's capital.
    Withdraw { a: usize, share: u64 },
    /// Notional is `share` in 1/1000 of the smaller capital; price is the oracle price moved by
    /// `skew` bps. With `reduce`, and when the first account holds a position in the asset, the
    /// trade goes against that position for `share` in 1/1000 of its basis quantity instead.
    Trade { a: usize, b: usize, asset: usize, share: u64, long: bool, reduce: bool, skew: i32, fee_bps: u64 },
    Batch { a: usize, b: usize, fills: Vec<(usize, u64, bool)>, fee_bps: u64 },
    Refresh { a: usize },
    Liquidate { a: usize, asset: usize },
    Crank { a: usize, with_observations: bool },
    /// `share` in 1/1000 of the leg's basis quantity.
    Rebalance { a: usize, asset: usize, share: u64 },
    Convert { a: usize },
    SyncFee { a: usize, rate: u128 },
    Insurance { domain: usize, amount: u128 },
    Summary { a: usize },
    Validate { a: usize },
    Resolve,
    AdvanceResolved { dt: u64 },
    Close { a: usize, rate: u128 },
    Topup { a: usize },
}

pub fn shape(r: &mut Rng, index: usize) -> Shape {
    let preset = (index % 4) as u8;
    let n_assets = [1usize, 1, 2, 4][r.below(4) as usize];
    // Three money sizes: small integers (the shapes upstream's tests use), ordinary token amounts,
    // and amounts near the engine's limits, where products leave 128 bits and the wide helpers run.
    let (scale, price_hi) = match r.below(3) {
        0 => (10_000u128, 1_000u64),
        1 => (5_000_000_000u128, 5_000_000u64),
        _ => (400_000_000_000_000u128, 800_000_000_000u64),
    };
    let mut init_prices = [0u64; MAX_ASSETS];
    for p in init_prices.iter_mut() {
        *p = 1 + r.below(price_hi);
    }
    let mut drift = [0i32; MAX_ASSETS];
    for d in drift.iter_mut() {
        *d = if r.below(2) == 0 { 1 } else { -1 };
    }
    Shape { preset, n_assets, init_prices, scale, drift }
}

fn config(shape: &Shape) -> V16Config {
    let n = shape.n_assets as u16;
    let mut cfg = V16Config::public_user_fund_with_market_slots(n, n as u32, 0, 10);
    match shape.preset {
        // upstream's default profile: full margin, any price move
        0 => {}
        // leverage: 25% maintenance, 30% initial, at most 5% a slot (v16_spec_tests uses 10%, 50%
        // and the same step; the narrower gap here puts accounts under maintenance within a few steps)
        1 => {
            cfg.maintenance_margin_bps = 2_500;
            cfg.initial_margin_bps = 3_000;
            cfg.max_price_move_bps_per_slot = 500;
            cfg.max_accrual_dt_slots = 1;
        }
        // funding (v16_spec_tests funding_market_fixture)
        2 => {
            cfg.max_abs_funding_e9_per_slot = 10_000;
            cfg.max_price_move_bps_per_slot = 9_000;
        }
        // fees (v16_spec_tests nontrivial exact solvency profile, plus a trading fee)
        _ => {
            cfg.max_price_move_bps_per_slot = 100;
            cfg.liquidation_fee_bps = 100;
            cfg.min_liquidation_abs = 1;
            cfg.liquidation_fee_cap = 1;
            cfg.min_nonzero_mm_req = 2;
            cfg.min_nonzero_im_req = 3;
            cfg.max_trading_fee_bps = 10;
        }
    }
    cfg
}

fn account(seed: u8) -> PortfolioAccountV16Account {
    let header = ProvenanceHeaderV16Account::from_runtime(&ProvenanceHeaderV16::new(MARKET_ID, [seed; 32], OWNER));
    let mut account = PortfolioAccountV16Account::default();
    account.init_empty_in_place(header).expect("empty account");
    account
}

/// Builds the market group and the accounts. `rec` sees the two kinds of setup call.
pub fn world<R: Rec>(shape: &Shape, rec: &mut R) -> World {
    let mut cfg = config(shape);
    let mut made = catch_unwind(|| MarketGroupV16HeaderAccount::new_dynamic(MARKET_ID, cfg, shape.n_assets as u32, 0)).map_err(|_| ());
    rec.call("new_dynamic", &made);
    if !matches!(made, Ok(Ok(_))) {
        // a preset the engine refuses is part of the output; the world then runs on the default profile
        cfg = V16Config::public_user_fund_with_market_slots(shape.n_assets as u16, shape.n_assets as u32, 0, 10);
        made = Ok(MarketGroupV16HeaderAccount::new_dynamic(MARKET_ID, cfg, shape.n_assets as u32, 0));
    }
    let mut header = made.expect("default profile").expect("default profile");
    let mut markets: Vec<Market<u64>> = (0..shape.n_assets).map(|i| Market::new(i as u64, EngineAssetSlotV16Account::default())).collect();
    for i in 0..shape.n_assets {
        let r = catch_unwind(AssertUnwindSafe(|| header.activate_empty_asset_slot_not_atomic(i as u32, &mut markets[i].engine, shape.init_prices[i], (i + 1) as u64))).map_err(|_| ());
        rec.call("activate", &r);
    }
    let accounts: Vec<PortfolioAccountV16Account> = (0..ACCOUNTS).map(|i| account(10 + i as u8)).collect();
    World {
        snap_header: header,
        snap_markets: markets.clone(),
        snap_accounts: accounts.clone(),
        snap_prices: shape.init_prices,
        snap_mask: 0,
        header,
        markets,
        accounts,
        prices: shape.init_prices,
        n_assets: shape.n_assets,
    }
}

/// A world of the same sizes with zeroed account images and no engine call (for --inputs-only).
#[allow(dead_code)]
pub fn blank(shape: &Shape) -> World {
    let header = MarketGroupV16HeaderAccount::default();
    let markets: Vec<Market<u64>> = (0..shape.n_assets).map(|i| Market::new(i as u64, EngineAssetSlotV16Account::default())).collect();
    let accounts: Vec<PortfolioAccountV16Account> = (0..ACCOUNTS).map(|_| PortfolioAccountV16Account::default()).collect();
    World {
        snap_header: header,
        snap_markets: markets.clone(),
        snap_accounts: accounts.clone(),
        snap_prices: shape.init_prices,
        snap_mask: 0,
        header,
        markets,
        accounts,
        prices: shape.init_prices,
        n_assets: shape.n_assets,
    }
}

fn pair(r: &mut Rng) -> (usize, usize) {
    let a = r.below(ACCOUNTS as u64) as usize;
    let b = (a + 1 + r.below(ACCOUNTS as u64 - 1) as usize) % ACCOUNTS;
    (a, b)
}

/// The operations of one world: funding of every account, `n` live operations, then resolution
/// and the closing of every account.
pub fn ops(r: &mut Rng, shape: &Shape, n: usize) -> Vec<Op> {
    let cfg = config(shape);
    let na = shape.n_assets as u64;
    let move_cap = cfg.max_price_move_bps_per_slot.min(2_000) as i64;
    let mut out = Vec::with_capacity(n + 64);
    for a in 0..ACCOUNTS {
        out.push(Op::Deposit { a, amount: shape.scale / 2 + (r.next() as u128) % shape.scale });
    }
    if shape.preset == 3 {
        for domain in 0..(2 * shape.n_assets) {
            out.push(Op::Insurance { domain, amount: 1 + (r.next() as u128) % (shape.scale / 4 + 1) });
        }
    }
    for _ in 0..n {
        let a = r.below(ACCOUNTS as u64) as usize;
        let asset = r.below(na) as usize;
        let op = match r.below(100) {
            0..=17 => {
                let mut moves = [0i32; MAX_ASSETS];
                let mut funding = [0i128; MAX_ASSETS];
                for i in 0..MAX_ASSETS {
                    // mostly small moves, sometimes the full allowed step, sometimes past it
                    let span = match r.below(40) {
                        0 => move_cap + move_cap / 4 + 2,
                        1..=10 => move_cap,
                        _ => move_cap / 8 + 1,
                    };
                    moves[i] = (r.below(2 * span as u64 + 1) as i64 - span) as i32;
                    if r.below(5) < if shape.preset == 1 { 3 } else { 2 } {
                        moves[i] = moves[i].abs() * shape.drift[i];
                    }
                    if cfg.max_abs_funding_e9_per_slot > 0 {
                        let f = cfg.max_abs_funding_e9_per_slot as i64 + 1;
                        funding[i] = (r.below(2 * f as u64 + 1) as i64 - f) as i128;
                    }
                }
                let over = if r.below(40) == 0 { 1 } else { 0 };
                let dt = if r.below(40) == 0 { 0 } else { 1 + r.below(cfg.max_accrual_dt_slots + over) };
                let sweep = if r.below(5) == 0 { r.below(64) as u8 } else { 63 };
                let again = if r.below(4) == 0 { r.below(64) as u8 } else { 63 };
                Op::Tick { dt, moves, funding, sweep, again }
            }
            18..=23 => Op::Deposit { a, amount: (r.next() as u128) % (shape.scale / 2 + 1) },
            24..=30 => {
                let top = if r.below(8) == 0 { 1_200 } else { 250 };
                Op::Withdraw { a, share: 1 + r.below(top) }
            }
            31..=58 => {
                let (a, b) = pair(r);
                // mostly small against the capital, often about all of it, sometimes more than margin allows
                let top = match r.below(10) {
                    0 => 2_500,
                    1..=3 => 1_000,
                    _ => 150,
                } * if shape.preset == 1 { 3 } else { 1 };
                let share = 1 + r.below(top);
                let fee_bps = if cfg.max_trading_fee_bps == 0 { r.below(40) / 39 } else { r.below(cfg.max_trading_fee_bps + 2) };
                Op::Trade { a, b, asset, share, long: r.below(2) == 0, reduce: r.below(5) < 2, skew: r.below(41) as i32 - 20, fee_bps }
            }
            59..=62 => {
                let (a, b) = pair(r);
                let fills = (0..2 + r.below(3)).map(|_| (r.below(na) as usize, 1 + r.below(150), r.below(2) == 0)).collect();
                Op::Batch { a, b, fills, fee_bps: r.below(cfg.max_trading_fee_bps + 1) }
            }
            63..=70 => Op::Refresh { a },
            71..=77 => Op::Liquidate { a, asset },
            78..=88 => Op::Crank { a, with_observations: r.below(4) != 0 },
            89 => Op::Rebalance { a, asset, share: 1 + r.below(1_100) },
            90..=93 => Op::Convert { a },
            94..=95 => Op::SyncFee { a, rate: (r.next() as u128) % (shape.scale / 10_000 + 2) },
            96 => Op::Insurance { domain: r.below(2 * na + 1) as usize, amount: (r.next() as u128) % (shape.scale / 8 + 1) },
            97..=98 => Op::Summary { a },
            _ => Op::Validate { a },
        };
        out.push(op);
    }
    out.push(Op::Resolve);
    for round in 0..6u64 {
        out.push(Op::AdvanceResolved { dt: 1 + r.below(12) });
        for a in 0..ACCOUNTS {
            out.push(Op::Close { a, rate: if round % 2 == 0 { 0 } else { (r.next() as u128) % 3 } });
            if round >= 2 {
                out.push(Op::Topup { a });
            }
        }
    }
    out
}

fn step_price(price: u64, move_bps: i32) -> u64 {
    let moved = (price as i128) * (10_000 + move_bps as i128) / 10_000;
    let moved = if moved == price as i128 && move_bps != 0 { moved + move_bps.signum() as i128 } else { moved };
    moved.clamp(1, MAX_ORACLE_PRICE as i128 + 1) as u64
}

fn run<T: Debug, R: Rec>(rec: &mut R, tag: &'static str, f: impl FnOnce() -> V16Result<T>) -> bool {
    let r = catch_unwind(AssertUnwindSafe(f)).map_err(|_| ());
    rec.call(tag, &r);
    matches!(r, Ok(Ok(_)))
}

fn two(accounts: &mut [PortfolioAccountV16Account], a: usize, b: usize) -> (&mut PortfolioAccountV16Account, &mut PortfolioAccountV16Account) {
    if a < b {
        let (lo, hi) = accounts.split_at_mut(b);
        (&mut lo[a], &mut hi[0])
    } else {
        let (lo, hi) = accounts.split_at_mut(a);
        (&mut hi[0], &mut lo[b])
    }
}

/// Copies an account image 64 bytes at a time. Not `*dst = *src`: for images of this size that is
/// a call into the C library's memcpy, which picks its code by the CPU it runs on (rep movsb on one
/// machine, a vector loop on another), and the harness's own rollback copies have to count the
/// same on every verifier. black_box keeps the compiler from turning the loop back into that call.
fn copy_image<T: bytemuck::Pod>(dst: &mut T, src: &T) {
    let d = bytemuck::bytes_of_mut(dst);
    let s = bytemuck::bytes_of(src);
    let mut i = 0usize;
    while i + 64 <= s.len() {
        let block: [u8; 64] = black_box(s[i..i + 64].try_into().unwrap());
        d[i..i + 64].copy_from_slice(&block);
        i += 64;
    }
    while i < s.len() {
        d[i] = black_box(s[i]);
        i += 1;
    }
}

impl Op {
    /// The accounts the operation hands to the engine, one bit each. An engine call can only
    /// write the group header, the asset slots and the accounts it is given.
    fn accounts(&self) -> u8 {
        match self {
            Op::Deposit { a, .. } | Op::Withdraw { a, .. } | Op::Refresh { a } | Op::Liquidate { a, .. } | Op::Crank { a, .. } | Op::Rebalance { a, .. } => 1 << a,
            Op::Convert { a } | Op::SyncFee { a, .. } | Op::Close { a, .. } | Op::Topup { a } => 1 << a,
            Op::Trade { a, b, .. } | Op::Batch { a, b, .. } => 1 << a | 1 << b,
            // a tick saves before each of its transactions; the rest only read accounts
            Op::Tick { .. } | Op::Insurance { .. } | Op::Summary { .. } | Op::Validate { .. } | Op::Resolve | Op::AdvanceResolved { .. } => 0,
        }
    }
}

impl World {
    /// Copies what a transaction can write: the header, the asset slots and the accounts in `mask`.
    fn save(&mut self, mask: u8) {
        copy_image(&mut self.snap_header, &self.header);
        for i in 0..self.markets.len() {
            copy_image(&mut self.snap_markets[i].engine, &self.markets[i].engine);
        }
        for a in 0..ACCOUNTS {
            if mask >> a & 1 == 1 {
                copy_image(&mut self.snap_accounts[a], &self.accounts[a]);
            }
        }
        self.snap_prices = self.prices;
        self.snap_mask = mask;
    }

    fn restore(&mut self) {
        copy_image(&mut self.header, &self.snap_header);
        for i in 0..self.markets.len() {
            copy_image(&mut self.markets[i].engine, &self.snap_markets[i].engine);
        }
        for a in 0..ACCOUNTS {
            if self.snap_mask >> a & 1 == 1 {
                copy_image(&mut self.accounts[a], &self.snap_accounts[a]);
            }
        }
        self.prices = self.snap_prices;
    }

    /// The quantity whose notional at `price` is `share`/1000 of `capital`.
    fn size_for(capital: u128, share: u64, price: u64) -> i128 {
        let notional = capital / 1_000 * share as u128 + capital % 1_000 * share as u128 / 1_000;
        let q = notional.saturating_mul(POS_SCALE) / price.max(1) as u128;
        q.clamp(1, i128::MAX as u128 / 4) as i128
    }

    /// Runs one operation as one transaction. With `dry` the same copies are saved and nothing is
    /// called: that is the harness's own cost.
    pub fn exec<R: Rec>(&mut self, index: usize, op: &Op, dry: bool, rec: &mut R) {
        self.save(op.accounts());
        if dry {
            if let Op::Tick { sweep, again, .. } = op {
                // the saves a tick makes before each of its transactions
                for _ in 0..self.n_assets {
                    self.save(0);
                }
                for pass in [*sweep, *sweep & *again] {
                    for a in 0..ACCOUNTS {
                        if pass >> a & 1 == 1 {
                            self.save(1 << a);
                        }
                    }
                }
                self.save(0);
            }
            rec.op_end(index, false, self);
            return;
        }
        let ok = self.apply(op, rec);
        if !ok {
            self.restore();
        }
        rec.op_end(index, ok, self);
    }

    fn apply<R: Rec>(&mut self, op: &Op, rec: &mut R) -> bool {
        let n = self.n_assets;
        match op {
            Op::Tick { dt, moves, funding, sweep, again } => {
                let now = self.header.current_slot.get().saturating_add(*dt);
                // every asset's step and every account's crank is a transaction of its own: one
                // refused step does not undo the others
                let mut any = false;
                for i in 0..n {
                    let price = step_price(self.prices[i], moves[i]);
                    self.save(0);
                    let ok = run(rec, "oracle_target", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).set_asset_raw_oracle_target_not_atomic(i, price))
                        && run(rec, "accrue", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).accrue_asset_to_not_atomic(i, now, price, funding[i], true));
                    if ok {
                        self.prices[i] = price;
                        any = true;
                    } else {
                        self.restore();
                    }
                }
                for pass in [*sweep, *sweep & *again] {
                    for a in 0..ACCOUNTS {
                        if pass >> a & 1 == 1 {
                            self.save(1 << a);
                            if self.crank(a, true, rec) {
                                any = true;
                            } else {
                                self.restore();
                            }
                        }
                    }
                }
                // a keeper finishes the side resets that quantity ADL left pending (until then the
                // side refuses new positions); it reads the side's mode byte from the asset's
                // account image (0 is Normal) and only sends the transaction when one is not
                for i in 0..n {
                    for side in [SideV16::Long, SideV16::Short] {
                        let asset = &self.markets[i].engine.asset;
                        let mode = if side == SideV16::Long { asset.mode_long } else { asset.mode_short };
                        if mode == 0 {
                            continue;
                        }
                        self.save(0);
                        if !run(rec, "finalize_reset", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).finalize_side_reset_not_atomic(i, side)) {
                            self.restore();
                        }
                    }
                }
                self.save(0);
                any
            }
            Op::Deposit { a, amount } => run(rec, "deposit", || {
                let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).deposit_not_atomic(&mut account, *amount)
            }),
            Op::Withdraw { a, share } => {
                let capital = self.accounts[*a].capital.get();
                let amount = capital / 1_000 * *share as u128 + capital % 1_000 * *share as u128 / 1_000;
                self.refresh(*a, rec)
                    && run(rec, "withdraw", || {
                        let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                        MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).withdraw_not_atomic(&mut account, amount)
                    })
            }
            Op::Trade { a, b, asset, share, long, reduce, skew, fee_bps } => {
                let capital = self.accounts[*a].capital.get().min(self.accounts[*b].capital.get());
                let exec_price = step_price(self.prices[*asset], *skew).min(MAX_ORACLE_PRICE);
                let held = self.basis(*a, *asset);
                let size_q = if *reduce && held != 0 {
                    let part = (held.unsigned_abs() / 1_000 * (*share).min(1_000) as u128 + held.unsigned_abs() % 1_000 * (*share).min(1_000) as u128 / 1_000).max(1) as i128;
                    if held > 0 { -part } else { part }
                } else {
                    let q = Self::size_for(capital, *share, exec_price);
                    if *long { q } else { -q }
                };
                let request = TradeRequestV16 { asset_index: *asset, size_q, exec_price, fee_bps: *fee_bps };
                self.refresh(*a, rec)
                    && self.refresh(*b, rec)
                    && run(rec, "trade", || {
                        let (x, y) = two(&mut self.accounts, *a, *b);
                        let mut first = PortfolioV16ViewMut::new(x);
                        let mut second = PortfolioV16ViewMut::new(y);
                        MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).execute_trade_with_fee_loss_stale_scoped_not_atomic(&mut first, &mut second, request)
                    })
            }
            Op::Batch { a, b, fills, fee_bps } => {
                let capital = self.accounts[*a].capital.get().min(self.accounts[*b].capital.get());
                let requests: Vec<TradeRequestV16> = fills
                    .iter()
                    .map(|(asset, share, long)| {
                        let exec_price = self.prices[*asset].min(MAX_ORACLE_PRICE);
                        let q = Self::size_for(capital, *share, exec_price);
                        TradeRequestV16 { asset_index: *asset, size_q: if *long { q } else { -q }, exec_price, fee_bps: *fee_bps }
                    })
                    .collect();
                self.refresh(*a, rec)
                    && self.refresh(*b, rec)
                    && run(rec, "batch", || {
                        let (x, y) = two(&mut self.accounts, *a, *b);
                        let mut first = PortfolioV16ViewMut::new(x);
                        let mut second = PortfolioV16ViewMut::new(y);
                        MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).execute_batch_with_fee_loss_stale_scoped_not_atomic(&mut first, &mut second, &requests)
                    })
            }
            Op::Refresh { a } => self.refresh(*a, rec),
            Op::Liquidate { a, asset } => run(rec, "liquidate", || {
                let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).liquidate_account_not_atomic(&mut account, LiquidationRequestV16 { asset_index: *asset })
            }),
            Op::Crank { a, with_observations } => self.crank(*a, *with_observations, rec),
            Op::Rebalance { a, asset, share } => {
                let held = self.basis(*a, *asset).unsigned_abs();
                let basis = if held == 0 { POS_SCALE } else { held };
                let reduce_q = (basis / 1_000 * *share as u128 + basis % 1_000 * *share as u128 / 1_000).max(1);
                self.refresh(*a, rec)
                    && run(rec, "rebalance", || {
                        let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                        MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).rebalance_reduce_position_not_atomic(&mut account, RebalanceRequestV16 { asset_index: *asset, reduce_q })
                    })
            }
            Op::Convert { a } => {
                self.refresh(*a, rec)
                    && run(rec, "convert", || {
                        let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                        MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).convert_released_pnl_to_capital_not_atomic(&mut account)
                    })
            }
            Op::SyncFee { a, rate } => {
                let now_slot = self.header.current_slot.get();
                run(rec, "sync_fee", || {
                    let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                    MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).sync_account_fee_to_slot_not_atomic(&mut account, now_slot, *rate)
                })
            }
            Op::Insurance { domain, amount } => run(rec, "insurance", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).deposit_domain_insurance_not_atomic(*domain, *amount)),
            Op::Summary { a } => {
                let now_slot = self.header.current_slot.get();
                run(rec, "summary", || {
                    let account = PortfolioV16View::new(&self.accounts[*a]);
                    MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).build_actionable_summary_at_slot(&account, now_slot)
                })
            }
            Op::Validate { a } => {
                run(rec, "validate_shape", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).validate_shape())
                    && run(rec, "validate_account", || {
                        let market = MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets);
                        PortfolioV16View::new(&self.accounts[*a]).validate_with_market(&market.as_view())
                    })
            }
            Op::Resolve => {
                let slot = self.header.current_slot.get();
                run(rec, "resolve", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).resolve_market_not_atomic(slot))
            }
            Op::AdvanceResolved { dt } => {
                let slot = self.header.current_slot.get().saturating_add(*dt);
                run(rec, "advance_resolved", || MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).advance_resolved_slot_not_atomic(slot))
            }
            Op::Close { a, rate } => run(rec, "close", || {
                let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).close_resolved_account_not_atomic(&mut account, *rate)
            }),
            Op::Topup { a } => run(rec, "topup", || {
                let mut account = PortfolioV16ViewMut::new(&mut self.accounts[*a]);
                MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).claim_resolved_payout_topup_not_atomic(&mut account)
            }),
        }
    }

    /// The signed basis quantity the account's leg in `asset` stores, 0 without one.
    fn basis(&self, a: usize, asset: usize) -> i128 {
        self.accounts[a].legs.iter().find(|leg| leg.active != 0 && leg.asset_index.get() as usize == asset).map(|leg| leg.basis_pos_q.get()).unwrap_or(0)
    }

    fn crank<R: Rec>(&mut self, a: usize, with_observations: bool, rec: &mut R) -> bool {
        let n = self.n_assets;
        let mut observations = [AutoCrankObservationV16 { asset_index: 0, effective_price: 1, funding_rate_e9: 0 }; MAX_ASSETS];
        for i in 0..n {
            observations[i] = AutoCrankObservationV16 { asset_index: i, effective_price: self.prices[i].min(MAX_ORACLE_PRICE), funding_rate_e9: 0 };
        }
        let count = if with_observations { n } else { 0 };
        let now_slot = self.header.current_slot.get();
        run(rec, "crank", || {
            let mut account = PortfolioV16ViewMut::new(&mut self.accounts[a]);
            let work = AutoCrankWorkV16 { now_slot, observations: &observations[..count], resolved_close_fee_rate_per_slot: 0 };
            MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).permissionless_auto_crank_not_atomic(&mut account, work)
        })
    }

    fn refresh<R: Rec>(&mut self, a: usize, rec: &mut R) -> bool {
        run(rec, "refresh", || {
            let mut account = PortfolioV16ViewMut::new(&mut self.accounts[a]);
            MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets).full_account_refresh_not_atomic(&mut account)
        })
    }

    /// Every byte of the engine's state: the group header, each asset slot, each account.
    pub fn state_bytes(&self, mut f: impl FnMut(&[u8])) {
        f(bytemuck::bytes_of(&self.header));
        for m in &self.markets {
            f(bytemuck::bytes_of(&m.engine));
        }
        for a in &self.accounts {
            f(bytemuck::bytes_of(a));
        }
    }
}
