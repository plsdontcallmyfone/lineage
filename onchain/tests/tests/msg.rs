//! lineage_msg (SPEC 12.5): messages signed by the agent's current registry signing key, emitted as
//! self-CPI events (no account per message), per-agent rate limits from an admin-editable config,
//! pause, sizes that keep the longest message in one 1,232-byte transaction, and a direct message
//! sealed by packages/core seal.ts posted through the program and opened again in TypeScript
//! (tests/fixtures/msg-seal.json in, tests/fixtures/msg-events.json out; packages/chain msg.test.ts).
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use lineage_msg as lm;
use lineage_onchain_tests::*;
use litesvm::types::TransactionMetadata;
use serde_json::{json, Value};

const LINEAGE: [u8; 32] = [7u8; 32];

fn test_args(admin: &Pubkey) -> lm::MsgConfigArgs {
    lm::MsgConfigArgs { admin: *admin, paused: false, window_s: 60, max_per_window: 20, max_per_day: 500, max_inline: lm::MAX_INLINE as u16, max_blob: 1 << 20 }
}

fn msg_config() -> Pubkey {
    pda_of(&[lm::MSG_CONFIG_SEED], &lm::ID)
}
fn msg_state(agent: &Pubkey) -> Pubkey {
    pda_of(&[lm::MSG_STATE_SEED, agent.as_ref()], &lm::ID)
}
fn event_authority() -> Pubkey {
    pda_of(&[b"__event_authority"], &lm::ID)
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

struct M {
    e: Env,
    /// the hosted runtime: pays every fee
    payer: Keypair,
}

impl M {
    fn new() -> M {
        let mut e = setup(LineKind::Classic);
        e.svm.add_program_from_file(lm::ID, manifest("../target/deploy/lineage_msg.so")).expect("build lineage_msg first (cargo build-sbf)");
        install_program_data(&mut e.svm, &lm::ID, &e.admin.pubkey());
        let admin = e.admin.insecure_clone();
        // only the upgrade authority initializes
        let stranger = funded(&mut e.svm);
        rejects(send(&mut e.svm, &stranger, &[], vec![init_ix(&stranger.pubkey(), test_args(&stranger.pubkey()))]), "Unauthorized");
        ok(send(&mut e.svm, &admin, &[], vec![init_ix(&admin.pubkey(), test_args(&admin.pubkey()))]));
        let payer = funded(&mut e.svm);
        M { e, payer }
    }
    /// A registered verifier: (owner, agent key).
    fn agent(&mut self, seed: u8) -> (Keypair, Keypair) {
        let (owner, _) = self.e.wallet_with(seeded(seed), 20_000 * ONE);
        let agent = seeded(seed + 100);
        self.e.register_verifier(&owner, &agent);
        (owner, agent)
    }
    fn set(&mut self, args: lm::MsgConfigArgs) -> Result<TransactionMetadata, String> {
        let admin = self.e.admin.insecure_clone();
        send(&mut self.e.svm, &admin, &[], vec![set_ix(&admin.pubkey(), args)]).map_err(|e| format!("{:?}", e.meta.logs))
    }
    fn post(&mut self, signer: &Keypair, ix: Instruction) -> litesvm::types::TransactionResult {
        let payer = self.payer.insecure_clone();
        send(&mut self.e.svm, &payer, &[signer], vec![ix])
    }
    fn state(&self, agent: &Pubkey) -> lm::AgentMsgState {
        read(&self.e.svm, &msg_state(agent))
    }
}

fn init_ix(signer: &Pubkey, args: lm::MsgConfigArgs) -> Instruction {
    let program_data = pda_of(&[lm::ID.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID);
    Instruction {
        program_id: lm::ID,
        accounts: lm::accounts::Initialize { config: msg_config(), upgrade_authority: *signer, program_data, system_program: anchor_lang::system_program::ID }
            .to_account_metas(None),
        data: lm::instruction::Initialize { args }.data(),
    }
}
fn set_ix(admin: &Pubkey, args: lm::MsgConfigArgs) -> Instruction {
    Instruction { program_id: lm::ID, accounts: lm::accounts::AdminOnly { config: msg_config(), admin: *admin }.to_account_metas(None), data: lm::instruction::SetConfig { args }.data() }
}
fn post_accounts(payer: &Pubkey, signer: &Pubkey, agent: &Pubkey) -> Vec<AccountMeta> {
    lm::accounts::Post {
        payer: *payer,
        signer: *signer,
        registry_agent: agent_record(agent),
        config: msg_config(),
        state: msg_state(agent),
        system_program: anchor_lang::system_program::ID,
        event_authority: event_authority(),
        program: lm::ID,
    }
    .to_account_metas(None)
}
fn board_ix(payer: &Pubkey, signer: &Pubkey, agent: &Pubkey, args: lm::BoardArgs) -> Instruction {
    Instruction { program_id: lm::ID, accounts: post_accounts(payer, signer, agent), data: lm::instruction::PostBoard { args }.data() }
}
fn key_ix(payer: &Pubkey, signer: &Pubkey, agent: &Pubkey, enc_key: [u8; 32]) -> Instruction {
    Instruction { program_id: lm::ID, accounts: post_accounts(payer, signer, agent), data: lm::instruction::PublishEncKey { enc_key }.data() }
}
fn dm_ix(payer: &Pubkey, signer: &Pubkey, agent: &Pubkey, args: lm::DmArgs) -> Instruction {
    Instruction {
        program_id: lm::ID,
        accounts: lm::accounts::PostDm {
            payer: *payer,
            signer: *signer,
            registry_agent: agent_record(agent),
            config: msg_config(),
            state: msg_state(agent),
            recipient_state: msg_state(&args.recipient),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: lm::ID,
        }
        .to_account_metas(None),
        data: lm::instruction::PostDm { args }.data(),
    }
}
fn note(text: &str) -> lm::BoardArgs {
    lm::BoardArgs { lineage: LINEAGE, kind: 0, reply_to: None, msg_ref: None, body: lm::Body::Inline(text.as_bytes().to_vec()) }
}

/// Every lineage_msg event of a transaction, from its self-CPI inner instructions (tag, discriminator, borsh).
fn events(meta: &TransactionMetadata) -> Vec<Vec<u8>> {
    let tag = anchor_lang::event::EVENT_IX_TAG_LE;
    meta.inner_instructions
        .iter()
        .flatten()
        .filter(|i| i.instruction.data.starts_with(tag))
        .map(|i| i.instruction.data[8..].to_vec())
        .collect()
}
fn decode<T: AnchorDeserialize + Discriminator>(ev: &[u8]) -> T {
    assert_eq!(&ev[..8], T::DISCRIMINATOR, "event discriminator");
    T::try_from_slice(&ev[8..]).unwrap()
}

#[test]
fn signer_must_be_the_current_registry_signing_key() {
    let mut m = M::new();
    let (owner, agent) = m.agent(1);
    let payer = m.payer.pubkey();
    let a = agent.pubkey();
    // The agent key (the signing key until a rotation) posts; the runtime pays.
    let meta = ok(m.post(&agent, board_ix(&payer, &a, &a, note("first note"))));
    let ev: lm::BoardPosted = decode(&events(&meta)[0]);
    assert_eq!((ev.agent, ev.signer, ev.seq, ev.lineage, ev.at), (a, a, 1, LINEAGE, NOW));
    assert_eq!(ev.body, lm::Body::Inline(b"first note".to_vec()));
    // No account per message: only the agent's state exists, at its fixed size.
    assert_eq!(m.e.svm.get_account(&msg_state(&a)).unwrap().data.len(), 8 + <lm::AgentMsgState as anchor_lang::Space>::INIT_SPACE);
    assert_eq!(m.state(&a).seq, 1);
    // The owner is not the signing key.
    m.e.svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
    rejects(m.post(&owner, board_ix(&payer, &owner.pubkey(), &a, note("owner"))), "NotSigningKey");
    // Another agent's key cannot speak for this agent.
    let (_, other) = m.agent(2);
    rejects(m.post(&other, board_ix(&payer, &other.pubkey(), &a, note("impostor"))), "NotSigningKey");
    // A forged registry record (right layout, wrong owner program) is refused.
    let mut fake = m.e.svm.get_account(&agent_record(&a)).unwrap();
    fake.owner = lm::ID;
    let fake_addr = Pubkey::new_unique();
    m.e.svm.set_account(fake_addr, fake).unwrap();
    let mut ix = board_ix(&payer, &a, &a, note("forged"));
    ix.accounts[2] = AccountMeta::new_readonly(fake_addr, false);
    rejects(m.post(&agent, ix), "AccountOwnedByWrongProgram");
    // Rotation (owner and new key): the old key is refused, the new key speaks.
    let new_key = seeded(50);
    let ix = m.e.rotate_agent_key_ix(&owner.pubkey(), &a, &new_key.pubkey());
    ok(send(&mut m.e.svm, &owner, &[&new_key], vec![ix]));
    rejects(m.post(&agent, board_ix(&payer, &a, &a, note("old key"))), "NotSigningKey");
    let meta = ok(m.post(&new_key, board_ix(&payer, &new_key.pubkey(), &a, note("new key"))));
    let ev: lm::BoardPosted = decode(&events(&meta)[0]);
    assert_eq!((ev.agent, ev.signer, ev.seq), (a, new_key.pubkey(), 2));
    // Revoked: nobody speaks for the agent until the owner rotates again.
    let ix = m.e.owner_agent_ix(&owner.pubkey(), &a, lr::instruction::RevokeAgentKey {}.data());
    ok(send(&mut m.e.svm, &owner, &[], vec![ix]));
    rejects(m.post(&new_key, board_ix(&payer, &new_key.pubkey(), &a, note("revoked"))), "KeyRevoked");
    rejects(m.post(&new_key, key_ix(&payer, &new_key.pubkey(), &a, [9u8; 32])), "KeyRevoked");
    // A self-hosted agent pays its own fee (payer and signer the same key).
    let (_, c) = m.agent(3);
    m.e.svm.airdrop(&c.pubkey(), 1_000_000_000).unwrap();
    ok(send(&mut m.e.svm, &c, &[], vec![board_ix(&c.pubkey(), &c.pubkey(), &c.pubkey(), note("self paid"))]));
}

#[test]
fn events_cannot_be_forged_from_outside() {
    let mut m = M::new();
    let (_, agent) = m.agent(1);
    // A top-level call to the event entry point with a made-up event: the event authority cannot sign.
    let ev = lm::BoardPosted { agent: agent.pubkey(), signer: agent.pubkey(), seq: 99, lineage: LINEAGE, kind: 0, reply_to: None, msg_ref: None,
        body: lm::Body::Inline(b"forged".to_vec()), at: NOW };
    let mut data = anchor_lang::event::EVENT_IX_TAG_LE.to_vec();
    data.extend_from_slice(&anchor_lang::Event::data(&ev));
    let ix = Instruction { program_id: lm::ID, accounts: vec![AccountMeta::new_readonly(event_authority(), false)], data };
    let payer = m.payer.insecure_clone();
    assert!(send(&mut m.e.svm, &payer, &[], vec![ix]).is_err());
}

#[test]
fn rate_limits_pause_and_config() {
    let mut m = M::new();
    let (_, agent) = m.agent(1);
    let (p, a) = (m.payer.pubkey(), agent.pubkey());
    let admin = m.e.admin.pubkey();
    let mut args = lm::MsgConfigArgs { max_per_window: 3, max_per_day: 5, ..test_args(&admin) };
    m.set(args).unwrap();
    // Align to the start of a window so the four posts share one.
    let t = now(&m.e.svm);
    warp(&mut m.e.svm, 60 - t.rem_euclid(60));
    for i in 0..3 {
        ok(m.post(&agent, board_ix(&p, &a, &a, note(&format!("n{i}")))));
    }
    rejects(m.post(&agent, board_ix(&p, &a, &a, note("n3"))), "RateLimited");
    // Key publications count too (they are events).
    rejects(m.post(&agent, key_ix(&p, &a, &a, [9u8; 32])), "RateLimited");
    warp(&mut m.e.svm, 60);
    ok(m.post(&agent, board_ix(&p, &a, &a, note("n4"))));
    ok(m.post(&agent, board_ix(&p, &a, &a, note("n5"))));
    warp(&mut m.e.svm, 60);
    rejects(m.post(&agent, board_ix(&p, &a, &a, note("n6"))), "DailyLimit");
    // A new day resets the day count.
    let t = now(&m.e.svm);
    warp(&mut m.e.svm, 86_400 - t.rem_euclid(86_400));
    ok(m.post(&agent, board_ix(&p, &a, &a, note("n7"))));
    assert_eq!(m.state(&a).seq, 6);
    // Another agent has its own counters.
    let (_, b) = m.agent(2);
    ok(m.post(&b, board_ix(&p, &b.pubkey(), &b.pubkey(), note("b0"))));
    // Pause stops every post; unpause restores.
    args.paused = true;
    m.set(args).unwrap();
    rejects(m.post(&agent, board_ix(&p, &a, &a, note("paused"))), "Paused");
    rejects(m.post(&agent, key_ix(&p, &a, &a, [9u8; 32])), "Paused");
    args.paused = false;
    m.set(args).unwrap();
    ok(m.post(&agent, board_ix(&p, &a, &a, note("resumed"))));
    // Admin only; validated; the admin can hand over.
    let stranger = funded(&mut m.e.svm);
    rejects(send(&mut m.e.svm, &stranger, &[], vec![set_ix(&stranger.pubkey(), args)]), "Unauthorized");
    assert!(m.set(lm::MsgConfigArgs { max_inline: lm::MAX_INLINE as u16 + 1, ..args }).is_err());
    assert!(m.set(lm::MsgConfigArgs { window_s: 0, ..args }).is_err());
    assert!(m.set(lm::MsgConfigArgs { admin: Pubkey::default(), ..args }).is_err());
    assert!(m.set(lm::MsgConfigArgs { max_inline: 48, ..args }).is_err());
    m.set(lm::MsgConfigArgs { admin: stranger.pubkey(), ..args }).unwrap();
    ok(send(&mut m.e.svm, &stranger, &[], vec![set_ix(&stranger.pubkey(), lm::MsgConfigArgs { admin: stranger.pubkey(), max_per_window: 0, ..args })]));
    rejects(m.post(&agent, board_ix(&p, &a, &a, note("cap 0"))), "RateLimited");
    let c: lm::MsgConfig = read(&m.e.svm, &msg_config());
    assert_eq!((c.admin, c.max_per_window), (stranger.pubkey(), 0));
}

#[test]
fn bodies_references_and_sizes() {
    let mut m = M::new();
    let (_, agent) = m.agent(1);
    let (p, a) = (m.payer.pubkey(), agent.pubkey());
    let max = lm::MAX_INLINE;
    let text = |n: usize| "x".repeat(n);
    ok(m.post(&agent, board_ix(&p, &a, &a, note(&text(max)))));
    rejects(m.post(&agent, board_ix(&p, &a, &a, note(&text(max + 1)))), "TooLarge");
    rejects(m.post(&agent, board_ix(&p, &a, &a, note(""))), "EmptyBody");
    let bad_utf8 = lm::BoardArgs { body: lm::Body::Inline(vec![0xff, 0xfe, 0x41]), ..note("") };
    rejects(m.post(&agent, board_ix(&p, &a, &a, bad_utf8)), "NotUtf8");
    rejects(m.post(&agent, board_ix(&p, &a, &a, lm::BoardArgs { lineage: [0u8; 32], ..note("no lineage") })), "BadLineage");
    for r in [lm::MsgRef { kind: 0, id: [1u8; 32] }, lm::MsgRef { kind: 6, id: [1u8; 32] }, lm::MsgRef { kind: lm::REF_INTENT, id: [0u8; 32] }] {
        rejects(m.post(&agent, board_ix(&p, &a, &a, lm::BoardArgs { msg_ref: Some(r), ..note("ref") })), "BadRef");
    }
    // A smaller admin cap applies below the constant.
    let admin = m.e.admin.pubkey();
    m.set(lm::MsgConfigArgs { max_inline: 100, ..test_args(&admin) }).unwrap();
    rejects(m.post(&agent, board_ix(&p, &a, &a, note(&text(101)))), "TooLarge");
    m.set(test_args(&admin)).unwrap();
    // Long bodies: a hash and size of the offchain blob.
    let blob = |sha256: [u8; 32], size: u32| lm::BoardArgs { body: lm::Body::Blob { sha256, size }, ..note("") };
    let meta = ok(m.post(&agent, board_ix(&p, &a, &a, lm::BoardArgs { reply_to: Some([3u8; 32]), msg_ref: Some(lm::MsgRef { kind: lm::REF_GENERATION, id: [4u8; 32] }), ..blob([5u8; 32], 100_000) })));
    let ev: lm::BoardPosted = decode(&events(&meta)[0]);
    assert_eq!((ev.body, ev.reply_to, ev.msg_ref.map(|r| r.kind)), (lm::Body::Blob { sha256: [5u8; 32], size: 100_000 }, Some([3u8; 32]), Some(lm::REF_GENERATION)));
    rejects(m.post(&agent, board_ix(&p, &a, &a, blob([5u8; 32], (1 << 20) + 1))), "TooLarge");
    rejects(m.post(&agent, board_ix(&p, &a, &a, blob([0u8; 32], 10))), "BadBlob");
    rejects(m.post(&agent, board_ix(&p, &a, &a, blob([5u8; 32], 0))), "BadBlob");
}

/// The longest accepted message: a direct message with an inline body of `MAX_INLINE` sealed bytes,
/// a reply and a reference, both compute budget instructions, a separate fee payer and the
/// sender's state created in the same transaction, is at most 1,232 bytes, and one byte more would
/// not fit.
#[test]
fn longest_message_fits_one_transaction() {
    let mut m = M::new();
    let (_, a) = m.agent(1);
    let (_, b) = m.agent(2);
    let p = m.payer.pubkey();
    ok(m.post(&b, key_ix(&p, &b.pubkey(), &b.pubkey(), [9u8; 32])));
    let dm = |n: usize| lm::DmArgs {
        recipient: b.pubkey(),
        enc_key: [9u8; 32],
        kind: 255,
        reply_to: Some([1u8; 32]),
        msg_ref: Some(lm::MsgRef { kind: lm::REF_INTENT, id: [2u8; 32] }),
        body: lm::Body::Inline(vec![0xab; n]),
    };
    let price = solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_price(1);
    let ixs = |n: usize| vec![cu(60_000), price.clone(), dm_ix(&p, &a.pubkey(), &a.pubkey(), dm(n))];
    let size = tx_size(&m.payer, &[&a], &ixs(lm::MAX_INLINE));
    let over = tx_size(&m.payer, &[&a], &ixs(lm::MAX_INLINE + 1));
    println!("longest message transaction: {size} bytes (one more body byte: {over})");
    assert!(size <= 1232 && over > 1232, "MAX_INLINE must be the largest body that fits: {size} / {over}");
    // And it lands, creating the sender's state in the same transaction.
    assert!(m.e.svm.get_account(&msg_state(&a.pubkey())).is_none());
    let payer = m.payer.insecure_clone();
    let meta = ok(send(&mut m.e.svm, &payer, &[&a], ixs(lm::MAX_INLINE)));
    println!("post_dm compute units (longest, state created): {}", meta.compute_units_consumed);
    assert!(m.e.svm.get_account(&msg_state(&a.pubkey())).is_some());
}

#[test]
fn sealed_dm_round_trip_with_the_typescript_seal() {
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(manifest("fixtures/msg-seal.json")).unwrap()).unwrap();
    let sealed = hex(fx["sealed_hex"].as_str().unwrap());
    let rec_key: [u8; 32] = hex(fx["recipient_enc_key_hex"].as_str().unwrap()).try_into().unwrap();
    let mut m = M::new();
    let (_, a) = m.agent(1);
    let (_, b) = m.agent(2);
    let p = m.payer.pubkey();
    let dm = |key: [u8; 32], body: Vec<u8>| lm::DmArgs {
        recipient: b.pubkey(), enc_key: key, kind: 0, reply_to: None, msg_ref: None, body: lm::Body::Inline(body),
    };
    // No published key: the recipient's state does not exist yet.
    rejects(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), dm(rec_key, sealed.clone()))), "AccountNotInitialized");
    // B publishes its X25519 key (an event and its state).
    let meta = ok(m.post(&b, key_ix(&p, &b.pubkey(), &b.pubkey(), rec_key)));
    let kev: lm::EncKeyPublished = decode(&events(&meta)[0]);
    assert_eq!((kev.agent, kev.enc_key, kev.key_seq), (b.pubkey(), rec_key, 1));
    assert_eq!(m.state(&b.pubkey()).enc_key, rec_key);
    // A sends the TypeScript-sealed bytes.
    let meta = ok(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), dm(rec_key, sealed.clone()))));
    let raw = events(&meta);
    assert_eq!(raw.len(), 1);
    let ev: lm::DmPosted = decode(&raw[0]);
    assert_eq!((ev.agent, ev.recipient, ev.enc_key, ev.seq), (a.pubkey(), b.pubkey(), rec_key, 1));
    assert_eq!(ev.body, lm::Body::Inline(sealed.clone()));
    // Refusals: a stale key, an unsealed body, to oneself, to an agent without state.
    rejects(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), dm([8u8; 32], sealed.clone()))), "StaleEncryptionKey");
    rejects(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), dm(rec_key, vec![1u8; 48]))), "NotSealed");
    ok(m.post(&a, key_ix(&p, &a.pubkey(), &a.pubkey(), [6u8; 32])));
    let self_dm = lm::DmArgs { recipient: a.pubkey(), ..dm([6u8; 32], sealed.clone()) };
    rejects(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), self_dm)), "SelfMessage");
    // B rotates its encryption key: the old one is stale.
    ok(m.post(&b, key_ix(&p, &b.pubkey(), &b.pubkey(), [7u8; 32])));
    assert_eq!(m.state(&b.pubkey()).enc_key_seq, 2);
    rejects(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), dm(rec_key, sealed.clone()))), "StaleEncryptionKey");
    // A blob-referenced DM (long sealed body kept offchain).
    let long = lm::DmArgs { body: lm::Body::Blob { sha256: [1u8; 32], size: 5000 }, ..dm([7u8; 32], vec![]) };
    ok(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), long)));
    rejects(m.post(&a, dm_ix(&p, &a.pubkey(), &a.pubkey(), lm::DmArgs { body: lm::Body::Blob { sha256: [1u8; 32], size: 48 }, ..dm([7u8; 32], vec![]) })), "BadBlob");

    // The emitted event bytes, for packages/chain msg.test.ts (decode, then open with seal.ts).
    let path = manifest("fixtures/msg-events.json");
    let doc = json!({
        "_note": "Generated by onchain/tests/tests/msg.rs (UPDATE_VECTORS=1); read by packages/chain test/msg.test.ts.",
        "program": lm::ID.to_string(),
        "sender": a.pubkey().to_string(),
        "recipient": b.pubkey().to_string(),
        "enc_key_published": to_hex(&ok_key_meta(&kev)),
        "dm_posted": to_hex(&raw[0]),
        "inner_ix_data_dm": to_hex(&[anchor_lang::event::EVENT_IX_TAG_LE, &raw[0][..]].concat()),
        "instructions": instruction_vectors(),
    });
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        return;
    }
    let committed: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("run with UPDATE_VECTORS=1 once")).unwrap();
    assert_eq!(committed, doc, "msg events changed: rerun with UPDATE_VECTORS=1 and the packages/chain tests");
}

fn ix_json(name: &str, ix: &Instruction) -> Value {
    json!({
        "name": name,
        "program": ix.program_id.to_string(),
        "keys": ix.accounts.iter().map(|k| json!([k.pubkey.to_string(), k.is_signer, k.is_writable])).collect::<Vec<_>>(),
        "data": to_hex(&ix.data),
    })
}

/// Instruction encodings with fixed keys (seeded 1..4) for the packages/chain builders.
fn instruction_vectors() -> Vec<Value> {
    let (payer, signer, agent, rec, admin) = (seeded(1).pubkey(), seeded(2).pubkey(), seeded(3).pubkey(), seeded(4).pubkey(), seeded(5).pubkey());
    let args = lm::MsgConfigArgs { admin, paused: true, window_s: 60, max_per_window: 20, max_per_day: 500, max_inline: 568, max_blob: 1 << 20 };
    let board = lm::BoardArgs { lineage: [7u8; 32], kind: 3, reply_to: Some([1u8; 32]), msg_ref: Some(lm::MsgRef { kind: lm::REF_CANDIDATE, id: [2u8; 32] }),
        body: lm::Body::Inline(b"hello board".to_vec()) };
    let blob = lm::BoardArgs { lineage: [7u8; 32], kind: 0, reply_to: None, msg_ref: None, body: lm::Body::Blob { sha256: [9u8; 32], size: 70_000 } };
    let dm = lm::DmArgs { recipient: rec, enc_key: [6u8; 32], kind: 0, reply_to: None, msg_ref: Some(lm::MsgRef { kind: lm::REF_BOUNTY, id: rec.to_bytes() }),
        body: lm::Body::Inline(vec![0xab; 60]) };
    vec![
        ix_json("initialize", &init_ix(&admin, args)),
        ix_json("set_config", &set_ix(&admin, args)),
        ix_json("post_board", &board_ix(&payer, &signer, &agent, board)),
        ix_json("post_board_blob", &board_ix(&payer, &signer, &agent, blob)),
        ix_json("post_dm", &dm_ix(&payer, &signer, &agent, dm)),
        ix_json("publish_enc_key", &key_ix(&payer, &signer, &agent, [6u8; 32])),
    ]
}

/// The EncKeyPublished event bytes rebuilt from the decoded event (same bytes the program emitted).
fn ok_key_meta(ev: &lm::EncKeyPublished) -> Vec<u8> {
    anchor_lang::Event::data(ev)
}
