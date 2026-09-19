/**
 * `EscrowService` against the `org` program — brief §16, §17.
 *
 * Two agents agreeing to trade is the one place a simulation most wants to cheat:
 * credit one side, debit the other, hope nothing fails in between. On chain there
 * is no in-between. {@link SolanaEscrowService.create} locks the maker's side in a
 * vault owned by a program address, and {@link SolanaEscrowService.accept} moves
 * both legs inside a single instruction. If the taker cannot pay, the release never
 * runs; if the release fails, the payment unwinds with the transaction.
 *
 * The offer is open rather than addressed: the escrow records the terms, not a
 * counterparty. Anyone who meets the terms may take it, and the `to` argument of
 * `create` is kept here as the maker's intent for the simulation's benefit. What
 * the chain guarantees is atomicity and price, which is what makes the trade safe.
 */

import { randomBytes } from 'node:crypto';
import type { EntityId, EscrowService, ResourceId } from '@aw/types';
import { PublicKey } from '@solana/web3.js';
import { fromMinorUnits, toMinorUnits } from './treasury.ts';
import {
  acceptEscrowIx,
  associatedTokenAddress,
  cancelEscrowIx,
  createEscrowIx,
  decodeEscrow,
  escrowPda,
  vaultPda,
  type EscrowAccount,
  type OrgContext,
} from './org-program.ts';

/** An open offer, in world terms rather than chain terms. */
export interface OpenOffer {
  id: string;
  maker: EntityId;
  /** Who the maker meant it for, if they said. Not enforced on chain. */
  intendedFor?: EntityId;
  give: { resource: ResourceId; amount: number };
  want: { resource: ResourceId; amount: number };
}

export class SolanaEscrowService implements EscrowService {
  readonly #ctx: OrgContext;
  /** Which world resource each mint stands for, built from the mint registry. */
  readonly #resources = new Map<string, ResourceId>();
  /** The terms as the maker stated them, keyed by escrow address. */
  readonly #offers = new Map<string, OpenOffer>();
  /** Signatures this service produced, so a caller can cite the real transaction. */
  readonly signatures = new Map<string, string>();

  constructor(ctx: OrgContext, resources: readonly ResourceId[]) {
    this.#ctx = ctx;
    for (const resource of resources) {
      this.#resources.set(ctx.mints.mintFor(resource).toBase58(), resource);
    }
  }

  /**
   * Lock up the maker's side and publish the terms.
   *
   * Returns the escrow's account address, which is the id `accept` and `cancel`
   * take. The signature that created it is in {@link signatures}.
   */
  async create(
    from: EntityId,
    to: EntityId,
    give: { resource: ResourceId; amount: number },
    want: { resource: ResourceId; amount: number },
  ): Promise<string> {
    const ctx = this.#ctx;
    const maker = await ctx.keyring.signerFor(from);
    const giveMint = ctx.mints.mintFor(give.resource);
    const wantMint = ctx.mints.mintFor(want.resource);
    if (giveMint.equals(wantMint)) {
      throw new Error(`an escrow that swaps "${give.resource}" for itself does nothing`);
    }

    // A per-maker nonce. Random rather than sequential: two escrows opened in the
    // same tick must not collide on a PDA, and nothing here is allowed to block on
    // reading the chain to find out what the last one was.
    const escrowId = randomBytes(8).readBigUInt64LE() & 0x7fff_ffff_ffff_ffffn;
    const escrow = escrowPda(maker.publicKey, escrowId, ctx.programId);

    const ix = createEscrowIx({
      programId: ctx.programId,
      maker: maker.publicKey,
      escrowId,
      giveMint,
      wantMint,
      makerGiveAccount: associatedTokenAddress(maker.publicKey, giveMint),
      giveAmount: toMinorUnits(give.amount, ctx.mints.decimalsFor(give.resource)),
      wantAmount: toMinorUnits(want.amount, ctx.mints.decimalsFor(want.resource)),
    });
    const signature = await ctx.send([ix], [ctx.authority, maker]);

    const id = escrow.toBase58();
    this.signatures.set(id, signature);
    this.#offers.set(id, { id, maker: from, intendedFor: to, give, want });
    return id;
  }

  /**
   * Take the other side. One instruction, both legs.
   *
   * Every account here is derived, not supplied: the maker comes from the escrow
   * record, and each token account is the associated account of a party for a mint
   * the escrow named. A taker cannot point the payment somewhere convenient.
   */
  async accept(escrowId: string, by: EntityId): Promise<string> {
    const ctx = this.#ctx;
    const escrow = new PublicKey(escrowId);
    const account = await this.#decode(escrow);
    const taker = await ctx.keyring.signerFor(by);

    const ix = acceptEscrowIx({
      programId: ctx.programId,
      taker: taker.publicKey,
      escrow,
      maker: account.maker,
      vault: account.vault,
      takerPaymentAccount: associatedTokenAddress(taker.publicKey, account.wantMint),
      makerReceiveAccount: associatedTokenAddress(account.maker, account.wantMint),
      takerReceiveAccount: associatedTokenAddress(taker.publicKey, account.giveMint),
    });

    const signature = await ctx.send([ix], [ctx.authority, taker]);
    this.signatures.set(escrowId, signature);
    return signature;
  }

  /**
   * Withdraw the offer. Maker only — and the chain says so too, so a cancel signed
   * by anybody else fails whatever this method thinks.
   */
  async cancel(escrowId: string, by: EntityId): Promise<string> {
    const ctx = this.#ctx;
    const escrow = new PublicKey(escrowId);
    const account = await this.#decode(escrow);
    const caller = await ctx.keyring.signerFor(by);
    if (!account.maker.equals(caller.publicKey)) {
      throw new Error(`"${by}" did not make escrow ${escrowId} and cannot cancel it`);
    }

    const ix = cancelEscrowIx({
      programId: ctx.programId,
      maker: caller.publicKey,
      escrow,
      vault: account.vault,
      makerGiveAccount: associatedTokenAddress(caller.publicKey, account.giveMint),
    });
    const signature = await ctx.send([ix], [ctx.authority, caller]);
    this.signatures.set(escrowId, signature);
    return signature;
  }

  // ------------------------------------------------------------ beyond the port

  /** The escrow's vault address, for anyone who wants to watch the locked tokens. */
  vaultOf(escrowId: string): PublicKey {
    return vaultPda(new PublicKey(escrowId), this.#ctx.programId);
  }

  /** The terms as the chain holds them, translated back into world resources. */
  async terms(escrowId: string): Promise<OpenOffer | null> {
    const data = await this.#ctx.getAccount(new PublicKey(escrowId));
    if (!data) return null;
    const account = decodeEscrow(data);
    const give = this.#resourceOf(account.giveMint);
    const want = this.#resourceOf(account.wantMint);
    const stated = this.#offers.get(escrowId);
    const offer: OpenOffer = {
      id: escrowId,
      maker: this.#ctx.keyring.entityFor(account.maker) ?? account.maker.toBase58(),
      give: {
        resource: give,
        amount: fromMinorUnits(account.giveAmount, this.#ctx.mints.decimalsFor(give)),
      },
      want: {
        resource: want,
        amount: fromMinorUnits(account.wantAmount, this.#ctx.mints.decimalsFor(want)),
      },
    };
    if (stated?.intendedFor !== undefined) offer.intendedFor = stated.intendedFor;
    return offer;
  }

  /** Offers this service opened that are still on chain. */
  async outstanding(): Promise<OpenOffer[]> {
    const live: OpenOffer[] = [];
    for (const id of this.#offers.keys()) {
      const terms = await this.terms(id);
      if (terms) live.push(terms);
    }
    return live;
  }

  // ------------------------------------------------------------ internals

  async #decode(escrow: PublicKey): Promise<EscrowAccount> {
    const data = await this.#ctx.getAccount(escrow);
    if (!data) throw new Error(`no escrow at ${escrow.toBase58()}`);
    return decodeEscrow(data);
  }

  #resourceOf(mint: PublicKey): ResourceId {
    const resource = this.#resources.get(mint.toBase58());
    if (!resource) throw new Error(`mint ${mint.toBase58()} is not a world resource`);
    return resource;
  }
}
