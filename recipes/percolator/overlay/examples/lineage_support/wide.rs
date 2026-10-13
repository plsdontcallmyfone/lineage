// Lineage harness helper (recipe overlay, protected): a seeded stream of calls into the engine's
// arithmetic helpers, shared by lineage_bench and lineage_equiv.
//
// src/wide_math.rs is a private module, so nothing outside the crate can call U256 or the
// 512-bit multiply-divide directly. What can be called is what the engine itself calls them
// through: the checked helpers of src/v16.rs, which upstream exposes under its `fuzz` feature
// (the kani_* shims its own reference_model_conformance tests use) plus two public functions.
// Each of them takes the native 128-bit path when the product fits and the wide path when it
// does not; the operand classes below decide which.
use percolator::v16::{
    kani_adjust_u128, kani_adl_effective_quantity_ceil, kani_amount_from_bound_num, kani_bound_num_from_amount, kani_checked_fee_bps,
    kani_liquidation_fee_for_close, kani_loss_weight_for_basis, kani_mul_div_ceil_u128_or_wide, kani_mul_div_ceil_u128_wide_reference,
    kani_mul_div_floor_u128_or_wide, kani_mul_div_floor_u128_wide_reference, kani_raw_basis_for_adl_effective_quantity, kani_risk_notional_ceil,
    kani_scaled_adl_delta_fast, kani_trade_fee_atoms_per_side, kani_trade_notional_floor,
};
use percolator::{backing_domain_fee_split_for_lien_delta_num, canonical_accrual_price_step_v16, V16Result, ADL_ONE, BOUND_SCALE, MAX_ORACLE_PRICE, MAX_POSITION_ABS_Q, MIN_A_SIDE, POS_SCALE};
use std::panic::catch_unwind;

use crate::lineage_rng::Rng;

#[derive(Clone, Copy, Debug)]
pub enum WideOp {
    MulDivFloor(u128, u128, u128),
    MulDivCeil(u128, u128, u128),
    RiskNotionalCeil(u128, u64),
    TradeNotionalFloor(u128, u64),
    FeeBps(u128, u64),
    LossWeight(u128, u128),
    AdlEffective(u128, u128, u128),
    FeeSplit(u128, u16, u16),
    AdlDeltaFast(u128, u128, i128, i128),
    // the calls below are only in the equivalence stream
    FloorReference(u128, u128, u128),
    CeilReference(u128, u128, u128),
    AdlRawBasis(u128, u128, u128),
    BoundNum(u128),
    AmountFromBound(u128),
    TradeFee(u128, u64, u64),
    LiquidationFee(u128, u64, u128, u128, bool),
    PriceStep(u64, u64, u64, u64, bool, u16),
    Adjust(u128, u128, u128),
}

/// A 128-bit value of a random bit length, so that every magnitude is as likely as any other.
fn wide(r: &mut Rng) -> u128 {
    let v = (r.next() as u128) << 64 | r.next() as u128;
    v >> r.below(128)
}

/// At least 2^100: two of these always overflow 128 bits when multiplied.
fn big(r: &mut Rng) -> u128 {
    ((r.next() as u128) << 64 | r.next() as u128) >> r.below(28)
}

fn edge(r: &mut Rng) -> u128 {
    match r.below(8) {
        0 => 0,
        1 => 1,
        2 => u128::MAX,
        3 => u128::MAX - 1,
        4 => 1 << 64,
        5 => (1 << 64) - 1,
        6 => i128::MAX as u128,
        _ => 1u128 << r.below(128),
    }
}

/// (a, b, d) for a multiply-divide: mostly products past 128 bits with a quotient that still fits,
/// then every other case (native products, quotients that overflow, zero and edge operands).
fn triple(r: &mut Rng) -> (u128, u128, u128) {
    match r.below(20) {
        0..=12 => {
            let a = big(r);
            let b = big(r);
            // d at least the larger factor keeps the quotient within 128 bits
            let d = a.max(b) | (wide(r) & (wide(r) | 1));
            (a, b, d)
        }
        13..=14 => (wide(r) >> 64, wide(r) >> 64, 1 + (wide(r) >> 64)),
        15..=16 => (big(r), big(r), 1 + wide(r)),
        17 => (wide(r), wide(r), wide(r)),
        18 => (edge(r), edge(r), edge(r)),
        _ => (big(r), wide(r), POS_SCALE << r.below(40)),
    }
}

fn price(r: &mut Rng) -> u64 {
    match r.below(12) {
        0 => 0,
        1 => MAX_ORACLE_PRICE,
        2 => MAX_ORACLE_PRICE + 1,
        _ => 1 + r.below(MAX_ORACLE_PRICE) >> r.below(40),
    }
}

fn a_basis(r: &mut Rng) -> u128 {
    match r.below(10) {
        0 => ADL_ONE,
        1 => MIN_A_SIDE,
        2 => MIN_A_SIDE - 1,
        3 => ADL_ONE + 1,
        _ => MIN_A_SIDE + (r.next() as u128) % (ADL_ONE - MIN_A_SIDE + 1),
    }
}

fn quantity(r: &mut Rng) -> u128 {
    match r.below(12) {
        0 => 0,
        1 => MAX_POSITION_ABS_Q,
        2 => MAX_POSITION_ABS_Q + 1,
        _ => (r.next() as u128) % (MAX_POSITION_ABS_Q + 1) >> r.below(30),
    }
}

fn signed(r: &mut Rng) -> i128 {
    let v = wide(r) as i128;
    if r.below(2) == 0 { v } else { v.wrapping_neg() }
}

/// One call of the stream the metric measures: the helpers the engine reaches the wide math through.
pub fn bench_op(r: &mut Rng) -> WideOp {
    match r.below(20) {
        0..=4 => {
            let (a, b, d) = triple(r);
            WideOp::MulDivFloor(a, b, d)
        }
        5..=9 => {
            let (a, b, d) = triple(r);
            WideOp::MulDivCeil(a, b, d)
        }
        10..=11 => WideOp::RiskNotionalCeil(if r.below(3) == 0 { quantity(r) } else { big(r) >> 18 }, price(r)),
        12 => WideOp::TradeNotionalFloor(if r.below(3) == 0 { quantity(r) } else { big(r) >> 18 }, price(r)),
        13 => WideOp::FeeBps(if r.below(2) == 0 { wide(r) } else { big(r) }, r.below(10_002)),
        14..=16 => WideOp::LossWeight(quantity(r), a_basis(r)),
        17 => {
            let basis = a_basis(r);
            WideOp::AdlEffective(quantity(r), basis, if r.below(8) == 0 { basis + 1 } else { (r.next() as u128) % (basis + 1) })
        }
        18 => WideOp::FeeSplit(if r.below(6) == 0 { wide(r) } else { (wide(r) >> 41) * BOUND_SCALE }, r.below(10_002) as u16, r.below(10_002) as u16),
        _ => {
            let then = signed(r) >> 8;
            let step = (r.below(2_000_001) as i128 - 1_000_000) * if r.below(4) == 0 { 1 } else { ADL_ONE as i128 };
            WideOp::AdlDeltaFast(quantity(r), if r.below(4) == 0 { a_basis(r) } else { ADL_ONE }, then, then.wrapping_add(step))
        }
    }
}

/// One call of the equivalence stream: everything bench_op draws, and the rest of the helpers.
#[allow(dead_code)]
pub fn equiv_op(r: &mut Rng) -> WideOp {
    match r.below(30) {
        0..=17 => bench_op(r),
        18 => {
            let (a, b, d) = triple(r);
            WideOp::FloorReference(a, b, d)
        }
        19 => {
            let (a, b, d) = triple(r);
            WideOp::CeilReference(a, b, d)
        }
        20..=21 => {
            let basis = a_basis(r);
            WideOp::AdlRawBasis(quantity(r), basis, if r.below(8) == 0 { 0 } else { (r.next() as u128) % (basis + 1) })
        }
        22 => WideOp::BoundNum(if r.below(2) == 0 { wide(r) } else { edge(r) }),
        23 => WideOp::AmountFromBound(if r.below(2) == 0 { wide(r) } else { edge(r) }),
        24..=25 => WideOp::TradeFee(quantity(r), price(r), r.below(10_002)),
        26 => WideOp::LiquidationFee(wide(r) >> r.below(64), r.below(10_002), wide(r) >> 100, wide(r) >> 90, r.below(2) == 0),
        27..=28 => {
            let current = price(r);
            let target = if r.below(3) == 0 { current } else { price(r) };
            WideOp::PriceStep(current, target, if r.below(3) == 0 { current } else { price(r) }, r.below(10_002), r.below(5) != 0, r.below(10_050) as u16)
        }
        _ => WideOp::Adjust(wide(r), wide(r), wide(r)),
    }
}

fn one(r: V16Result<u128>) -> V16Result<[u128; 4]> {
    r.map(|v| [v, 0, 0, 0])
}

/// Runs the call. Err(()) is a panic; the numbers are the whole result.
pub fn apply(op: WideOp) -> Result<V16Result<[u128; 4]>, ()> {
    catch_unwind(|| match op {
        WideOp::MulDivFloor(a, b, d) => one(kani_mul_div_floor_u128_or_wide(a, b, d)),
        WideOp::MulDivCeil(a, b, d) => one(kani_mul_div_ceil_u128_or_wide(a, b, d)),
        WideOp::RiskNotionalCeil(q, p) => one(kani_risk_notional_ceil(q, p)),
        WideOp::TradeNotionalFloor(q, p) => one(kani_trade_notional_floor(q, p)),
        WideOp::FeeBps(n, bps) => one(kani_checked_fee_bps(n, bps)),
        WideOp::LossWeight(q, basis) => one(kani_loss_weight_for_basis(q, basis)),
        WideOp::AdlEffective(q, basis, current) => one(kani_adl_effective_quantity_ceil(q, basis, current)),
        WideOp::FeeSplit(num, fee, share) => backing_domain_fee_split_for_lien_delta_num(num, fee, share).map(|s| [s.lien_delta_atoms, s.total_fee, s.provider_fee, s.insurance_fee]),
        WideOp::AdlDeltaFast(q, basis, then, now) => Ok(match kani_scaled_adl_delta_fast(q, basis, then, now) {
            Some(v) => [1, v as u128, 0, 0],
            None => [0, 0, 0, 0],
        }),
        WideOp::FloorReference(a, b, d) => one(kani_mul_div_floor_u128_wide_reference(a, b, d)),
        WideOp::CeilReference(a, b, d) => one(kani_mul_div_ceil_u128_wide_reference(a, b, d)),
        WideOp::AdlRawBasis(q, basis, current) => one(kani_raw_basis_for_adl_effective_quantity(q, basis, current)),
        WideOp::BoundNum(v) => one(kani_bound_num_from_amount(v)),
        WideOp::AmountFromBound(v) => one(kani_amount_from_bound_num(v)),
        WideOp::TradeFee(q, p, bps) => one(kani_trade_fee_atoms_per_side(q, p, bps)),
        WideOp::LiquidationFee(n, bps, min, cap, full) => one(kani_liquidation_fee_for_close(n, bps, min, cap, full)),
        WideOp::PriceStep(current, target, anchor, bps, exposed, rem) => canonical_accrual_price_step_v16(current, target, anchor, bps, exposed, rem).map(|(p, rem)| [p as u128, rem as u128, 0, 0]),
        WideOp::Adjust(current, old, new) => one(kani_adjust_u128(current, old, new)),
    })
    .map_err(|_| ())
}
