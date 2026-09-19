# SETTLERS: the village coin as a real SPL token

2026-09-19 · agent-economy · branch `ys-version`

The village's money works, but it is a `u64` field. Nothing outside our own decoder can
see it: no mint, no supply to look up, no token for a wallet to hold. This makes the
coin real — one SPL mint whose supply is the village's money supply, created and
destroyed only by the bank's lending rules, enforced on-chain after every instruction.

## The identity this rests on

`lib.rs` already closes its books after every instruction. One of those lines is:

```
Σ agent cash + bank cash = start_money + bank_seed + minted − principal_repaid − written_off
```

The left side is `supply + bank.cash`: every coin in the village. The feature is one
more line in that block:

```
spl_supply = supply + bank.cash
```

Everything below serves that identity. Nothing else about the economy changes.

## Where coins are born and where they die

Coins are created in one place: `borrow` (`l.minted += amount`), plus the opening purses
at `initialize`.

They are destroyed in two helpers, which is less obvious:

- `credit_equity()` (`lib.rs:523`) — bank income that pays down `bad_debt` burns those
  coins and counts them in `written_off`.
- `write_off()` (`lib.rs:532`) — unpaid principal burned out of the bank's cash.

and `repay` / `liquidate` burn repaid principal directly (`l.principal_repaid += …`).

Because `clear_auction` calls `credit_equity` on foreclosure sales (`lib.rs:488`), **the
transaction that is already tightest on size can destroy coins.** That one fact shapes
§4.

The rule that falls out of the identity, and that the implementation uses directly:

> In any instruction, coins created = Δ`minted`, and coins destroyed =
> Δ(`principal_repaid` + `written_off`).

## 1. The mint

A PDA at seeds `["settlers", ledger]`, created by the program inside `initialize`.

- **Decimals 2.** Cash is already held in cents, so one token base unit is one cent.
  `mint.supply` compares directly against `l.supply` as raw `u64`s, with no scaling
  anywhere in Rust or JS.
- **Mint authority and freeze authority are the mint PDA itself.** It signs for itself
  with `invoke_signed`. No keypair for it exists, so no human — including us — can mint
  or freeze a SETTLER.
- Coins live in a vault token account, a PDA at seeds `["vault", ledger]`, `mint` = the
  SETTLERS mint, `owner` = the mint PDA. Also created by the program in `initialize`.

Deriving both from the ledger address means **the `Ledger` layout does not change.**
Storing a `mint: Pubkey` in the header instead would cost 32 bytes, push `MAX_AGENTS`
from 137 to 136, and shift the `bank` (288) and `slots` (360) offsets that
`chain.mjs.fetch()` decodes by hand. Not worth it.

## 2. The CPIs, hand-rolled

No `anchor-spl` dependency. It drags in `spl-token` and
`spl-associated-token-account` and can cost an hour of version resolution; the calls we
need are four short instruction buffers, and this codebase already hand-encodes
instructions in `chain.mjs` for the same kind of reason.

SPL Token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, checked by address on
every call:

| Call | Tag | Data | Accounts |
|---|---|---|---|
| `InitializeMint2` | 20 | `decimals u8`, `mint_authority [u8;32]`, `freeze_authority Option<[u8;32]>` | mint (w) |
| `InitializeAccount3` | 18 | `owner [u8;32]` | account (w), mint |
| `MintTo` | 7 | `amount u64` | mint (w), destination (w), authority (s) |
| `Burn` | 8 | `amount u64` | account (w), mint (w), authority (s) |

Signing seeds: `[b"settlers", ledger.key().as_ref(), &[bump]]`. Anchor computes and
validates the bump by declaring both PDAs with `seeds`/`bump` on `UncheckedAccount`s.

Account sizes as consts (82 for a mint, 165 for a token account), rent from
`Rent::get()?.minimum_balance(…)`, paid by `authority` in `initialize`. Measured against
the running validator: 0.00146 SOL for the mint, 0.00204 SOL for the vault.

Reading the supply back: bytes `36..44` of the mint account (the SPL mint layout is
`mint_authority COption<Pubkey>` 0..36, `supply u64` 36..44). Read it in its own scope —
never hold a `data.borrow()` across an `invoke_signed`.

## 3. Mint and burn without touching the economics

Each affected instruction gets a two-line prologue and a one-line epilogue. **No
existing economic logic is edited.**

```rust
// prologue, right after the ledger is loaded
let m0 = (l.minted, l.principal_repaid + l.written_off);

// … every line of the existing instruction, unchanged …

// epilogue, before Ok(())
settle_money(&ctx, &l, m0)?;
```

`settle_money` computes `minted − m0.0` and `destroyed − m0.1`, does a `MintTo` for the
first if non-zero and a `Burn` for the second if non-zero, then asserts §5. An
instruction never does both, but handling both costs nothing and removes a case to
reason about. It takes the three `AccountInfo`s and the bump rather than the `Context`,
because the calling instructions have different `Accounts` structs (see below):

```rust
fn settle_money(
    l: &Ledger,
    mint: &AccountInfo, vault: &AccountInfo, token_program: &AccountInfo,
    ledger_key: &Pubkey, bump: u8,
    m0: (u64, u64),
) -> Result<()>
```

This derives the token movement from the books rather than restating it, so the CPI
cannot drift from the economics: if a future change alters how a coin dies, the burn
follows automatically.

`initialize` is the exception — it mints `start_money + bank_seed` directly after
creating the two accounts.

### The accounts structs must be split

Today `Write` is shared by `borrow`, `repay`, `settle` and `clear_auction`, and `Anyone`
by `liquidate` and `pay_dividend`. Adding the mint accounts to `Write` would force every
chunked `settle` transaction to carry three accounts it has no use for, and would make
§4 impossible. So the structs are split, and each new one gets the same
`load_checked()` authority guard `Write` has:

| Struct | Accounts | Used by |
|---|---|---|
| `Initialize` | + mint (w), vault (w), token_program, and keeps `system_program` | `initialize` |
| `Write` | **unchanged** | `settle` |
| `WriteMint` | ledger (w), authority (s), mint (w), vault (w), token_program | `borrow`, `repay` |
| `ClearAuction` | ledger (w), authority (s), `Option<mint>` (w), `Option<vault>` (w), `Option<token_program>` | `clear_auction` |
| `Anyone` | **unchanged** | `pay_dividend` |
| `AnyoneMint` | ledger (w), caller (s), mint (w), vault (w), token_program | `liquidate` |

`liquidate` stays permissionless: the keeper signs it and already holds airdropped SOL
for fees. `settle` moves goods only. `pay_dividend` moves cash from `bank.cash` to
agents, which leaves `supply + bank.cash` unchanged. Neither can change the total, so
neither carries the mint.

Both PDAs are declared as `UncheckedAccount` with `seeds`/`bump` so Anchor validates the
addresses and hands over the bump; `token_program` is checked by address.

## 4. Keeping `clear_auction` out of it, except when it isn't

`clear_auction` destroys coins only when the bank fire-sells seized goods *and* has
`bad_debt` for `credit_equity` to pay down. Rare, but it happens, and a missed burn
breaks the identity permanently.

The mint, vault and token program are **optional accounts** on `clear_auction`,
required exactly when the asks contain a `BANK` order:

- `chain.mjs` builds the book, so it knows whether to attach them.
- The program checks: a `BANK` ask present with the accounts absent is an error
  (`MintAccountsRequired`). A missed burn is impossible, not merely unlikely.
- A normal auction carries no extra accounts and its transaction is byte-for-byte what
  it is today. The measured ceiling (1220 of 1232 bytes at 100 agents) is untouched.
- A foreclosure-sale auction carries three more accounts, about 99 bytes, which lowers
  the orders that fit in that one call from 96 to roughly 88. `MAX_ORDERS_PER_TX` in
  `chain.mjs` gets a second, lower constant used for bank-sale auctions.

## 5. The invariant

```rust
fn check_supply(l: &Ledger, mint: &AccountInfo) -> Result<()>
```

asserts `mint_supply == l.supply + l.bank.cash`, called at the end of `settle_money` in
every instruction that carries the mint. New error `SupplyMismatch`.

Added to:
- the doc-comment identity block at the top of `lib.rs`, as one more line
- `backend/scripts/analyze.mjs`, beside the eight identities already checked per round
- the headless end-of-run summary in `server.mjs`

Because the check runs inside the program, a wrong burn fails the *next* transaction
that touches the mint. The feature largely tests itself.

## Non-goals

- **A token account per agent.** ~30 extra transactions per round and balances that lag
  the ledger between sync passes; the invariant would hold only after a complete pass
  rather than at every instruction. Rent is not the obstacle (0.0612 SOL at 30 agents,
  free on localnet) — time and staleness are.
- **Token accounts as the money.** Settling a 30-agent uniform-price auction by CPI
  transfer needs ~30 token accounts in one transaction and does not fit in 1232 bytes.
  Splitting it would cost the auction its atomicity, which is the strongest property the
  program has. Revisit under Transaction V1 (4096 bytes, SIMD-0385).
- **Changing any economic rule.** Rates, terms, foreclosure, dividends: untouched.

## Token metadata — known limitation

Without a Metaplex token-metadata account, **no explorer or wallet will display the name
"SETTLERS"**; they show the bare mint address. `solana-test-validator` does not have the
Metaplex program unless it is cloned (`--clone metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
--url mainnet-beta`). On devnet it is already deployed.

Decision: ship the mint first and label it in the dashboard. Add real metadata only as
part of a devnet deploy, if the clock before Sunday 08:00 allows. This is stated here so
it is not discovered during a demo.

## Files

| File | Change |
|---|---|
| `chain/programs/chain/src/lib.rs` | PDAs, four SPL CPI helpers, `settle_money`, `check_supply`, prologue/epilogue in 5 instructions, 2 new errors, 3 new accounts structs, identity block. ~150 lines added, existing logic unedited. |
| `chain/programs/chain/Cargo.toml` | unchanged — no new dependencies |
| `chain/target/idl/chain.json` | regenerated by `anchor build`; `chain.mjs` reads discriminators from it. Discriminators do not change, but the account lists do. |
| `backend/src/chain.mjs` | derive both PDAs; attach 3 accounts to `initialize`/`borrow`/`repay`/`liquidate` and conditionally to `clear`; second `MAX_ORDERS_PER_TX` for bank-sale auctions; export `MINT`; read the mint supply in `fetch()` |
| `backend/src/server.mjs` | mint address and live SETTLERS supply in the state payload and the end-of-run summary |
| `backend/public/index.html` | mint address with an Explorer link; supply beside the existing money chart |
| `backend/scripts/analyze.mjs` | the new identity, per round |
| `CONTEXT.md` | §3 "What's on Solana" and its Gaps list (drop "No SPL token") |

## Testing

A script run against a validator on a **separate port**, not 8899, so the live dashboard
and its validator are untouched:

1. `initialize` — assert mint supply `== start_money + bank_seed`, decimals `== 2`,
   mint authority `== ` the mint PDA, freeze authority `== ` the mint PDA.
2. `borrow` — assert supply rose by exactly the amount lent.
3. `repay` in part, then in full — assert supply fell by principal only, not interest.
4. Force a foreclosure (`ltv` and a price move), let the keeper `liquidate` — assert
   supply fell by `burned + written_off`, and that it still matches with `bad_debt > 0`.
5. A `clear_auction` carrying a `BANK` ask — assert it succeeds with the accounts and
   fails with `MintAccountsRequired` without them.
6. `pay_dividend` — assert supply did not move.

Then a stub-brain run (no paid LLM calls) to confirm the identity holds round after
round in `analyze.mjs`.

## Estimate

2–3 hours. The risk is concentrated in `initialize` (two account creations by CPI); the
rest is a prologue, an epilogue, and three account keys.
