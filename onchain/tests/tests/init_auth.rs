//! Front-running the one-time initializers (docs/audit/THREAT-MODEL.md, REVIEW-AREAS.md item 8):
//! `lineage_registry::initialize`, `lineage_launch::initialize_launch` and `lineage_msg::initialize`
//! are gated on the upgrade authority read from the program's ProgramData. For each program, on a
//! fresh state: another signer is refused with the real ProgramData; another signer is refused when
//! it passes a ProgramData that does name it (another program's, at the wrong address); nothing is
//! created by either attempt; the upgrade authority then initializes with itself as admin; and a
//! second initialize by anyone fails because the config account exists (and the config is unchanged).
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{system_program, InstructionData, ToAccountMetas};
use lineage_msg as lm;
use lineage_onchain_tests::*;

struct Fresh {
    svm: LiteSVM,
    admin: Keypair,
    stranger: Keypair,
    line_mint: Pubkey,
    line_program: Pubkey,
}

/// Programs loaded, ProgramData of all three naming `admin`, nothing initialized.
fn fresh() -> Fresh {
    let mut svm = fresh_svm();
    svm.add_program_from_file(lm::ID, manifest("../target/deploy/lineage_msg.so")).expect("build lineage_msg first (cargo build-sbf)");
    let admin = funded(&mut svm);
    let stranger = funded(&mut svm);
    let (line_mint, _) = create_line(&mut svm, &admin, LineKind::Classic);
    let line_program = program_of(&svm, &line_mint);
    for p in [lr::ID, ll::ID, lm::ID] {
        install_program_data(&mut svm, &p, &admin.pubkey());
    }
    Fresh { svm, admin, stranger, line_mint, line_program }
}

fn program_data_of(program: &Pubkey) -> Pubkey {
    pda_of(&[program.as_ref()], &bpf_loader_upgradeable::ID)
}

/// The same instruction with its ProgramData account swapped for `other`.
fn with_program_data(mut ix: Instruction, program: &Pubkey, other: Pubkey) -> Instruction {
    let want = program_data_of(program);
    let meta = ix.accounts.iter_mut().find(|m| m.pubkey == want).expect("instruction has the ProgramData account");
    meta.pubkey = other;
    ix
}

/// A stand-in program id whose ProgramData names the stranger: the "ProgramData that does name me"
/// an attacker would pass.
fn decoy_program_data(svm: &mut LiteSVM, stranger: &Pubkey) -> Pubkey {
    install_program_data(svm, &Pubkey::new_unique(), stranger)
}

fn msg_args(admin: &Pubkey) -> lm::MsgConfigArgs {
    lm::MsgConfigArgs { admin: *admin, paused: false, window_s: 60, max_per_window: 20, max_per_day: 500, max_inline: lm::MAX_INLINE as u16, max_blob: 1 << 20 }
}
fn msg_config() -> Pubkey {
    pda_of(&[lm::MSG_CONFIG_SEED], &lm::ID)
}
fn msg_init_ix(signer: Pubkey, args: lm::MsgConfigArgs) -> Instruction {
    Instruction {
        program_id: lm::ID,
        accounts: lm::accounts::Initialize { config: msg_config(), upgrade_authority: signer, program_data: program_data_of(&lm::ID), system_program: system_program::ID }
            .to_account_metas(None),
        data: lm::instruction::Initialize { args }.data(),
    }
}

#[test]
fn registry_initialize_only_by_upgrade_authority() {
    let Fresh { mut svm, admin, stranger, line_mint, line_program } = fresh();
    let core = Keypair::new();
    // The stranger names itself admin and Core authority.
    let theirs = config_args(&stranger.pubkey(), &stranger.pubkey());
    let ix = registry_init_ix(stranger.pubkey(), theirs, line_mint, line_program);
    rejects(send(&mut svm, &stranger, &[], vec![ix.clone()]), "Unauthorized");
    let decoy = decoy_program_data(&mut svm, &stranger.pubkey());
    rejects(send(&mut svm, &stranger, &[], vec![with_program_data(ix, &lr::ID, decoy)]), "ConstraintSeeds");
    assert!(svm.get_account(&registry_config()).is_none(), "no config after the refused attempts");
    assert!(svm.get_account(&bond_vault()).is_none(), "no vault after the refused attempts");

    ok(send(&mut svm, &admin, &[], vec![registry_init_ix(admin.pubkey(), config_args(&admin.pubkey(), &core.pubkey()), line_mint, line_program)]));
    let c: lr::Config = read(&svm, &registry_config());
    assert_eq!(c.admin, admin.pubkey());
    assert_eq!(c.core_authority, core.pubkey());
    // Once only: a later initialize (stranger or admin) cannot overwrite it (the config account exists,
    // so `init` fails before the authority constraint is reached).
    rejects(send(&mut svm, &stranger, &[], vec![registry_init_ix(stranger.pubkey(), theirs, line_mint, line_program)]), "already in use");
    rejects(send(&mut svm, &admin, &[], vec![registry_init_ix(admin.pubkey(), theirs, line_mint, line_program)]), "already in use");
    let c: lr::Config = read(&svm, &registry_config());
    assert_eq!(c.admin, admin.pubkey());
}

#[test]
fn launch_initialize_only_by_upgrade_authority() {
    let Fresh { mut svm, admin, stranger, line_mint, line_program } = fresh();
    let sink = ata_for(&mut svm, &admin, &stranger.pubkey(), &line_mint);
    // The stranger names itself admin, runtime authority and compute sink owner.
    let theirs = launch_args(&stranger.pubkey(), &stranger.pubkey(), &sink);
    let ix = launch_init_ix(stranger.pubkey(), theirs, line_mint, line_program);
    rejects(send(&mut svm, &stranger, &[], vec![ix.clone()]), "Unauthorized");
    let decoy = decoy_program_data(&mut svm, &stranger.pubkey());
    rejects(send(&mut svm, &stranger, &[], vec![with_program_data(ix, &ll::ID, decoy)]), "ConstraintSeeds");
    assert!(svm.get_account(&launch_config()).is_none(), "no launch config after the refused attempts");

    let runtime = Keypair::new();
    let admin_sink = ata_for(&mut svm, &admin, &runtime.pubkey(), &line_mint);
    let ours = launch_args(&admin.pubkey(), &runtime.pubkey(), &admin_sink);
    ok(send(&mut svm, &admin, &[], vec![launch_init_ix(admin.pubkey(), ours, line_mint, line_program)]));
    let c: ll::LaunchConfig = read(&svm, &launch_config());
    assert_eq!(c.admin, admin.pubkey());
    assert_eq!(c.runtime_authority, runtime.pubkey());
    rejects(send(&mut svm, &stranger, &[], vec![launch_init_ix(stranger.pubkey(), theirs, line_mint, line_program)]), "already in use");
    rejects(send(&mut svm, &admin, &[], vec![launch_init_ix(admin.pubkey(), theirs, line_mint, line_program)]), "already in use");
    let c: ll::LaunchConfig = read(&svm, &launch_config());
    assert_eq!(c.admin, admin.pubkey());
}

#[test]
fn msg_initialize_only_by_upgrade_authority() {
    let Fresh { mut svm, admin, stranger, .. } = fresh();
    let ix = msg_init_ix(stranger.pubkey(), msg_args(&stranger.pubkey()));
    rejects(send(&mut svm, &stranger, &[], vec![ix.clone()]), "Unauthorized");
    let decoy = decoy_program_data(&mut svm, &stranger.pubkey());
    rejects(send(&mut svm, &stranger, &[], vec![with_program_data(ix, &lm::ID, decoy)]), "ConstraintSeeds");
    assert!(svm.get_account(&msg_config()).is_none(), "no msg config after the refused attempts");

    ok(send(&mut svm, &admin, &[], vec![msg_init_ix(admin.pubkey(), msg_args(&admin.pubkey()))]));
    let c: lm::MsgConfig = read(&svm, &msg_config());
    assert_eq!(c.admin, admin.pubkey());
    rejects(send(&mut svm, &stranger, &[], vec![msg_init_ix(stranger.pubkey(), msg_args(&stranger.pubkey()))]), "already in use");
    rejects(send(&mut svm, &admin, &[], vec![msg_init_ix(admin.pubkey(), msg_args(&stranger.pubkey()))]), "already in use");
    let c: lm::MsgConfig = read(&svm, &msg_config());
    assert_eq!(c.admin, admin.pubkey());
}
