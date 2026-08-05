// transactions.ts — the three things a user can do, as unsigned transactions.
//
// Every function here returns an EIP-12 object for Nautilus to sign. Nothing in
// this file signs, submits, or holds a key: the app proposes, the wallet
// disposes. That is the entire custody story (docs/architecture.md §2), and it
// only holds as long as no signing helper ever lands here.
//
// The fee and the listing box's own ERG are real costs, not rounding. A seller
// funds SAFE_MIN_BOX_VALUE to open a listing and gets it back on cancel; a
// buyer sweeps it on purchase. Quoting a seller their "net" without accounting
// for it is how a marketplace ends up lying about proceeds by a whole fee.
//
// Spending a contract box needs `ensureInclusion`. `from()` is a POOL, not a
// list of inputs: fleet's selector takes the minimum that covers the outputs
// and drops the rest. Where the contract box is not needed to fund anything —
// accepting an offer, where the token comes from the acceptor's own wallet —
// it gets silently dropped, and the result is a valid transaction that hands
// the token over without touching the offer or its ERG. Caught by
// contracts/offer.test.ts before this shipped.

import {
  ErgoAddress,
  ErgoUnsignedInput,
  OutputBuilder,
  RECOMMENDED_MIN_FEE_VALUE,
  SAFE_MIN_BOX_VALUE,
  SBool,
  SByte,
  SColl,
  SGroupElement,
  SLong,
  SSigmaProp,
  TransactionBuilder,
  type Box,
} from '@fleet-sdk/core';
import { SPair } from '@fleet-sdk/serializer';
import type { Amount, EIP12UnsignedTransaction } from '@fleet-sdk/common';
import { COLLECTION_OFFER_ADDRESS, OFFER_ADDRESS, SALE_ADDRESS } from './contract';
import { merkleProof } from './merkle';

/** A box in the shape fleet wants: registers as raw hex, amounts as string or
 *  bigint (the wallet hands back strings, mock-chain hands back bigints). */
export type FleetBox = Box<Amount>;

export const FEE = RECOMMENDED_MIN_FEE_VALUE;
export const LISTING_BOX_VALUE = SAFE_MIN_BOX_VALUE;

/**
 * Open a listing: move the NFT into a box guarded by the sale script, carrying
 * the seller in R4 and the price in R5.
 *
 * The seller keeps no claim on the box beyond what the script grants — which is
 * everything, since the cancel branch is their signature alone.
 */
export function buildListTx(params: {
  tokenId: string;
  /** Asking price in nanoERG. */
  price: bigint;
  sellerAddress: string;
  /** The seller's spendable boxes, from ergo.get_utxos(). */
  utxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { tokenId, price, sellerAddress, utxos, height } = params;
  if (price <= 0n) throw new Error('Price must be greater than zero.');

  const seller = ErgoAddress.fromBase58(sellerAddress);
  const pk = seller.getPublicKeys()[0];
  if (!pk) {
    // A P2S seller has no single public key, so R4 could not identify them and
    // the cancel branch would be unprovable — the NFT would be locked forever.
    throw new Error('Listing requires a P2PK address (a normal wallet address).');
  }

  return new TransactionBuilder(height)
    .from(utxos)
    .to(
      new OutputBuilder(LISTING_BOX_VALUE, SALE_ADDRESS)
        .addTokens({ tokenId, amount: 1n })
        .setAdditionalRegisters({
          R4: SSigmaProp(SGroupElement(pk)).toHex(),
          R5: SLong(price).toHex(),
        }),
    )
    .sendChangeTo(seller)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/**
 * Buy: spend the listing and pay the seller in the same transaction.
 *
 * The payment output carries the listing's boxId in R4. That tag is what stops
 * one payment from settling several listings at once — see the contract and the
 * test named for that attack. Omitting it does not make a cheaper transaction;
 * it makes an invalid one.
 *
 * The NFT is not sent anywhere explicitly: it falls into change, which goes to
 * the buyer.
 */
export function buildBuyTx(params: {
  listingBox: FleetBox;
  /** Asking price in nanoERG, from the listing's R5. */
  price: bigint;
  sellerAddress: string;
  buyerAddress: string;
  buyerUtxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { listingBox, price, sellerAddress, buyerAddress, buyerUtxos, height } = params;

  return new TransactionBuilder(height)
    .from([listingBox], { ensureInclusion: true })
    .from(buyerUtxos)
    .to(
      new OutputBuilder(price, sellerAddress).setAdditionalRegisters({
        R4: SColl(SByte, listingBox.boxId).toHex(),
      }),
    )
    .sendChangeTo(buyerAddress)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/**
 * Cancel: take the listing back.
 *
 * No payment, no conditions — the script's first branch is the seller's
 * signature. The seller still needs a box of their own in the inputs to cover
 * the network fee, which is why `sellerUtxos` is required even though the
 * listing box holds ERG.
 */
export function buildCancelTx(params: {
  listingBox: FleetBox;
  sellerAddress: string;
  sellerUtxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { listingBox, sellerAddress, sellerUtxos, height } = params;

  return new TransactionBuilder(height)
    .from([listingBox], { ensureInclusion: true })
    .from(sellerUtxos)
    .sendChangeTo(sellerAddress)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

// ── Offers ────────────────────────────────────────────────────────────────
//
// The mirror of the three above: the bidder locks ERG and waits for a token
// instead of locking a token and waiting for ERG.

/**
 * Make an offer on a token, listed or not.
 *
 * The bid IS the box's ERG — offer.es has no price register, so an offer can
 * never promise more than it funded. Whatever goes in here is what an acceptor
 * collects.
 */
export function buildOfferTx(params: {
  tokenId: string;
  /** Bid in nanoERG. Locked until accepted or cancelled. */
  amount: bigint;
  bidderAddress: string;
  utxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { tokenId, amount, bidderAddress, utxos, height } = params;
  if (amount < SAFE_MIN_BOX_VALUE) {
    throw new Error('An offer must be at least 0.001 ERG.');
  }

  const bidder = ErgoAddress.fromBase58(bidderAddress);
  const pk = bidder.getPublicKeys()[0];
  if (!pk) throw new Error('Offers require a P2PK address (a normal wallet address).');

  return new TransactionBuilder(height)
    .from(utxos)
    .to(
      new OutputBuilder(amount, OFFER_ADDRESS).setAdditionalRegisters({
        R4: SSigmaProp(SGroupElement(pk)).toHex(),
        R5: SColl(SByte, tokenId).toHex(),
      }),
    )
    .sendChangeTo(bidder)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/**
 * Accept an offer: deliver the token to the bidder and take their ERG.
 *
 * The delivery output is funded at the protocol minimum, and the acceptor pays
 * the fee, so their net is the bid minus both. That is what the UI must quote —
 * showing the headline bid overstates the proceeds every time.
 */
export function buildAcceptOfferTx(params: {
  offerBox: FleetBox;
  tokenId: string;
  bidderAddress: string;
  /** The token holder, who receives the bid. */
  holderAddress: string;
  holderUtxos: FleetBox[];
  /**
   * The seller's own listing box, when the token being delivered is currently
   * listed rather than sitting in their wallet.
   *
   * Both contracts allow this in one transaction: sale.es cancels on the
   * seller's signature with no other condition, and offer.es only asks that the
   * token reach the bidder. So a seller can take a bid on a piece they have
   * listed without cancelling first and waiting a block — which is what they
   * would otherwise have to do, and what the UI silently prevented by hiding
   * the button.
   */
  listingBox?: FleetBox;
  height: number;
}): EIP12UnsignedTransaction {
  const { offerBox, tokenId, bidderAddress, holderAddress, holderUtxos, listingBox, height } =
    params;

  return new TransactionBuilder(height)
    .from(listingBox ? [offerBox, listingBox] : [offerBox], { ensureInclusion: true })
    .from(holderUtxos)
    .to(
      new OutputBuilder(SAFE_MIN_BOX_VALUE, bidderAddress)
        .addTokens({ tokenId, amount: 1n })
        .setAdditionalRegisters({
          R4: SColl(SByte, offerBox.boxId).toHex(),
        }),
    )
    .sendChangeTo(holderAddress)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** Withdraw an offer. The bidder's signature alone, same as cancelling a listing. */
export function buildCancelOfferTx(params: {
  offerBox: FleetBox;
  bidderAddress: string;
  bidderUtxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { offerBox, bidderAddress, bidderUtxos, height } = params;

  return new TransactionBuilder(height)
    .from([offerBox], { ensureInclusion: true })
    .from(bidderUtxos)
    .sendChangeTo(bidderAddress)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

// ── Collection offers ─────────────────────────────────────────────────────
//
// A bid on any piece from one collection. Ergo has no policy id, so membership
// is proven with a Merkle path against a root in R5 — see lib/merkle.ts.

/**
 * Open a collection-wide bid.
 *
 * Independent boxes, so several bids coexist naturally: three at 1 ERG and one
 * at 2 ERG are four boxes, each settled on its own, and a holder takes
 * whichever they prefer.
 */
export function buildCollectionOfferTx(params: {
  /** Merkle root of the collection, from COLLECTION_ROOTS. */
  root: string;
  amount: bigint;
  bidderAddress: string;
  utxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { root, amount, bidderAddress, utxos, height } = params;
  if (amount < SAFE_MIN_BOX_VALUE) throw new Error('An offer must be at least 0.001 ERG.');
  if (!/^[0-9a-f]{64}$/.test(root)) throw new Error('A collection root must be 32 bytes of hex.');

  const bidder = ErgoAddress.fromBase58(bidderAddress);
  const pk = bidder.getPublicKeys()[0];
  if (!pk) throw new Error('Offers require a P2PK address (a normal wallet address).');

  return new TransactionBuilder(height)
    .from(utxos)
    .to(
      new OutputBuilder(amount, COLLECTION_OFFER_ADDRESS).setAdditionalRegisters({
        R4: SSigmaProp(SGroupElement(pk)).toHex(),
        R5: SColl(SByte, root).toHex(),
      }),
    )
    .sendChangeTo(bidder)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/**
 * Accept a collection bid by delivering one qualifying token.
 *
 * The proof travels in the spending input's context extension, not in a
 * register: it is evidence supplied by the spender, not part of the offer. Slot
 * 0 is the token id, slot 1 the path — the order the script reads them in.
 */
export function buildAcceptCollectionOfferTx(params: {
  offerBox: FleetBox;
  tokenId: string;
  /** Every token id in the collection, to derive the path from. */
  collectionTokenIds: string[];
  bidderAddress: string;
  holderAddress: string;
  holderUtxos: FleetBox[];
  /** The seller's listing box, when the piece being delivered is listed. */
  listingBox?: FleetBox;
  height: number;
}): EIP12UnsignedTransaction {
  const {
    offerBox,
    tokenId,
    collectionTokenIds,
    bidderAddress,
    holderAddress,
    holderUtxos,
    listingBox,
    height,
  } = params;

  const path = merkleProof(collectionTokenIds, tokenId);
  if (!path) {
    // Refused here rather than signed and rejected: a token outside the tree
    // has no path that lands on the root, so the node would throw the
    // transaction out after the user had already approved it.
    throw new Error('That token is not part of the collection this offer covers.');
  }

  // The proof rides in the spending input's context extension rather than in a
  // register: it is evidence the spender supplies, not part of the offer. Slots
  // 0 and 1 are the order collection-offer.es reads them in — getVar(0) is the
  // token, getVar(1) the path — and a mismatch here fails every honest accept.
  const input = new ErgoUnsignedInput(offerBox).setContextExtension({
    0: SColl(SByte, tokenId).toHex(),
    1: SColl(
      SPair(SColl(SByte), SBool),
      path.map((step) => [step.sibling, step.siblingIsLeft] as [Uint8Array, boolean]),
    ).toHex(),
  });

  return new TransactionBuilder(height)
    .from(listingBox ? [input, listingBox] : [input], { ensureInclusion: true })
    .from(holderUtxos)
    .to(
      new OutputBuilder(SAFE_MIN_BOX_VALUE, bidderAddress)
        .addTokens({ tokenId, amount: 1n })
        .setAdditionalRegisters({ R4: SColl(SByte, offerBox.boxId).toHex() }),
    )
    .sendChangeTo(holderAddress)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** Withdraw a collection bid. The bidder's signature alone. */
export function buildCancelCollectionOfferTx(params: {
  offerBox: FleetBox;
  bidderAddress: string;
  bidderUtxos: FleetBox[];
  height: number;
}): EIP12UnsignedTransaction {
  const { offerBox, bidderAddress, bidderUtxos, height } = params;
  return new TransactionBuilder(height)
    .from([offerBox], { ensureInclusion: true })
    .from(bidderUtxos)
    .sendChangeTo(bidderAddress)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

/** The Merkle root a collection bid names, from its R5. */
export function collectionRootFrom(serializedR5: string): string | null {
  if (!serializedR5?.startsWith('0e20')) return null;
  const root = serializedR5.slice(4);
  return /^[0-9a-f]{64}$/.test(root) ? root : null;
}

/** The token id an offer is for, from its R5 — a Coll[Byte], prefixed `0e20`. */
export function offerTokenIdFrom(serializedR5: string): string | null {
  if (!serializedR5?.startsWith('0e20')) return null;
  const id = serializedR5.slice(4);
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/**
 * The address behind a listing's R4.
 *
 * R4 holds a SigmaProp, serialized as `08cd` followed by the 33-byte public
 * key. The explorer's `renderedValue` for it is not an address, so the payment
 * output cannot be built from that field directly — decode the key and rebuild
 * the address, or the buy transaction pays a string that is not a seller.
 */
export function sellerAddressFrom(serializedR4: string): string | null {
  if (!serializedR4?.startsWith('08cd')) return null;
  const pk = serializedR4.slice(4);
  if (pk.length !== 66) return null;
  try {
    return ErgoAddress.fromPublicKey(pk).toString();
  } catch {
    return null;
  }
}
