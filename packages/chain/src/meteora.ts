import { addressBytes, sha256, toAddress, Writer, type Address } from "./codec.ts";
import { pda, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.ts";
import { launchPdas, METEORA } from "./launch.ts";
import { r, w, type Ix } from "./registry.ts";

// Meteora DBC calls the devnet scripts make directly: create_config (the DBC config a launch uses),
// swap2 (a trade on an agent's curve) and migration_damm_v2, the DAMM v2 calls graduation needs
// (swap2, create_position, add_liquidity, permanent_lock_position), plus the fields the scripts read. The
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
  /**
   * swap2, ExactIn (mode 0) unless `mode` says otherwise. Buy: `$LINE` in, agent tokens out. DBC
   * refuses an ExactIn buy past the migration threshold; PartialFill (1) stops at it and leaves the
   * rest of the input with the buyer, so the buy that completes a curve uses PartialFill.
   */
  swap(a: { config: Address; pool: Address; agentMint: Address; lineMint: Address; trader: Address; lineAccount: Address; agentAccount: Address;
    buy: boolean; amountIn: bigint; minOut: bigint; lineTokenProgram?: Address; mode?: number }): Ix {
    const [input, output] = a.buy ? [a.lineAccount, a.agentAccount] : [a.agentAccount, a.lineAccount];
    const baseVault = launchPdas.dbcVault(a.agentMint, a.pool);
    const quoteVault = launchPdas.dbcVault(a.lineMint, a.pool);
    return {
      programId: METEORA.dbcProgram,
      keys: [r(METEORA.dbcPoolAuthority), r(a.config), w(a.pool), w(input), w(output), w(baseVault), w(quoteVault), r(a.agentMint), r(a.lineMint),
        r(a.trader, true), r(TOKEN_2022_PROGRAM), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(METEORA.dbcProgram), r(dbcEventAuthority()),
        r(METEORA.dbcProgram)],
      data: new Writer().bytes(disc("swap2")).u64(a.amountIn).u64(a.minOut).u8(a.mode ?? 0).done(),
    };
  },
  /**
   * Meteora's permissionless `migration_damm_v2` (DBC release_0.2.2 `MigrateDammV2Ctx`): once the
   * curve is complete, DBC creates the DAMM v2 pool on `dammConfig` and its positions. Signers:
   * `payer` and both fresh NFT mint keypairs. `migration_metadata` is optional and passed as the DBC
   * program id (None); the DAMM v2 config rides as the one remaining account.
   */
  migrationDammV2(a: { dbcPool: Address; dbcConfig: Address; agentMint: Address; lineMint: Address; firstNftMint: Address; secondNftMint: Address;
    payer: Address; lineTokenProgram?: Address; dammConfig?: Address }): Ix {
    const dammConfig = a.dammConfig ?? METEORA.dammDynamicConfig;
    const pool = launchPdas.dammPool(a.agentMint, a.lineMint, dammConfig);
    const p1 = dammPdas.position(a.firstNftMint), n1 = dammPdas.positionNftAccount(a.firstNftMint);
    const p2 = dammPdas.position(a.secondNftMint), n2 = dammPdas.positionNftAccount(a.secondNftMint);
    return {
      programId: METEORA.dbcProgram,
      keys: [
        w(a.dbcPool), r(METEORA.dbcProgram), r(a.dbcConfig), w(METEORA.dbcPoolAuthority), w(pool),
        w(a.firstNftMint, true), w(n1), w(p1), w(a.secondNftMint, true), w(n2), w(p2),
        r(METEORA.dammPoolAuthority), r(METEORA.dammV2Program), w(a.agentMint), w(a.lineMint),
        w(launchPdas.dammVault(a.agentMint, pool)), w(launchPdas.dammVault(a.lineMint, pool)),
        w(launchPdas.dbcVault(a.agentMint, a.dbcPool)), w(launchPdas.dbcVault(a.lineMint, a.dbcPool)),
        w(a.payer, true), r(TOKEN_2022_PROGRAM), r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(TOKEN_2022_PROGRAM), r(METEORA.dammEventAuthority),
        r(SYSTEM_PROGRAM), r(dammConfig),
      ],
      data: disc("migration_damm_v2"),
    };
  },
};

// ---------- DAMM v2 (cp_amm release_0.2.5; account lists as its IDL) ----------

export const dammPdas = {
  position: (nftMint: Address) => pda(METEORA.dammV2Program, "position", addressBytes(nftMint)),
  positionNftAccount: (nftMint: Address) => pda(METEORA.dammV2Program, "position_nft_account", addressBytes(nftMint)),
};

const dammTail = () => [r(METEORA.dammEventAuthority), r(METEORA.dammV2Program)];

export const damm = {
  /** swap2 ExactIn (mode 0). Buy: `$LINE` (token B) in, agent tokens (token A) out. No referral account (the program id stands for None). */
  swap(a: { pool: Address; agentMint: Address; lineMint: Address; trader: Address; lineAccount: Address; agentAccount: Address; buy: boolean;
    amountIn: bigint; minOut: bigint; lineTokenProgram?: Address }): Ix {
    const [input, output] = a.buy ? [a.lineAccount, a.agentAccount] : [a.agentAccount, a.lineAccount];
    return {
      programId: METEORA.dammV2Program,
      keys: [r(METEORA.dammPoolAuthority), w(a.pool), w(input), w(output), w(launchPdas.dammVault(a.agentMint, a.pool)),
        w(launchPdas.dammVault(a.lineMint, a.pool)), r(a.agentMint), r(a.lineMint), r(a.trader, true), r(TOKEN_2022_PROGRAM),
        r(a.lineTokenProgram ?? TOKEN_PROGRAM), r(METEORA.dammV2Program), ...dammTail()],
      data: new Writer().bytes(disc("swap2")).u64(a.amountIn).u64(a.minOut).u8(0).done(),
    };
  },
  /** create_position: `payer` pays, `owner` gets the NFT. Signers: payer and `nftMint` (fresh keypair). */
  createPosition(a: { owner: Address; nftMint: Address; pool: Address; payer: Address }): Ix {
    return {
      programId: METEORA.dammV2Program,
      keys: [r(a.owner), w(a.nftMint, true), w(dammPdas.positionNftAccount(a.nftMint)), w(a.pool), w(dammPdas.position(a.nftMint)),
        r(METEORA.dammPoolAuthority), w(a.payer, true), r(TOKEN_2022_PROGRAM), r(SYSTEM_PROGRAM), ...dammTail()],
      data: disc("create_position"),
    };
  },
  /** add_liquidity, signed by the position NFT's holder; the thresholds are the most of each token it may take. */
  addLiquidity(a: { pool: Address; nftMint: Address; owner: Address; agentMint: Address; lineMint: Address; agentAccount: Address; lineAccount: Address;
    liquidity: bigint; maxAgent: bigint; maxLine: bigint; lineTokenProgram?: Address }): Ix {
    return {
      programId: METEORA.dammV2Program,
      keys: [w(a.pool), w(dammPdas.position(a.nftMint)), w(a.agentAccount), w(a.lineAccount), w(launchPdas.dammVault(a.agentMint, a.pool)),
        w(launchPdas.dammVault(a.lineMint, a.pool)), r(a.agentMint), r(a.lineMint), r(dammPdas.positionNftAccount(a.nftMint)), r(a.owner, true),
        r(TOKEN_2022_PROGRAM), r(a.lineTokenProgram ?? TOKEN_PROGRAM), ...dammTail()],
      data: new Writer().bytes(disc("add_liquidity")).u128(a.liquidity).u64(a.maxAgent).u64(a.maxLine).done(),
    };
  },
  /** permanent_lock_position, signed by the position NFT's holder. */
  permanentLock(a: { pool: Address; nftMint: Address; owner: Address; liquidity: bigint }): Ix {
    return {
      programId: METEORA.dammV2Program,
      keys: [w(a.pool), w(dammPdas.position(a.nftMint)), r(dammPdas.positionNftAccount(a.nftMint)), r(a.owner, true), ...dammTail()],
      data: new Writer().bytes(disc("permanent_lock_position")).u128(a.liquidity).done(),
    };
  },
};

/** Token-2022 SetAuthority(AccountOwner): hands a position NFT account (and so the position) to `newOwner`. */
export function setTokenAccountOwner(account: Address, newOwner: Address, owner: Address, tokenProgram: Address = TOKEN_2022_PROGRAM): Ix {
  return { programId: tokenProgram, keys: [w(account), r(owner, true)], data: new Writer().u8(6).u8(2).u8(1).address(newOwner).done() };
}

/** DAMM v2 Pool fields (offsets include the discriminator; `lineage_launch` meteora.rs reads the same). */
export interface DammPoolView {
  tokenAMint: Address;
  tokenBMint: Address;
  creator: Address;
  liquidity: bigint;
  permanentLockLiquidity: bigint;
}
const u128At = (d: Uint8Array, o: number) => {
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  return dv.getBigUint64(o, true) | (dv.getBigUint64(o + 8, true) << 64n);
};
export function decodeDammPool(d: Uint8Array): DammPoolView {
  return { tokenAMint: toAddress(d.subarray(168, 200)), tokenBMint: toAddress(d.subarray(200, 232)), creator: toAddress(d.subarray(648, 680)),
    liquidity: u128At(d, 360), permanentLockLiquidity: u128At(d, 552) };
}
export interface DammPositionView {
  pool: Address;
  nftMint: Address;
  unlockedLiquidity: bigint;
  vestedLiquidity: bigint;
  permanentLockedLiquidity: bigint;
}
export function decodeDammPosition(d: Uint8Array): DammPositionView {
  return { pool: toAddress(d.subarray(8, 40)), nftMint: toAddress(d.subarray(40, 72)), unlockedLiquidity: u128At(d, 152),
    vestedLiquidity: u128At(d, 168), permanentLockedLiquidity: u128At(d, 184) };
}

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
