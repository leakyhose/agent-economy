//! Tests for the registry program, run against LiteSVM with the real compiled
//! SBF binary — the same bytes that get deployed. Build it first with
//!
//!     cargo build-sbf --manifest-path programs/registry/Cargo.toml
//!
//! The suite covers what the program actually promises: PDAs land where the
//! client says they will, an agent cannot be registered twice, reputation is
//! peer-attested, and only the recorded owner can move an asset.

use anchor_lang::{AccountDeserialize, Discriminator, InstructionData};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

use registry::{AgentIdentity, AssetRecord, AGENT_SEED, ASSET_SEED, LABEL_LEN};

const SO_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/registry.so");

fn program_id() -> Pubkey {
    registry::ID
}

// -------------------------------------------------------------- PDA helpers
// Deliberately hand-rolled rather than borrowed from the program, so the test
// fails if the program's seeds drift away from what a client would derive.

fn agent_pda(world: &Pubkey, index: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[AGENT_SEED, world.as_ref(), &index.to_le_bytes()],
        &program_id(),
    )
}

fn asset_pda(world: &Pubkey, asset_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[ASSET_SEED, world.as_ref(), &asset_id.to_le_bytes()],
        &program_id(),
    )
}

fn label(s: &str) -> [u8; LABEL_LEN] {
    let mut out = [0u8; LABEL_LEN];
    let bytes = s.as_bytes();
    assert!(bytes.len() <= LABEL_LEN, "label too long: {s}");
    out[..bytes.len()].copy_from_slice(bytes);
    out
}

// ------------------------------------------------------- instruction builders
// These encode instruction data exactly the way the TypeScript client does:
// 8-byte Anchor discriminator followed by Borsh-serialized arguments.

fn register_agent_ix(
    payer: &Pubkey,
    world: &Pubkey,
    index: u16,
    entity_type: [u8; LABEL_LEN],
    wallet: &Pubkey,
) -> Instruction {
    let args = registry::instruction::RegisterAgent {
        world: *world,
        index,
        entity_type,
        wallet: *wallet,
    };
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(agent_pda(world, index).0, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: args.data(),
    }
}

fn update_reputation_ix(
    agent: &Pubkey,
    attestor: &Pubkey,
    attestor_wallet: &Pubkey,
    delta: i32,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*agent, false),
            AccountMeta::new_readonly(*attestor, false),
            AccountMeta::new_readonly(*attestor_wallet, true),
        ],
        data: registry::instruction::UpdateReputation { delta }.data(),
    }
}

fn mint_asset_ix(
    payer: &Pubkey,
    world: &Pubkey,
    asset_id: u64,
    asset_class: [u8; LABEL_LEN],
    owner_identity: &Pubkey,
) -> Instruction {
    let args = registry::instruction::MintAsset { world: *world, asset_id, asset_class };
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(asset_pda(world, asset_id).0, false),
            AccountMeta::new_readonly(*owner_identity, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: args.data(),
    }
}

fn transfer_asset_ix(
    asset: &Pubkey,
    current_owner: &Pubkey,
    new_owner_identity: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*asset, false),
            AccountMeta::new_readonly(*current_owner, true),
            AccountMeta::new_readonly(*new_owner_identity, false),
        ],
        data: registry::instruction::TransferAsset {}.data(),
    }
}

// --------------------------------------------------------------- environment

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    world: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = std::fs::read(SO_PATH).unwrap_or_else(|e| {
            panic!(
                "missing {SO_PATH} ({e}). Run: cargo build-sbf --manifest-path programs/registry/Cargo.toml"
            )
        });
        svm.add_program(program_id(), &so).expect("load program");

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();

        // A world id is just an opaque 32-byte label; the host derives it from the
        // world file's name. Nothing in the program interprets it.
        let world = Pubkey::new_unique();
        Self { svm, payer, world }
    }

    fn fund(&mut self, key: &Pubkey) {
        self.svm.airdrop(key, 1_000_000_000).unwrap();
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let mut all: Vec<&Keypair> = vec![&self.payer];
        for s in signers {
            if s.pubkey() != self.payer.pubkey() {
                all.push(s);
            }
        }
        let blockhash = self.svm.latest_blockhash();
        let tx = Transaction::new(&all, msg, blockhash);
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    /// Register agent `index` with a fresh wallet; returns (identity pda, wallet).
    fn register(&mut self, index: u16, entity_type: &str) -> (Pubkey, Keypair) {
        let wallet = Keypair::new();
        self.fund(&wallet.pubkey());
        let payer = self.payer.pubkey();
        let world = self.world;
        let ix = register_agent_ix(&payer, &world, index, label(entity_type), &wallet.pubkey());
        self.send(&[ix], &[]).expect("register_agent should succeed");
        (agent_pda(&world, index).0, wallet)
    }

    fn identity(&self, pda: &Pubkey) -> AgentIdentity {
        let acc = self.svm.get_account(pda).expect("identity account missing");
        AgentIdentity::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn asset(&self, pda: &Pubkey) -> AssetRecord {
        let acc = self.svm.get_account(pda).expect("asset account missing");
        AssetRecord::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }
}

// --------------------------------------------------------------------- tests

#[test]
fn pdas_derive_from_documented_seeds() {
    // The client derives these seeds independently; if this ever changes, every
    // already-registered world becomes unreachable. Pin it down.
    let world = Pubkey::new_unique();
    let (expected_agent, _) = Pubkey::find_program_address(
        &[b"agent", world.as_ref(), &7u16.to_le_bytes()],
        &program_id(),
    );
    assert_eq!(agent_pda(&world, 7).0, expected_agent);

    let (expected_asset, _) = Pubkey::find_program_address(
        &[b"asset", world.as_ref(), &42u64.to_le_bytes()],
        &program_id(),
    );
    assert_eq!(asset_pda(&world, 42).0, expected_asset);

    // Different worlds, same index, different accounts. Two worlds never collide.
    let other = Pubkey::new_unique();
    assert_ne!(agent_pda(&world, 7).0, agent_pda(&other, 7).0);
    assert_ne!(agent_pda(&world, 7).0, agent_pda(&world, 8).0);
}

#[test]
fn register_agent_writes_the_identity_account() {
    let mut env = Env::new();
    let (pda, wallet) = env.register(3, "peasant");

    let id = env.identity(&pda);
    assert_eq!(id.world, env.world);
    assert_eq!(id.index, 3);
    assert_eq!(id.wallet, wallet.pubkey());
    // The label round-trips as opaque bytes; the program never parses it.
    assert_eq!(id.entity_type, label("peasant"));
    assert_eq!(id.reputation, 0);

    // The account is on chain at the address a client would compute, and carries
    // the program's account discriminator so explorers can type it.
    let acc = env.svm.get_account(&pda).unwrap();
    assert_eq!(acc.owner, program_id());
    assert_eq!(&acc.data[..8], AgentIdentity::DISCRIMINATOR);
}

#[test]
fn duplicate_registration_is_rejected() {
    let mut env = Env::new();
    env.register(5, "noble");

    let payer = env.payer.pubkey();
    let world = env.world;
    let other_wallet = Keypair::new();
    let ix = register_agent_ix(
        &payer,
        &world,
        5,
        label("noble"),
        &other_wallet.pubkey(),
    );
    let err = env
        .send(&[ix], &[])
        .expect_err("re-registering index 5 must fail");
    // Anchor's `init` fails because the PDA is already allocated.
    assert!(
        err.contains("already in use") || err.contains("Custom(0)"),
        "unexpected failure: {err}"
    );
}

#[test]
fn reputation_is_peer_attested() {
    let mut env = Env::new();
    let (subject, _subject_wallet) = env.register(0, "peasant");
    let (attestor, attestor_wallet) = env.register(1, "merchant");

    let ix = update_reputation_ix(&subject, &attestor, &attestor_wallet.pubkey(), 7);
    env.send(&[ix], &[&attestor_wallet]).expect("attested update should succeed");
    assert_eq!(env.identity(&subject).reputation, 7);

    // Negative deltas work too, and they accumulate.
    let ix = update_reputation_ix(&subject, &attestor, &attestor_wallet.pubkey(), -3);
    env.send(&[ix], &[&attestor_wallet]).unwrap();
    assert_eq!(env.identity(&subject).reputation, 4);
}

#[test]
fn an_agent_cannot_attest_to_itself() {
    let mut env = Env::new();
    let (subject, subject_wallet) = env.register(0, "peasant");

    let ix = update_reputation_ix(&subject, &subject, &subject_wallet.pubkey(), 100);
    let err = env
        .send(&[ix], &[&subject_wallet])
        .expect_err("self-attestation must fail");
    assert!(err.contains("Custom(6002)"), "unexpected failure: {err}");
    assert_eq!(env.identity(&subject).reputation, 0);
}

#[test]
fn reputation_requires_the_attestors_own_signature() {
    let mut env = Env::new();
    let (subject, _) = env.register(0, "peasant");
    let (attestor, _attestor_wallet) = env.register(1, "merchant");

    // An impostor signs, claiming to be the attestor's wallet.
    let impostor = Keypair::new();
    env.fund(&impostor.pubkey());
    let ix = update_reputation_ix(&subject, &attestor, &impostor.pubkey(), 50);
    let err = env
        .send(&[ix], &[&impostor])
        .expect_err("a non-wallet signer must fail");
    assert!(err.contains("Custom(6003)"), "unexpected failure: {err}");
    assert_eq!(env.identity(&subject).reputation, 0);
}

#[test]
fn mint_asset_vests_it_in_a_registered_agent() {
    let mut env = Env::new();
    let (owner_id, owner_wallet) = env.register(0, "noble");

    let payer = env.payer.pubkey();
    let world = env.world;
    let ix = mint_asset_ix(&payer, &world, 1001, label("land_parcel"), &owner_id);
    env.send(&[ix], &[]).expect("mint_asset should succeed");

    let rec = env.asset(&asset_pda(&world, 1001).0);
    assert_eq!(rec.asset_id, 1001);
    assert_eq!(rec.asset_class, label("land_parcel"));
    assert_eq!(rec.owner, owner_wallet.pubkey());
    assert_eq!(rec.transfers, 0);
}

#[test]
fn a_non_owner_cannot_transfer_an_asset() {
    let mut env = Env::new();
    let (alice_id, alice_wallet) = env.register(0, "peasant");
    let (bob_id, _bob_wallet) = env.register(1, "noble");
    let (_mallory_id, mallory_wallet) = env.register(2, "merchant");

    let payer = env.payer.pubkey();
    let world = env.world;
    env.send(
        &[mint_asset_ix(&payer, &world, 7, label("land_parcel"), &alice_id)],
        &[],
    )
    .unwrap();
    let asset = asset_pda(&world, 7).0;

    // Mallory is a perfectly valid, registered agent — and still cannot move
    // an asset she does not own.
    let err = env
        .send(
            &[transfer_asset_ix(&asset, &mallory_wallet.pubkey(), &bob_id)],
            &[&mallory_wallet],
        )
        .expect_err("a non-owner transfer must fail");
    assert!(err.contains("Custom(6001)"), "unexpected failure: {err}");

    // Nothing moved.
    let rec = env.asset(&asset);
    assert_eq!(rec.owner, alice_wallet.pubkey());
    assert_eq!(rec.transfers, 0);

    // The real owner can.
    env.send(
        &[transfer_asset_ix(&asset, &alice_wallet.pubkey(), &bob_id)],
        &[&alice_wallet],
    )
    .expect("owner transfer should succeed");
    let rec = env.asset(&asset);
    assert_eq!(rec.owner, env.identity(&bob_id).wallet);
    assert_eq!(rec.transfers, 1);
}

#[test]
fn transfer_requires_a_signature_not_just_a_named_owner() {
    let mut env = Env::new();
    let (alice_id, alice_wallet) = env.register(0, "peasant");
    let (bob_id, _) = env.register(1, "noble");

    let payer = env.payer.pubkey();
    let world = env.world;
    env.send(
        &[mint_asset_ix(&payer, &world, 9, label("land_parcel"), &alice_id)],
        &[],
    )
    .unwrap();
    let asset = asset_pda(&world, 9).0;

    // Name Alice as the owner account but never hand over her signature.
    let mut ix = transfer_asset_ix(&asset, &alice_wallet.pubkey(), &bob_id);
    ix.accounts[1].is_signer = false;
    let err = env
        .send(&[ix], &[])
        .expect_err("an unsigned owner must fail");
    assert!(
        err.contains("Signature") || err.contains("signer") || err.contains("Custom(3010)"),
        "unexpected failure: {err}"
    );
}

#[test]
fn assets_are_independent_of_the_worlds_vocabulary() {
    // The same code path serves an asset class no world file has ever declared.
    // Nothing in the program knows what "land" or "equity" means.
    let mut env = Env::new();
    let (owner_id, owner_wallet) = env.register(0, "zx_type_9");

    let payer = env.payer.pubkey();
    let world = env.world;
    env.send(
        &[mint_asset_ix(&payer, &world, u64::MAX, label("\u{1}\u{2}opaque"), &owner_id)],
        &[],
    )
    .unwrap();

    let rec = env.asset(&asset_pda(&world, u64::MAX).0);
    assert_eq!(rec.asset_class, label("\u{1}\u{2}opaque"));
    assert_eq!(rec.owner, owner_wallet.pubkey());
}

#[test]
fn many_registrations_fit_in_one_transaction() {
    // The client batches registrations; prove the program tolerates it, because
    // 27 sequential round trips is not a demo anyone wants to watch.
    let mut env = Env::new();
    let payer = env.payer.pubkey();
    let world = env.world;

    let wallets: Vec<Keypair> = (0..6).map(|_| Keypair::new()).collect();
    let ixs: Vec<Instruction> = wallets
        .iter()
        .enumerate()
        .map(|(i, w)| {
            register_agent_ix(&payer, &world, i as u16, label("person"), &w.pubkey())
        })
        .collect();
    env.send(&ixs, &[]).expect("batched registration should succeed");

    for (i, w) in wallets.iter().enumerate() {
        let id = env.identity(&agent_pda(&world, i as u16).0);
        assert_eq!(id.index, i as u16);
        assert_eq!(id.wallet, w.pubkey());
    }
}
