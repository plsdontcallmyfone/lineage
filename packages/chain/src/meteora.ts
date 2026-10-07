import { sha256, toAddress, Writer, type Address } from "./codec.ts";
import { pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import { launchPdas, METEORA } from "./launch.ts";
import { r, w, type Ix } from "./registry.ts";

// Meteora DBC calls the devnet scripts make directly: create_config (the DBC config a launch uses)
// and swap2 (a trade on an agent's curve), plus the VirtualPool fields the scripts read. The
// encoding is the LiteSVM suite's `encode_params` (onchain/tests/src/lib.rs), checked there against
// the real DBC build.

const disc = (name: string) => sha256(`global:${name}`).subarray(0, 8);
export const dbcEventAuthority = () => pda(METEORA.dbcProgram, "__event_authority");

export interface DbcParams {
  cliffFeeNumerator: bigint;
  collectFeeMode: number;
  migrationOption: number;
  tokenType: number;
  /** Agent (base) token decimals. */
  tokenDecimals: number;
  partnerLocked: number;
  creatorLocked: number;
  threshold: bigint;
  sqrtStart: bigint;
  creatorTradingFee: number;
  migratedFeeBps: number;
  supply: bigint;
  curve: [bigint, bigint];
}

/**
 * The suite's standard curve (`standard_dbc_params`): flat 3% fee in the quote token, Token-2022
 * agent mints with 6 decimals and a fixed 100M supply, migration to DAMM v2 with 100% of the LP
 * locked to the partner. TEST values (SPEC 20 question 2), not launch values.
 */
export function standardDbcParams(): DbcParams {
  const ONE = 1_000_000n;
  return {
    cliffFeeNumerator: 30_000_000n,
    collectFeeMode: 0,
    migrationOption: 1,
    tokenType: 1,
    tokenDecimals: 6,
    partnerLocked: 100,
    creatorLocked: 0,
    threshold: 15_999_999_999_792n,
    sqrtStart: 4_124_817_371_235_594_858n,
    creatorTradingFee: 0,
    migratedFeeBps: 300,
    supply: 100_000_000n * ONE,
    curve: [16_499_269_484_942_379_432n, 439_980_519_592_732_705_252_230_013_543_952n],
  };
}

export function encodeDbcParams(p: DbcParams): Uint8Array {
  const wr = new Writer();
  wr.u64(p.cliffFeeNumerator).u16(0).u64(0).u64(0).u8(0); // base fee: flat linear scheduler
  wr.u8(0); // dynamic fee: none
  wr.u8(p.collectFeeMode).u8(p.migrationOption).u8(1 /* timestamp */).u8(p.tokenType).u8(p.tokenDecimals);
  wr.u8(100 - p.partnerLocked - p.creatorLocked).u8(p.partnerLocked).u8(0).u8(p.creatorLocked);
  wr.u64(p.threshold).u128(p.sqrtStart);
  wr.bytes(new Uint8Array(40)); // locked vesting
  wr.u8(6); // migration fee option: customizable
  wr.u8(1).u64(p.supply).u64(p.supply); // token supply: Some(pre, post)
  wr.u8(p.creatorTradingFee);
  wr.u8(1); // token update authority: immutable
  wr.u8(0).u8(0); // migration fee
  wr.u8(0).u8(0).u16(p.migratedFeeBps); // migrated pool fee
  wr.u64(0); // pool creation fee
  wr.bytes(new Uint8Array(13)).bytes(new Uint8Array(13)); // partner and creator liquidity vesting
  wr.u8(0); // migrated pool base fee mode
  wr.bytes(new Uint8Array(16)); // market cap scheduler
  wr.u8(0); // enable first swap with min fee
  wr.u16(0); // compounding fee bps
  wr.u8(0).u8(0); // padding
  wr.u32(1).u128(p.curve[0]).u128(p.curve[1]);
  return wr.done();
}

export const dbc = {
  /** Signers: `config` (a fresh keypair) and `payer`. Fee claimer and leftover receiver are both `feeClaimer`. */
  createConfig(a: { config: Address; feeClaimer: Address; quoteMint: Address; payer: Address; params: DbcParams }): Ix {
    return {
      programId: METEORA.dbcProgram,
      keys: [w(a.config, true), r(a.feeClaimer), r(a.feeClaimer), r(a.quoteMint), w(a.payer, true), r(SYSTEM_PROGRAM), r(dbcEventAuthority()),
        r(METEORA.dbcProgram)],
      data: new Writer().bytes(disc("create_config")).bytes(encodeDbcParams(a.params)).done(),
    };
  },
  /** swap2 in ExactIn mode (0). Buy: `$LINE` in, agent tokens out. */
  swap(a: { config: Address; pool: Address; agentMint: Address; lineMint: Address; trader: Address; lineAccount: Address; agentAccount: Address;
    buy: boolean; amountIn: bigint; minOut: bigint; lineTokenProgram?: Address }): Ix {
    const [input, output] = a.buy ? [a.lineAccount, a.agentAccount] : [a.agentAccount, a.lineAccount];
    const baseVault = launchPdas.dbcVault(a.agentMint, a.pool);
    const quoteVault = launchPdas.dbcVault(a.lineMint, a.pool);
    return {
      programId: METEORA.dbcProgram,
      keys: [r(METEORA.dbcPoolAuthority), r(a.config), w(a.pool), w(input), w(output), w(baseVault), w(quoteVault), r(a.agentMint), r(a.lineMint),
        r(a.trader, true), r(TOKEN_2022_PROGRAM), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(METEORA.dbcProgram), r(dbcEventAuthority()),
        r(METEORA.dbcProgram)],
      data: new Writer().bytes(disc("swap2")).u64(a.amountIn).u64(a.minOut).u8(0).done(),
    };
  },
};

/** VirtualPool fields (offsets include the discriminator; the suite's `dbc_view` and the launch program's reader). */
export interface DbcPoolView {
  config: Address;
  creator: Address;
  quoteReserve: bigint;
  protocolQuoteFee: bigint;
  partnerQuoteFee: bigint;
  isMigrated: number;
  migrationProgress: number;
}
export function decodeDbcPool(d: Uint8Array): DbcPoolView {
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  const u = (o: number) => dv.getBigUint64(o, true);
  return {
    config: toAddress(d.subarray(72, 104)),
    creator: toAddress(d.subarray(104, 136)),
    quoteReserve: u(240),
    protocolQuoteFee: u(256),
    partnerQuoteFee: u(272),
    isMigrated: d[305]!,
    migrationProgress: d[308]!,
  };
}
