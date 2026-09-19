# Solana programs

Three Anchor programs: `world` (ledger, uniform-price batch auction,
permissionless liquidation), `registry` (agent identity and asset ownership
PDAs) and `org` (treasury, governance, escrow).

## Program keypairs are not in this repository

Each program's on-chain address is derived from a keypair that Anchor generates
on first build. Those keypairs are deliberately untracked — they are localnet
throwaways with no funds, but a repository that contains no key material at all
needs nobody to judge which kind they were.

The consequence: **program ids are per-machine.** After a fresh clone, generate
them and sync the ids before deploying.

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
anchor build                     # generates target/deploy/<program>-keypair.json
anchor keys list                 # prints the resulting program ids
anchor keys sync                 # rewrites declare_id! and Anchor.toml to match
anchor build                     # rebuild so the binary carries the new id
```

`anchor keys sync` updates `declare_id!` in each `src/lib.rs` and the
`[programs.localnet]` table in `Anchor.toml`. The ids committed here were
generated on one machine and will not match yours.

## Running against a local validator

Public devnet is rate limited to roughly 100 requests per 10 seconds, which a
few dozen agents exhaust immediately, and airdrops fail under load. Use a local
validator:

```sh
solana-test-validator --limit-ledger-size 50000000
anchor deploy
```

The simulation detects the validator automatically; `npm run dev` reports
whether it found one.

## SBPF version

The validator has SIMD-0500 active and refuses v0/v1/v2 programs, while
`cargo build-sbf` still defaults to v0. Build deployable artifacts with
`--arch v3`.
