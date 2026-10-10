//! LiteSVM harness shared by the suites in `tests/`: loads the compiled programs from
//! `target/deploy` (build them first with `cargo build-sbf`, see onchain/README.md), mainnet's
//! pump.fun programs and accounts (`vendor/pump`, hashes pinned; `pumpfun.rs`), and LiteSVM's
//! bundled SPL Token, Token-2022 and ATA programs.
#![allow(clippy::too_many_arguments, clippy::result_large_err)]
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

pub mod pumpfun;
pub use pumpfun as pf;
use spl_token_2022::extension::StateWithExtensions;
use spl_token_2022::state::{Account as T22Account, Mint as T22Mint};

pub const T22: Pubkey = spl_token_2022::ID;
pub const TOKEN: Pubkey = anchor_spl::token::ID;
pub const ATA_PROGRAM: Pubkey = anchor_lang::solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const NOW: i64 = 1_900_000_000;
pub const DECIMALS: u8 = 6;
pub const ONE: u64 = 1_000_000;
pub const LINE_SUPPLY: u64 = 1_000_000_000 * ONE;

/// `$LINE` base units a `LineKind::PumpCoin` setup buys on `$LINE`'s own curve for the admin (its
/// curve holds 793,100,000 tokens; this leaves it uncompleted).
pub const LINE_HELD: u64 = 700_000_000 * ONE;

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
/// `send` without the legacy packet assert: the pump.fun launch transaction is a v0 transaction with
/// a lookup table on clusters (its size is measured on the mainnet fork, scripts/mainnet).
pub fn send_unchecked(svm: &mut LiteSVM, payer: &Keypair, extra: &[&Keypair], ixs: Vec<Instruction>) -> TransactionResult {
    svm.expire_blockhash();
    let mut signers = vec![payer];
    for s in extra {
        if !signers.iter().any(|e| e.pubkey() == s.pubkey()) {
            signers.push(*s);
        }
    }
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &signers, svm.latest_blockhash());
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
    /// A real pump.fun coin (`create_v2`, paired with SOL, not mayhem) on mainnet's Pump build; the
    /// holder buys `LINE_HELD` on its curve. The only kind agent coins can be quoted in.
    PumpCoin,
}

/// `$LINE`: full supply to a holder, then the mint authority revoked.
pub fn create_line(svm: &mut LiteSVM, payer: &Keypair, kind: LineKind) -> (Pubkey, Pubkey) {
    use spl_token_2022::extension::{metadata_pointer, ExtensionType};
    let mint = Keypair::new();
    if let LineKind::PumpCoin = kind {
        let m = mint.pubkey();
        ok(send(svm, payer, &[&mint], vec![cu(400_000), pf::create_v2_ix(&m, &payer.pubkey(), &payer.pubkey(), "Lineage", "LINE", &pf::Quote::Sol, false, 0,
            false)]));
        let holder = ata_for(svm, payer, &payer.pubkey(), &m);
        let cap = pf::buy_cap(svm, &m, LINE_HELD);
        ok(send(svm, payer, &[], vec![cu(400_000), pf::buy_v3_ix(&m, &pf::WSOL, &TOKEN, &payer.pubkey(), LINE_HELD, cap)]));
        // trades in $LINE pay the buyback part of the protocol fee to buyback recipient 0's $LINE ATA
        ok(send(svm, payer, &[], vec![create_ata_ix(&payer.pubkey(), &pf::BUYBACK0, &m, &T22)]));
        return (m, holder);
    }
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
        LineKind::PumpCoin => unreachable!(),
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
    pf::install(&mut svm);
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
        pump_creator_fee_bps: 0,
    }
}
pub fn launch_init_ix(signer: Pubkey, args: ll::LaunchConfigArgs, line_mint: Pubkey, line_program: Pubkey) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::InitializeLaunch {
            launch_config: launch_config(), upgrade_authority: signer, program_data: pda_of(&[ll::ID.as_ref()], &bpf_loader_upgradeable::ID),
            authority: launch_authority(), line_mint, line_token_program: line_program, system_program: system_program::ID,
        }.to_account_metas(None),
        data: ll::instruction::InitializeLaunch { args }.data(),
    }
}
pub fn set_launch_config_ix(admin: Pubkey, args: ll::LaunchConfigArgs) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::SetLaunchConfig { launch_config: launch_config(), admin }.to_account_metas(None),
        data: ll::instruction::SetLaunchConfig { args }.data(),
    }
}

/// Both programs initialized against one `$LINE` mint.
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
    let compute_sink = ata_for(&mut svm, &admin, &runtime.pubkey(), &line_mint);
    let largs = launch_args(&admin.pubkey(), &runtime.pubkey(), &compute_sink);
    rejects(send(&mut svm, &stranger, &[], vec![launch_init_ix(stranger.pubkey(), largs, line_mint, line_program)]), "Unauthorized");
    ok(send(&mut svm, &admin, &[], vec![launch_init_ix(admin.pubkey(), largs, line_mint, line_program)]));
    Env { svm, admin, core, runtime, line_mint, line_program, line_holder, compute_sink }
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

// ---------- launches (pump.fun) ----------

pub struct Launched {
    pub agent: Keypair,
    pub launcher: Keypair,
    pub launcher_line: Pubkey,
    pub mint: Pubkey,
    pub launch: Pubkey,
    pub bonding_curve: Pubkey,
    pub compute_vault: Pubkey,
    pub pump_creator: Pubkey,
    /// The creator PDA's `$LINE` ATA, where pump.fun's collects pay.
    pub creator_line_token: Pubkey,
}
pub fn pump_creator(agent: &Pubkey) -> Pubkey {
    lpda(&[ll::PUMP_CREATOR_SEED, agent.as_ref()])
}
pub fn default_launch_args() -> ll::PumpLaunchArgs {
    ll::PumpLaunchArgs { repo_url: "https://github.com/lineage-test/base58".into(), identity_mode: ll::IDENTITY_APP, hosted: true }
}
/// How a test's `create_v2` differs from an honest launch (attack tests).
#[derive(Clone, Copy, Default)]
pub struct CreateShape {
    pub creator: Option<Pubkey>,
    pub quote: Option<Pubkey>,
    pub creator_fee_bps: u64,
    pub holder_reward: bool,
}
impl Env {
    pub fn create_ix(&self, launcher: &Pubkey, agent: &Pubkey, mint: &Pubkey, shape: CreateShape) -> Instruction {
        let quote = shape.quote.unwrap_or(self.line_mint);
        let q = if quote == pf::WSOL { pf::Quote::Sol } else { pf::Quote::Coin { mint: quote, pool: None } };
        pf::create_v2_ix(mint, launcher, &shape.creator.unwrap_or(pump_creator(agent)), "Base58 Agent", "B58A", &q, false, shape.creator_fee_bps,
            shape.holder_reward)
    }
    pub fn register_launch_ix(&self, launcher: &Pubkey, agent: &Pubkey, mint: &Pubkey, args: ll::PumpLaunchArgs) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::RegisterPumpLaunch {
                launch_config: launch_config(), authority: launch_authority(), launcher: *launcher, agent: *agent, agent_mint: *mint,
                line_mint: self.line_mint, bonding_curve: pf::curve_of(mint), pump_global: pf::GLOBAL, pump_creator: pump_creator(agent),
                agent_launch: agent_launch(mint), compute_vault: compute_vault(agent), registry_config: registry_config(), agent_record: agent_record(agent),
                registry_program: lr::ID, instructions: anchor_lang::solana_program::sysvar::instructions::ID, line_token_program: self.line_program,
                system_program: system_program::ID,
            }.to_account_metas(None),
            data: ll::instruction::RegisterPumpLaunch { args }.data(),
        }
    }
    /// The launch transaction: compute budget, `create_v2` at the top level, `register_pump_launch`.
    /// Its wire size is proven on the mainnet fork as v0 (scripts/mainnet); here it is sent without
    /// the legacy packet assert.
    pub fn try_launch(&mut self, launcher: &Keypair, agent: &Keypair, mint: &Keypair, args: ll::PumpLaunchArgs) -> TransactionResult {
        let ixs = vec![cu(600_000), self.create_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), CreateShape::default()),
            self.register_launch_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), args)];
        send_unchecked(&mut self.svm, launcher, &[agent, mint], ixs)
    }
    pub fn launch_agent(&mut self, agent: Keypair, args: ll::PumpLaunchArgs) -> Launched {
        let (launcher, launcher_line) = self.wallet(0);
        let mint = Keypair::new();
        ok(self.try_launch(&launcher, &agent, &mint, args));
        self.launched(agent, launcher, launcher_line, mint.pubkey())
    }
    pub fn launched(&mut self, agent: Keypair, launcher: Keypair, launcher_line: Pubkey, m: Pubkey) -> Launched {
        let pc = pump_creator(&agent.pubkey());
        Launched {
            launch: agent_launch(&m),
            compute_vault: compute_vault(&agent.pubkey()),
            bonding_curve: pf::curve_of(&m),
            creator_line_token: ata(&pc, &self.line_mint, &self.line_program),
            pump_creator: pc,
            agent,
            launcher,
            launcher_line,
            mint: m,
        }
    }
    pub fn crank_ix(&self, l: &Launched) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::CrankPumpFees {
                launch_config: launch_config(), agent_launch: l.launch, pump_creator: l.pump_creator, creator_line_token: l.creator_line_token,
                compute_vault: l.compute_vault, treasury: treasury(), line_mint: self.line_mint, line_token_program: self.line_program,
            }.to_account_metas(None),
            data: ll::instruction::CrankPumpFees {}.data(),
        }
    }
    /// A keeper's crank: pump.fun's sweep + collect (and the pool's after migration), then `crank_pump_fees`.
    pub fn crank_fees(&mut self, l: &Launched) -> TransactionResult {
        let k = funded(&mut self.svm);
        let line = self.line_mint;
        let mut ixs = vec![cu(600_000), create_ata_ix(&k.pubkey(), &l.pump_creator, &line, &self.line_program),
            pf::sweep_creator_fee_ix(&k.pubkey(), &l.mint, &line, &l.pump_creator), pf::collect_creator_fee_v2_ix(&l.pump_creator, &line)];
        let pool = pf::pool_of(&l.mint, &line);
        if self.svm.get_account(&pool).is_some() {
            ixs.extend(pf::amm_sweep_and_collect_ixs(&k.pubkey(), &pool, &line, &l.pump_creator));
        }
        ixs.push(self.crank_ix(l));
        send(&mut self.svm, &k, &[], ixs)
    }
    /// A trader with `line` of `$LINE`, an agent-token ATA, and the buyback recipient's `$LINE` ATA in place.
    pub fn trader(&mut self, l: &Launched, line: u64) -> (Keypair, Pubkey, Pubkey) {
        let (k, la) = self.wallet(line);
        let admin = self.admin.insecure_clone();
        let aa = ata_for(&mut self.svm, &admin, &k.pubkey(), &l.mint);
        (k, la, aa)
    }
    /// Buys exactly `amount` agent tokens on the curve with `$LINE` (`buy_v3`).
    pub fn curve_buy(&mut self, l: &Launched, trader: &Keypair, amount: u64) -> TransactionResult {
        let cap = pf::buy_cap(&self.svm, &l.mint, amount);
        let ix = pf::buy_v3_ix(&l.mint, &self.line_mint, &self.line_program, &trader.pubkey(), amount, cap);
        send(&mut self.svm, trader, &[], vec![cu(400_000), ix])
    }
    pub fn curve_sell(&mut self, l: &Launched, trader: &Keypair, amount: u64) -> TransactionResult {
        let ix = pf::sell_v3_ix(&l.mint, &self.line_mint, &self.line_program, &trader.pubkey(), amount, 1);
        send(&mut self.svm, trader, &[], vec![cu(400_000), ix])
    }
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
