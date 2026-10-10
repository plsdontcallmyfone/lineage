//! LiteSVM harness shared by the suites in `tests/`: loads the two compiled programs from
//! `target/deploy` (build them first with `cargo build-sbf`, see onchain/README.md), the real
//! Meteora DBC and DAMM v2 programs dumped from devnet (`vendor/meteora`, hashes pinned), and
//! LiteSVM's bundled SPL Token, Token-2022 and ATA programs.
#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::Clock;
pub use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::{bpf_loader_upgradeable, system_instruction, system_program};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
pub use lineage_launch as ll;
pub use lineage_registry as lr;
use litesvm::types::{TransactionMetadata, TransactionResult};
pub use litesvm::LiteSVM;
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::{Account as T22Account, Mint as T22Mint};

pub const T22: Pubkey = spl_token_2022::ID;
pub const TOKEN: Pubkey = anchor_spl::token::ID;
pub const DBC: Pubkey = ll::meteora::DBC_PROGRAM_ID;
pub const DAMM: Pubkey = ll::meteora::DAMM_V2_PROGRAM_ID;
pub const ATA_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const DAMM_DYNAMIC_CONFIG: Pubkey = anchor_lang::solana_program::pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
pub const NOW: i64 = 1_900_000_000;
pub const DECIMALS: u8 = 6;
pub const ONE: u64 = 1_000_000;
pub const LINE_SUPPLY: u64 = 1_000_000_000 * ONE;

pub const DBC_SO_SHA256: &str = "5edf76d972abaf355048db5d9003bc4dfa843cd98a5f93785430dac371678ad3";
pub const DAMM_SO_SHA256: &str = "82bb9375921bb8007551cb65f9ca43b191597496cc9922926468b36671081ec2";
/// The mainnet builds (`vendor/meteora/mainnet/fetch.sh`, read 2026-10-10; DBC last deployed in
/// mainnet slot 445,503,633, DAMM v2 in 445,230,614). `METEORA_BUILD=mainnet` runs every suite on them.
pub const DBC_MAINNET_SO_SHA256: &str = "4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b";
pub const DAMM_MAINNET_SO_SHA256: &str = "4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b";

/// The Meteora builds the suites load: the devnet pins by default, the mainnet ones with
/// `METEORA_BUILD=mainnet` (the DAMM v2 config account is the same bytes on both clusters).
fn meteora_builds() -> [(std::path::PathBuf, &'static str); 2] {
    if std::env::var("METEORA_BUILD").as_deref() == Ok("mainnet") {
        [(manifest("../vendor/meteora/mainnet/dbc.so"), DBC_MAINNET_SO_SHA256), (manifest("../vendor/meteora/mainnet/damm_v2.so"), DAMM_MAINNET_SO_SHA256)]
    } else {
        [(manifest("../vendor/meteora/dbc.so"), DBC_SO_SHA256), (manifest("../vendor/meteora/damm_v2.so"), DAMM_SO_SHA256)]
    }
}

// ---------- transactions ----------

pub fn send(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: Vec<Instruction>) -> TransactionResult {
    svm.expire_blockhash();
    let mut signers = vec![payer];
    for s in extra {
        if !signers.iter().any(|e| e.pubkey() == s.pubkey()) {
            signers.push(*s);
        }
    }
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &signers, svm.latest_blockhash());
    let wire = bincode::serialize(&tx).unwrap();
    assert!(wire.len() <= 1232, "transaction exceeds packet limit: {}", wire.len());
    svm.send_transaction(tx)
}
pub fn tx_size(payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> usize {
    let mut signers = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, Default::default());
    bincode::serialize(&tx).unwrap().len()
}
pub fn ok(result: TransactionResult) -> TransactionMetadata {
    match result {
        Ok(m) => m,
        Err(e) => panic!("transaction failed: {:?}\n{:#?}", e.err, e.meta.logs),
    }
}
pub fn rejects(result: TransactionResult, expected: &str) {
    let err = result.expect_err("transaction must fail");
    assert!(err.meta.logs.iter().any(|l| l.contains(expected)), "expected {expected}; logs {:#?}", err.meta.logs);
}
pub fn cu(units: u32) -> Instruction {
    solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_limit(units)
}
pub fn pda_of(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn rpda(seeds: &[&[u8]]) -> Pubkey {
    pda_of(seeds, &lr::ID)
}
pub fn lpda(seeds: &[&[u8]]) -> Pubkey {
    pda_of(seeds, &ll::ID)
}
pub fn manifest(rel: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}
pub fn seeded(byte: u8) -> Keypair {
    solana_keypair::keypair_from_seed(&[byte; 32]).unwrap()
}
pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    k
}
pub fn set_clock(svm: &mut LiteSVM, time: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = time;
    svm.set_sysvar(&clock);
}
pub fn warp(svm: &mut LiteSVM, seconds: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp += seconds;
    clock.slot += (seconds as u64) * 5 / 2;
    svm.set_sysvar(&clock);
}
pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

// ---------- tokens ----------

pub fn program_of(svm: &LiteSVM, mint: &Pubkey) -> Pubkey {
    svm.get_account(mint).unwrap().owner
}
pub fn balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    StateWithExtensions::<T22Account>::unpack(&svm.get_account(account).unwrap().data).unwrap().base.amount
}
pub fn supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    StateWithExtensions::<T22Mint>::unpack(&svm.get_account(mint).unwrap().data).unwrap().base.supply
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}
pub fn create_ata_ix(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(ata(owner, mint, token_program), false),
            AccountMeta::new_readonly(*owner, false), AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new_readonly(*token_program, false)],
        data: vec![1],
    }
}
/// An ATA (created idempotently) for `owner`.
pub fn ata_for(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let program = program_of(svm, mint);
    ok(send(svm, payer, &[], vec![create_ata_ix(&payer.pubkey(), owner, mint, &program)]));
    ata(owner, mint, &program)
}
pub fn transfer(svm: &mut LiteSVM, owner: &Keypair, mint: &Pubkey, from: &Pubkey, to: &Pubkey, amount: u64) {
    let program = program_of(svm, mint);
    ok(send(svm, owner, &[], vec![spl_token_2022::instruction::transfer_checked(&program, from, mint, to, &owner.pubkey(), &[], amount, DECIMALS).unwrap()]));
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum LineKind {
    /// Classic SPL Token mint.
    Classic,
    /// Token-2022 with a metadata pointer and metadata, as Pump.fun create_v2 mints.
    Pump,
}

/// `$LINE`: full supply to a holder, then the mint authority revoked.
pub fn create_line(svm: &mut LiteSVM, payer: &Keypair, kind: LineKind) -> (Pubkey, Pubkey) {
    use spl_token_2022::extension::{metadata_pointer, ExtensionType};
    let mint = Keypair::new();
    match kind {
        LineKind::Classic => {
            let rent = svm.minimum_balance_for_rent_exemption(82);
            ok(send(svm, payer, &[&mint], vec![
                system_instruction::create_account(&payer.pubkey(), &mint.pubkey(), rent, 82, &TOKEN),
                spl_token_2022::instruction::initialize_mint2(&TOKEN, &mint.pubkey(), &payer.pubkey(), None, DECIMALS).unwrap(),
            ]));
        }
        LineKind::Pump => {
            let space = ExtensionType::try_calculate_account_len::<T22Mint>(&[ExtensionType::MetadataPointer]).unwrap();
            let rent = svm.minimum_balance_for_rent_exemption(space + 512);
            let init_meta = Instruction {
                program_id: T22,
                accounts: vec![AccountMeta::new(mint.pubkey(), false), AccountMeta::new_readonly(payer.pubkey(), false),
                    AccountMeta::new_readonly(mint.pubkey(), false), AccountMeta::new_readonly(payer.pubkey(), true)],
                data: token_metadata_initialize_data("Line", "LINE", "https://example.invalid/line.json"),
            };
            ok(send(svm, payer, &[&mint], vec![
                system_instruction::create_account(&payer.pubkey(), &mint.pubkey(), rent, space as u64, &T22),
                metadata_pointer::instruction::initialize(&T22, &mint.pubkey(), Some(payer.pubkey()), Some(mint.pubkey())).unwrap(),
                spl_token_2022::instruction::initialize_mint2(&T22, &mint.pubkey(), &payer.pubkey(), None, DECIMALS).unwrap(),
                init_meta,
            ]));
        }
    }
    let program = program_of(svm, &mint.pubkey());
    let holder = ata_for(svm, payer, &payer.pubkey(), &mint.pubkey());
    ok(send(svm, payer, &[], vec![spl_token_2022::instruction::mint_to(&program, &mint.pubkey(), &holder, &payer.pubkey(), &[], LINE_SUPPLY).unwrap()]));
    ok(send(svm, payer, &[], vec![spl_token_2022::instruction::set_authority(&program, &mint.pubkey(), None,
        spl_token_2022::instruction::AuthorityType::MintTokens, &payer.pubkey(), &[]).unwrap()]));
    (mint.pubkey(), holder)
}
/// spl-token-metadata-interface `Initialize` (discriminator sha256("spl_token_metadata_interface:initialize_account")[..8]).
fn token_metadata_initialize_data(name: &str, symbol: &str, uri: &str) -> Vec<u8> {
    use sha2::Digest;
    let mut d = sha2::Sha256::digest(b"spl_token_metadata_interface:initialize_account")[..8].to_vec();
    for s in [name, symbol, uri] {
        d.extend_from_slice(&(s.len() as u32).to_le_bytes());
        d.extend_from_slice(s.as_bytes());
    }
    d
}

// ---------- environment ----------

fn check_sha(path: &std::path::Path, want: &str) {
    use sha2::Digest;
    let bytes = std::fs::read(path).unwrap_or_else(|_| panic!("{} missing: run onchain/vendor/meteora/fetch.sh", path.display()));
    let got: String = sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(got, want, "{} is not the pinned build", path.display());
}

/// Upgradeable-loader ProgramData naming `authority` for `program`, so initialize is checked as on a cluster.
pub fn install_program_data(svm: &mut LiteSVM, program: &Pubkey, authority: &Pubkey) -> Pubkey {
    let address = Pubkey::find_program_address(&[program.as_ref()], &bpf_loader_upgradeable::ID).0;
    let mut data = vec![3, 0, 0, 0];
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(1);
    data.extend_from_slice(authority.as_ref());
    svm.set_account(address, solana_account::Account { lamports: 10_000_000, data, owner: bpf_loader_upgradeable::ID, executable: false, rent_epoch: 0 })
        .unwrap();
    address
}

pub fn fresh_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(lr::ID, manifest("../target/deploy/lineage_registry.so")).expect("build lineage_registry first (cargo build-sbf)");
    svm.add_program_from_file(ll::ID, manifest("../target/deploy/lineage_launch.so")).expect("build lineage_launch first (cargo build-sbf)");
    let [(dbc, dbc_sha), (damm, damm_sha)] = meteora_builds();
    check_sha(&dbc, dbc_sha);
    check_sha(&damm, damm_sha);
    svm.add_program_from_file(DBC, dbc).unwrap();
    svm.add_program_from_file(DAMM, damm).unwrap();
    let data = std::fs::read(manifest("../vendor/meteora/damm_v2_dynamic_config.bin")).unwrap();
    svm.set_account(DAMM_DYNAMIC_CONFIG, solana_account::Account { lamports: 2_316_480, data, owner: DAMM, executable: false, rent_epoch: 0 }).unwrap();
    // DBC lends rent from its pool authority during migration (devnet holds about 99 SOL there).
    svm.airdrop(&ll::meteora::DBC_POOL_AUTHORITY, 1_000_000_000).unwrap();
    set_clock(&mut svm, NOW);
    svm
}

/// The M1 test values of config/network.json (SPEC 13), in onchain units, except
/// `epoch_length_s` 300: the cooldown floor needs unbond_cooldown_s >= 2 x epoch_length_s.
pub fn test_params() -> lr::Params {
    lr::Params {
        register_burn: 1_000 * ONE,
        min_bond: 5_000 * ONE,
        bond_cap: 50_000 * ONE,
        unbond_cooldown_s: 600,
        epoch_length_s: 300,
        reserve_bps: 8000,
        pool_bps: 2000,
        canary_slash_bps: 2500,
        minority_slash_bps: 500,
        reveal_slash_bps: 200,
        strike_limit: 3,
        u_replay: 1,
        u_author: 4,
        finder_share_bps: 1000,
        value_cap: 8,
        rebate_per_class: ONE,
        max_open_candidates_per_agent: 3,
        author_reward_to: 0,
        quorum: 2,
    }
}

pub struct Env {
    pub svm: LiteSVM,
    /// Upgrade authority of both programs and the admin of both configs.
    pub admin: Keypair,
    pub core: Keypair,
    pub runtime: Keypair,
    pub line_mint: Pubkey,
    pub line_program: Pubkey,
    /// Holds the whole `$LINE` supply (the admin's ATA).
    pub line_holder: Pubkey,
    pub compute_sink: Pubkey,
    pub dbc_config: Pubkey,
}

/// TEST value: the most rebate one `post_epoch` may move.
pub const MAX_REBATE: u64 = 1_000_000 * ONE;
pub fn config_args(admin: &Pubkey, core: &Pubkey) -> lr::ConfigArgs {
    lr::ConfigArgs { admin: *admin, core_authority: *core, launch_program: ll::ID, params: test_params(), max_rebate_per_epoch: MAX_REBATE }
}
pub fn slash_receipt(id: &[u8; 32]) -> Pubkey {
    rpda(&[lr::SLASH_SEED, id])
}
/// A slash id from a counter (Core's ids are sha256 digests).
pub fn sid(n: u64) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[..8].copy_from_slice(&n.to_le_bytes());
    id
}

pub fn registry_config() -> Pubkey {
    rpda(&[lr::CONFIG_SEED])
}
pub fn vault_authority() -> Pubkey {
    rpda(&[lr::VAULT_AUTHORITY_SEED])
}
pub fn bond_vault() -> Pubkey {
    rpda(&[lr::BOND_VAULT_SEED])
}
pub fn treasury() -> Pubkey {
    rpda(&[lr::TREASURY_SEED])
}
pub fn reserve_vault() -> Pubkey {
    rpda(&[lr::RESERVE_SEED])
}
pub fn pool_vault() -> Pubkey {
    rpda(&[lr::POOL_SEED])
}
pub fn payable_vault() -> Pubkey {
    rpda(&[lr::PAYABLE_SEED])
}
pub fn agent_record(agent: &Pubkey) -> Pubkey {
    rpda(&[lr::AGENT_SEED, agent.as_ref()])
}
pub fn epoch_pda(n: u64) -> Pubkey {
    rpda(&[lr::EPOCH_SEED, &n.to_le_bytes()])
}
pub fn challenge_config() -> Pubkey {
    rpda(&[lr::CHALLENGE_CONFIG_SEED])
}
pub fn challenge_vault() -> Pubkey {
    rpda(&[lr::CHALLENGE_VAULT_SEED])
}
pub fn challenge_gate(epoch: u64) -> Pubkey {
    rpda(&[lr::GATE_SEED, &epoch.to_le_bytes()])
}
pub fn challenge_pda(kind: u8, subject: &[u8; 32]) -> Pubkey {
    rpda(&[lr::CHALLENGE_SEED, &[kind], subject])
}
pub fn launch_config() -> Pubkey {
    lpda(&[ll::LAUNCH_CONFIG_SEED])
}
pub fn launch_authority() -> Pubkey {
    lpda(&[ll::AUTHORITY_SEED])
}
pub fn compute_vault(agent: &Pubkey) -> Pubkey {
    lpda(&[ll::COMPUTE_SEED, agent.as_ref()])
}
pub fn agent_launch(mint: &Pubkey) -> Pubkey {
    lpda(&[ll::AGENT_LAUNCH_SEED, mint.as_ref()])
}

pub fn read<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    T::try_deserialize(&mut svm.get_account(key).unwrap().data.as_slice()).unwrap()
}

pub fn registry_init_ix(signer: Pubkey, args: lr::ConfigArgs, line_mint: Pubkey, line_program: Pubkey) -> Instruction {
    Instruction {
        program_id: lr::ID,
        accounts: lr::accounts::Initialize {
            config: registry_config(), upgrade_authority: signer, program_data: pda_of(&[lr::ID.as_ref()], &bpf_loader_upgradeable::ID),
            mint: line_mint, vault_authority: vault_authority(), bond_vault: bond_vault(), treasury: treasury(), reserve_vault: reserve_vault(),
            pool_vault: pool_vault(), payable_vault: payable_vault(), token_program: line_program, system_program: system_program::ID,
        }.to_account_metas(None),
        data: lr::instruction::Initialize { args }.data(),
    }
}

pub fn launch_args(admin: &Pubkey, runtime: &Pubkey, compute_sink: &Pubkey) -> ll::LaunchConfigArgs {
    ll::LaunchConfigArgs {
        admin: *admin, runtime_authority: *runtime, compute_sink: *compute_sink,
        agent_compute_bps: 7000, protocol_bps: 3000, sleep_threshold: 1_000 * ONE, wake_threshold: 2_000 * ONE, paused: false, max_debit_per_epoch: 0,
    }
}
pub fn launch_init_ix(signer: Pubkey, args: ll::LaunchConfigArgs, line_mint: Pubkey, line_program: Pubkey, dbc_config: Pubkey) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::InitializeLaunch {
            launch_config: launch_config(), upgrade_authority: signer, program_data: pda_of(&[ll::ID.as_ref()], &bpf_loader_upgradeable::ID),
            authority: launch_authority(), line_mint, dbc_config, line_token_program: line_program, system_program: system_program::ID,
        }.to_account_metas(None),
        data: ll::instruction::InitializeLaunch { args }.data(),
    }
}
pub fn set_launch_config_ix(admin: Pubkey, args: ll::LaunchConfigArgs, dbc_config: Pubkey) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::SetLaunchConfig { launch_config: launch_config(), admin, dbc_config }.to_account_metas(None),
        data: ll::instruction::SetLaunchConfig { args }.data(),
    }
}

// ---------- DBC config (ConfigParameters, Borsh, in create_config's field order) ----------

#[derive(Clone, Copy)]
pub struct DbcParams {
    pub cliff_fee_numerator: u64,
    pub collect_fee_mode: u8,
    pub migration_option: u8,
    pub token_type: u8,
    pub partner_locked: u8,
    pub creator_locked: u8,
    pub threshold: u64,
    pub sqrt_start: u128,
    pub creator_trading_fee: u8,
    pub migrated_fee_bps: u16,
    pub supply: u64,
    pub curve: (u128, u128),
}
/// A flat 3% curve, Token-2022 agent mints with 6 decimals and a fixed 100M supply, fees in the
/// quote token, DAMM v2 with 100% of the LP permanently locked to the partner. Curve numbers are
/// the reference program's standard curve at its test reference price (start sqrt price
/// floor(sqrt(0.05) x 2^64), one segment to 4x, threshold 15,999,999.999792 quote): test values,
/// not launch values (SPEC 20 question 2).
pub fn standard_dbc_params() -> DbcParams {
    DbcParams {
        cliff_fee_numerator: 30_000_000,
        collect_fee_mode: 0,
        migration_option: 1,
        token_type: 1,
        partner_locked: 100,
        creator_locked: 0,
        threshold: 15_999_999_999_792,
        sqrt_start: 4_124_817_371_235_594_858,
        creator_trading_fee: 0,
        migrated_fee_bps: 300,
        supply: 100_000_000 * ONE,
        curve: (16_499_269_484_942_379_432, 439_980_519_592_732_705_252_230_013_543_952),
    }
}
pub fn encode_params(p: &DbcParams) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(&p.cliff_fee_numerator.to_le_bytes());
    d.extend_from_slice(&0u16.to_le_bytes()); // number_of_period
    d.extend_from_slice(&0u64.to_le_bytes()); // period_frequency
    d.extend_from_slice(&0u64.to_le_bytes()); // reduction_factor
    d.push(0); // base fee mode: linear scheduler (flat with no periods)
    d.push(0); // dynamic_fee: None
    d.extend_from_slice(&[p.collect_fee_mode, p.migration_option, 1 /* timestamp */, p.token_type, DECIMALS]);
    d.extend_from_slice(&[100 - p.partner_locked - p.creator_locked, p.partner_locked, 0, p.creator_locked]);
    d.extend_from_slice(&p.threshold.to_le_bytes());
    d.extend_from_slice(&p.sqrt_start.to_le_bytes());
    d.extend_from_slice(&[0u8; 40]); // locked_vesting
    d.push(6); // migration_fee_option: Customizable
    d.push(1); // token_supply: Some
    d.extend_from_slice(&p.supply.to_le_bytes());
    d.extend_from_slice(&p.supply.to_le_bytes());
    d.push(p.creator_trading_fee);
    d.push(1); // token_update_authority: Immutable
    d.extend_from_slice(&[0, 0]); // migration_fee
    d.extend_from_slice(&[0, 0]); // migrated_pool_fee: collect mode, dynamic fee
    d.extend_from_slice(&p.migrated_fee_bps.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes()); // pool_creation_fee
    d.extend_from_slice(&[0u8; 13]); // partner liquidity vesting
    d.extend_from_slice(&[0u8; 13]); // creator liquidity vesting
    d.push(0); // migrated_pool_base_fee_mode
    d.extend_from_slice(&[0u8; 16]); // market cap scheduler params
    d.push(0); // enable_first_swap_with_min_fee
    d.extend_from_slice(&0u16.to_le_bytes()); // compounding_fee_bps
    d.extend_from_slice(&[0, 0]); // padding
    d.extend_from_slice(&1u32.to_le_bytes());
    d.extend_from_slice(&p.curve.0.to_le_bytes());
    d.extend_from_slice(&p.curve.1.to_le_bytes());
    d
}
pub fn mt_disc(name: &str) -> [u8; 8] {
    anchor_lang::solana_program::hash::hash(name.as_bytes()).to_bytes()[..8].try_into().unwrap()
}
pub fn dbc_event_authority() -> Pubkey {
    pda_of(&[b"__event_authority"], &DBC)
}
pub fn damm_event_authority() -> Pubkey {
    pda_of(&[b"__event_authority"], &DAMM)
}
pub fn create_dbc_config(svm: &mut LiteSVM, payer: &Keypair, quote_mint: &Pubkey, fee_claimer: &Pubkey, p: &DbcParams) -> (TransactionResult, Pubkey) {
    let config = Keypair::new();
    let mut data = mt_disc("global:create_config").to_vec();
    data.extend(encode_params(p));
    let ix = Instruction {
        program_id: DBC,
        accounts: vec![AccountMeta::new(config.pubkey(), true), AccountMeta::new_readonly(*fee_claimer, false),
            AccountMeta::new_readonly(*fee_claimer, false), AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(dbc_event_authority(), false), AccountMeta::new_readonly(DBC, false)],
        data,
    };
    (send(svm, payer, &[&config], vec![ix]), config.pubkey())
}

/// Both programs initialized against one `$LINE` mint and the standard DBC config.
pub fn setup(kind: LineKind) -> Env {
    let mut svm = fresh_svm();
    let admin = Keypair::new();
    let core = Keypair::new();
    let runtime = Keypair::new();
    for k in [&admin, &core, &runtime] {
        svm.airdrop(&k.pubkey(), 1_000_000_000_000).unwrap();
    }
    let (line_mint, line_holder) = create_line(&mut svm, &admin, kind);
    let line_program = program_of(&svm, &line_mint);
    install_program_data(&mut svm, &lr::ID, &admin.pubkey());
    install_program_data(&mut svm, &ll::ID, &admin.pubkey());
    let args = config_args(&admin.pubkey(), &core.pubkey());
    // Nobody but the upgrade authority can initialize.
    let stranger = funded(&mut svm);
    rejects(send(&mut svm, &stranger, &[], vec![registry_init_ix(stranger.pubkey(), args, line_mint, line_program)]), "Unauthorized");
    ok(send(&mut svm, &admin, &[], vec![registry_init_ix(admin.pubkey(), args, line_mint, line_program)]));
    let (r, dbc_config) = create_dbc_config(&mut svm, &admin, &line_mint, &launch_authority(), &standard_dbc_params());
    ok(r);
    let compute_sink = ata_for(&mut svm, &admin, &runtime.pubkey(), &line_mint);
    let largs = launch_args(&admin.pubkey(), &runtime.pubkey(), &compute_sink);
    rejects(send(&mut svm, &stranger, &[], vec![launch_init_ix(stranger.pubkey(), largs, line_mint, line_program, dbc_config)]), "Unauthorized");
    ok(send(&mut svm, &admin, &[], vec![launch_init_ix(admin.pubkey(), largs, line_mint, line_program, dbc_config)]));
    Env { svm, admin, core, runtime, line_mint, line_program, line_holder, compute_sink, dbc_config }
}

impl Env {
    /// A funded wallet with an ATA holding `line` of `$LINE`.
    pub fn wallet_with(&mut self, key: Keypair, line: u64) -> (Keypair, Pubkey) {
        self.svm.airdrop(&key.pubkey(), 100_000_000_000).unwrap();
        let admin = self.admin.insecure_clone();
        let acct = ata_for(&mut self.svm, &admin, &key.pubkey(), &self.line_mint);
        if line > 0 {
            let (m, h) = (self.line_mint, self.line_holder);
            transfer(&mut self.svm, &admin, &m, &h, &acct, line);
        }
        (key, acct)
    }
    pub fn wallet(&mut self, line: u64) -> (Keypair, Pubkey) {
        self.wallet_with(Keypair::new(), line)
    }
    pub fn fund(&mut self, to: &Pubkey, amount: u64) {
        let admin = self.admin.insecure_clone();
        let (m, h) = (self.line_mint, self.line_holder);
        transfer(&mut self.svm, &admin, &m, &h, to, amount);
    }
    pub fn rconfig(&self) -> lr::Config {
        read(&self.svm, &registry_config())
    }
    pub fn agent(&self, agent: &Pubkey) -> lr::Agent {
        read(&self.svm, &agent_record(agent))
    }

    // ----- registry instructions -----

    pub fn register_ix(&self, owner: &Pubkey, agent: &Pubkey, owner_token: &Pubkey) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::Register {
                config: registry_config(), owner: *owner, agent: *agent, agent_record: agent_record(agent), mint: self.line_mint,
                owner_token: *owner_token, token_program: self.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: lr::instruction::Register { operator: [7; 32], capabilities: [9; 32] }.data(),
        }
    }
    pub fn bond_ix(&self, owner: &Pubkey, agent: &Pubkey, owner_token: &Pubkey, amount: u64) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::BondCtx {
                config: registry_config(), owner: *owner, agent_record: agent_record(agent), mint: self.line_mint, owner_token: *owner_token,
                bond_vault: bond_vault(), token_program: self.line_program,
            }.to_account_metas(None),
            data: lr::instruction::Bond { amount }.data(),
        }
    }
    pub fn owner_agent_ix(&self, owner: &Pubkey, agent: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::OwnerAgent { config: registry_config(), owner: *owner, agent_record: agent_record(agent) }.to_account_metas(None),
            data,
        }
    }
    pub fn withdraw_unbonded_ix(&self, owner: &Pubkey, agent: &Pubkey, owner_token: &Pubkey) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::WithdrawUnbonded {
                config: registry_config(), owner: *owner, agent_record: agent_record(agent), mint: self.line_mint, owner_token: *owner_token,
                vault_authority: vault_authority(), bond_vault: bond_vault(), token_program: self.line_program,
            }.to_account_metas(None),
            data: lr::instruction::WithdrawUnbonded {}.data(),
        }
    }
    pub fn slash_ix(&self, signer: &Pubkey, agent: &Pubkey, offence: u8, epoch: u64, slash_id: [u8; 32]) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::Slash {
                config: registry_config(), core_authority: *signer, slash_receipt: slash_receipt(&slash_id), agent_record: agent_record(agent),
                mint: self.line_mint, vault_authority: vault_authority(), bond_vault: bond_vault(), reserve_vault: reserve_vault(),
                token_program: self.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: lr::instruction::Slash { offence, epoch, slash_id }.data(),
        }
    }
    pub fn split_ix(&self) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::Split {
                config: registry_config(), mint: self.line_mint, vault_authority: vault_authority(), treasury: treasury(),
                reserve_vault: reserve_vault(), pool_vault: pool_vault(), token_program: self.line_program,
            }.to_account_metas(None),
            data: lr::instruction::Split {}.data(),
        }
    }
    pub fn post_epoch_ix(&self, signer: &Pubkey, args: lr::PostEpochArgs) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::PostEpoch {
                config: registry_config(), core_authority: *signer, epoch: epoch_pda(args.epoch), mint: self.line_mint,
                vault_authority: vault_authority(), pool_vault: pool_vault(), reserve_vault: reserve_vault(), payable_vault: payable_vault(),
                token_program: self.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: lr::instruction::PostEpoch { args }.data(),
        }
    }
    pub fn claim_ix(&self, payer: &Pubkey, epoch: u64, args: lr::ClaimArgs, agent_rec: Option<Pubkey>, dest_token: &Pubkey) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::Claim {
                config: registry_config(), payer: *payer, epoch: epoch_pda(epoch),
                receipt: rpda(&[lr::CLAIM_SEED, &epoch.to_le_bytes(), &args.leaf]), agent_record: agent_rec, mint: self.line_mint,
                vault_authority: vault_authority(), payable_vault: payable_vault(), dest_token: *dest_token, token_program: self.line_program,
                system_program: system_program::ID, challenge_config: challenge_config(), challenge_gate: challenge_gate(epoch),
            }.to_account_metas(None),
            data: lr::instruction::Claim { args }.data(),
        }
    }
    pub fn set_challenge_config_ix(&self, admin: &Pubkey, args: lr::ChallengeConfigArgs) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::SetChallengeConfig {
                config: registry_config(), admin: *admin, challenge_config: challenge_config(), mint: self.line_mint, vault_authority: vault_authority(),
                challenge_vault: challenge_vault(), token_program: self.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: lr::instruction::SetChallengeConfig { args }.data(),
        }
    }
    pub fn open_challenge_ix(&self, challenger: &Pubkey, signing_key: &Pubkey, payer: &Pubkey, payer_token: &Pubkey, args: lr::OpenChallengeArgs)
        -> Instruction {
        let slash_receipt = (args.kind == lr::KIND_SLASH).then(|| slash_receipt(&args.subject));
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::OpenChallenge {
                config: registry_config(), challenge_config: challenge_config(), challenger_record: agent_record(challenger), signing_key: *signing_key,
                payer: *payer, payer_token: *payer_token, challenge: challenge_pda(args.kind, &args.subject), gate: challenge_gate(args.epoch),
                epoch_account: epoch_pda(args.epoch), slash_receipt, mint: self.line_mint, challenge_vault: challenge_vault(),
                token_program: self.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: lr::instruction::OpenChallenge { args }.data(),
        }
    }
    /// `slashed`: the contested slash's (slash id, agent) for an upheld slash challenge; `correct`: pass the epoch account.
    pub fn resolve_challenge_ix(&self, signer: &Pubkey, kind: u8, subject: &[u8; 32], epoch: u64, refund_token: &Pubkey,
        args: lr::ResolveChallengeArgs, slashed: Option<Pubkey>) -> Instruction {
        let is_slash = kind == lr::KIND_SLASH;
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::ResolveChallenge {
                config: registry_config(), challenge_config: challenge_config(), core_authority: *signer, challenge: challenge_pda(kind, subject),
                gate: challenge_gate(epoch), refund_token: *refund_token, mint: self.line_mint, vault_authority: vault_authority(),
                challenge_vault: challenge_vault(), reserve_vault: reserve_vault(),
                epoch: args.corrected.map(|_| epoch_pda(epoch)),
                slash_receipt: is_slash.then(|| slash_receipt(subject)),
                agent_record: slashed.map(|a| agent_record(&a)),
                bond_vault: is_slash.then(bond_vault),
                token_program: self.line_program,
            }.to_account_metas(None),
            data: lr::instruction::ResolveChallenge { args }.data(),
        }
    }
    pub fn expire_challenge_ix(&self, kind: u8, subject: &[u8; 32], epoch: u64, refund_token: &Pubkey) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::ExpireChallenge {
                config: registry_config(), challenge_config: challenge_config(), challenge: challenge_pda(kind, subject), gate: challenge_gate(epoch),
                refund_token: *refund_token, mint: self.line_mint, vault_authority: vault_authority(), challenge_vault: challenge_vault(),
                token_program: self.line_program, reserve_vault: reserve_vault(),
            }.to_account_metas(None),
            data: lr::instruction::ExpireChallenge {}.data(),
        }
    }
    pub fn rotate_agent_key_ix(&self, owner: &Pubkey, agent: &Pubkey, new_key: &Pubkey) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::RotateAgentKey { config: registry_config(), owner: *owner, new_key: *new_key, agent_record: agent_record(agent) }
                .to_account_metas(None),
            data: lr::instruction::RotateAgentKey {}.data(),
        }
    }
    pub fn set_profile_ix(&self, signing_key: &Pubkey, agent: &Pubkey, digest: [u8; 32], seq: u32) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::SetProfile { config: registry_config(), signing_key: *signing_key, agent_record: agent_record(agent) }
                .to_account_metas(None),
            data: lr::instruction::SetProfile { digest, seq }.data(),
        }
    }
    pub fn accept_owner_ix(&self, new_owner: &Pubkey, agent: &Pubkey) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::AcceptOwner { config: registry_config(), new_owner: *new_owner, agent_record: agent_record(agent) }
                .to_account_metas(None),
            data: lr::instruction::AcceptOwner {}.data(),
        }
    }
    pub fn admin_ix(&self, admin: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::AdminOnly { config: registry_config(), admin: *admin }.to_account_metas(None),
            data,
        }
    }

    /// Registers a verifier for `agent` owned by `owner` (both sign) and returns the owner's ATA.
    pub fn register_verifier(&mut self, owner: &Keypair, agent: &Keypair) -> Pubkey {
        let owner_token = ata(&owner.pubkey(), &self.line_mint, &self.line_program);
        let ix = self.register_ix(&owner.pubkey(), &agent.pubkey(), &owner_token);
        ok(send(&mut self.svm, owner, &[agent], vec![ix]));
        owner_token
    }
}

// ---------- launches ----------

pub struct Launched {
    pub agent: Keypair,
    pub launcher: Keypair,
    pub launcher_line: Pubkey,
    pub mint: Pubkey,
    pub launch: Pubkey,
    pub dbc_pool: Pubkey,
    pub dbc_base_vault: Pubkey,
    pub dbc_quote_vault: Pubkey,
    pub compute_vault: Pubkey,
    pub authority_agent_token: Pubkey,
}
pub fn max_min(a: &Pubkey, b: &Pubkey) -> (Pubkey, Pubkey) {
    if a > b { (*a, *b) } else { (*b, *a) }
}
pub fn dbc_pool_of(dbc_config: &Pubkey, mint: &Pubkey, line: &Pubkey) -> Pubkey {
    let (hi, lo) = max_min(mint, line);
    pda_of(&[b"pool", dbc_config.as_ref(), hi.as_ref(), lo.as_ref()], &DBC)
}
pub fn default_launch_args() -> ll::LaunchArgs {
    ll::LaunchArgs {
        name: "Base58 Agent".into(),
        symbol: "B58A".into(),
        uri: "https://example.invalid/agents/b58a.json".into(),
        repo_url: "https://github.com/lineage-test/base58".into(),
        identity_mode: ll::IDENTITY_APP,
        hosted: true,
    }
}
impl Env {
    pub fn launch_ix(&self, launcher: &Pubkey, agent: &Pubkey, mint: &Pubkey, args: ll::LaunchArgs) -> Instruction {
        let dbc_pool = dbc_pool_of(&self.dbc_config, mint, &self.line_mint);
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::LaunchAgent {
                launch_config: launch_config(), authority: launch_authority(), launcher: *launcher, agent: *agent, agent_mint: *mint,
                line_mint: self.line_mint, dbc_config: self.dbc_config, dbc_pool,
                dbc_base_vault: pda_of(&[b"token_vault", mint.as_ref(), dbc_pool.as_ref()], &DBC),
                dbc_quote_vault: pda_of(&[b"token_vault", self.line_mint.as_ref(), dbc_pool.as_ref()], &DBC),
                agent_launch: agent_launch(mint), compute_vault: compute_vault(agent), registry_config: registry_config(),
                agent_record: agent_record(agent), registry_program: lr::ID, dbc_pool_authority: ll::meteora::DBC_POOL_AUTHORITY,
                dbc_event_authority: ll::meteora::DBC_EVENT_AUTHORITY, dbc_program: DBC, line_token_program: self.line_program,
                token_2022_program: T22, system_program: system_program::ID,
            }.to_account_metas(None),
            data: ll::instruction::LaunchAgent { args }.data(),
        }
    }
    pub fn try_launch(&mut self, launcher: &Keypair, agent: &Keypair, mint: &Keypair, args: ll::LaunchArgs) -> TransactionResult {
        let ix = self.launch_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), args);
        send(&mut self.svm, launcher, &[agent, mint], vec![cu(400_000), ix])
    }
    pub fn launch_agent(&mut self, agent: Keypair, args: ll::LaunchArgs) -> Launched {
        let (launcher, launcher_line) = self.wallet(0);
        let mint = Keypair::new();
        ok(self.try_launch(&launcher, &agent, &mint, args));
        let m = mint.pubkey();
        let dbc_pool = dbc_pool_of(&self.dbc_config, &m, &self.line_mint);
        let a = launch_authority();
        let admin = self.admin.insecure_clone();
        ok(send(&mut self.svm, &admin, &[], vec![create_ata_ix(&admin.pubkey(), &a, &m, &T22)]));
        Launched {
            launch: agent_launch(&m),
            compute_vault: compute_vault(&agent.pubkey()),
            agent,
            launcher,
            launcher_line,
            mint: m,
            dbc_pool,
            dbc_base_vault: pda_of(&[b"token_vault", m.as_ref(), dbc_pool.as_ref()], &DBC),
            dbc_quote_vault: pda_of(&[b"token_vault", self.line_mint.as_ref(), dbc_pool.as_ref()], &DBC),
            authority_agent_token: ata(&a, &m, &T22),
        }
    }
    pub fn crank_fees_ix(&self, l: &Launched) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::CrankFees {
                launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch, dbc_config: self.dbc_config,
                dbc_pool: l.dbc_pool, dbc_base_vault: l.dbc_base_vault, dbc_quote_vault: l.dbc_quote_vault, agent_mint: l.mint,
                line_mint: self.line_mint, authority_agent_token: l.authority_agent_token, compute_vault: l.compute_vault, treasury: treasury(),
                dbc_pool_authority: ll::meteora::DBC_POOL_AUTHORITY, dbc_event_authority: ll::meteora::DBC_EVENT_AUTHORITY, dbc_program: DBC,
                line_token_program: self.line_program, token_2022_program: T22,
            }.to_account_metas(None),
            data: ll::instruction::CrankFees {}.data(),
        }
    }
    pub fn crank_fees(&mut self, l: &Launched) -> TransactionResult {
        let k = funded(&mut self.svm);
        let ix = self.crank_fees_ix(l);
        send(&mut self.svm, &k, &[], vec![cu(400_000), ix])
    }
    /// A third party swaps on the agent's DBC curve (buy: `$LINE` in).
    pub fn dbc_swap(&mut self, l: &Launched, trader: &Keypair, line_acct: &Pubkey, agent_acct: &Pubkey, buy: bool, amount_in: u64, min_out: u64,
        mode: u8) -> TransactionResult {
        let (input, output) = if buy { (*line_acct, *agent_acct) } else { (*agent_acct, *line_acct) };
        let mut data = mt_disc("global:swap2").to_vec();
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&min_out.to_le_bytes());
        data.push(mode);
        let ix = Instruction {
            program_id: DBC,
            accounts: vec![AccountMeta::new_readonly(ll::meteora::DBC_POOL_AUTHORITY, false), AccountMeta::new_readonly(self.dbc_config, false),
                AccountMeta::new(l.dbc_pool, false), AccountMeta::new(input, false), AccountMeta::new(output, false),
                AccountMeta::new(l.dbc_base_vault, false), AccountMeta::new(l.dbc_quote_vault, false),
                AccountMeta::new_readonly(l.mint, false), AccountMeta::new_readonly(self.line_mint, false),
                AccountMeta::new_readonly(trader.pubkey(), true), AccountMeta::new_readonly(T22, false),
                AccountMeta::new_readonly(self.line_program, false), AccountMeta::new_readonly(DBC, false),
                AccountMeta::new_readonly(dbc_event_authority(), false), AccountMeta::new_readonly(DBC, false)],
            data,
        };
        send(&mut self.svm, trader, &[], vec![cu(400_000), ix])
    }
    /// A trader with `line` of `$LINE` and an agent-token ATA.
    pub fn trader(&mut self, l: &Launched, line: u64) -> (Keypair, Pubkey, Pubkey) {
        let (k, la) = self.wallet(line);
        let admin = self.admin.insecure_clone();
        let aa = ata_for(&mut self.svm, &admin, &k.pubkey(), &l.mint);
        (k, la, aa)
    }
}

/// DBC VirtualPool fields read by the suites (offsets include the discriminator).
pub struct DbcView {
    pub quote_reserve: u64,
    pub protocol_quote_fee: u64,
    pub partner_quote_fee: u64,
    pub migration_progress: u8,
}
pub fn dbc_view(svm: &LiteSVM, pool: &Pubkey) -> DbcView {
    let d = svm.get_account(pool).unwrap().data;
    let u = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    DbcView { quote_reserve: u(240), protocol_quote_fee: u(256), partner_quote_fee: u(272), migration_progress: d[308] }
}

// ---------- fixtures from the TypeScript protocol code ----------

pub fn fixtures() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(manifest("fixtures/merkle.json")).unwrap()).unwrap()
}
pub fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}
pub fn b58_pubkey(s: &str) -> Pubkey {
    s.parse().unwrap()
}

pub fn migrate_agent_ix(payer: &Pubkey, agent: &Pubkey) -> Instruction {
    Instruction {
        program_id: lr::ID,
        accounts: lr::accounts::MigrateAgent { agent_record: agent_record(agent), payer: *payer, system_program: system_program::ID }.to_account_metas(None),
        data: lr::instruction::MigrateAgent {}.data(),
    }
}
pub fn migrate_epoch_ix(payer: &Pubkey, epoch: u64) -> Instruction {
    Instruction {
        program_id: lr::ID,
        accounts: lr::accounts::MigrateEpoch { epoch: epoch_pda(epoch), payer: *payer, system_program: system_program::ID }.to_account_metas(None),
        data: lr::instruction::MigrateEpoch {}.data(),
    }
}
