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
import { SBox, SPair } from '@fleet-sdk/serializer';
import type { Amount, EIP12UnsignedTransaction } from '@fleet-sdk/common';
import {
  COLLECTION_OFFER_ADDRESS,
  NETWORK,
  NETWORK_PREFIX,
  OFFER_ADDRESS,
  SALE_ADDRESS,
} from './contract';
import { merkleProof } from './merkle';
import { minimumPrice, royaltyOf, royaltyOn, sellerReceives, type Royalty } from './royalties';

/** A box in the shape fleet wants: registers as raw hex, amounts as string or
 *  bigint (the wallet hands back strings, mock-chain hands back bigints). */
export type FleetBox = Box<Amount>;

export const FEE = RECOMMENDED_MIN_FEE_VALUE;
export const LISTING_BOX_VALUE = SAFE_MIN_BOX_VALUE;
/** What the holder funds when accepting a bid: delivery box plus miner fee. */
export const OFFER_SETTLEMENT_COST = SAFE_MIN_BOX_VALUE + FEE;
/** Smallest bid whose acceptance leaves the holder with a positive net. */
export const MIN_OFFER_VALUE = OFFER_SETTLEMENT_COST + 1n;

/**
 * The floor every bid must clear, royalty included.
 *
 * All three collections charge 5%, so a bid below 0.02 ERG produces a creator's
 * share too small to fund its own output — and the contracts require that
 * output. Such a bid can be funded and locked and then accepted by nobody.
 *
 * Applied uniformly rather than per token: a collection bid does not know which
 * piece will settle it, so it cannot look the rate up, and a floor that differs
 * between the two kinds of bid is a floor someone will route around.
 */
export const MIN_ROYALTY_BID = 20_000_000n;

/**
 * What the holder actually walks away with from a bid.
 *
 * Three things come off the headline figure: the delivery box's minimum value,
 * the miner fee, and the creator's share — which the offer contracts now
 * require, on the same terms a sale does. Quoting the bid itself overstates the
 * proceeds every time.
 *
 * The royalty output is a box of its own, but it costs nothing extra: its value
 * IS the creator's share, which already clears the minimum a box must hold. An
 * earlier version subtracted a second minimum on top and understated the
 * holder's proceeds by exactly that — caught by asserting the quote against
 * what the chain actually paid, rather than against the formula itself.
 */
export const offerNet = (amount: bigint, royalty: Royalty | null = null): bigint =>
  amount - OFFER_SETTLEMENT_COST - royaltyOn(amount, royalty);

function assertPositiveOfferNet(offerBox: FleetBox, royalty: Royalty | null = null): void {
  let amount: bigint;
  try {
    amount = BigInt(offerBox.value);
  } catch {
    throw new Error('The offer box has an invalid value.');
  }
  // Checked against the true net rather than MIN_OFFER_VALUE: with a fee in
  // play a bid can clear the settlement cost and still leave the holder with
  // nothing, and that transaction must not reach the wallet.
  if (offerNet(amount, royalty) <= 0n) {
    throw new Error('This offer would leave the holder with no proceeds.');
  }
  // Checked again at acceptance, because a bid built outside this app is not
  // bound by the floor above — and a royalty too small to fund a box makes the
  // contract's check unsatisfiable no matter who assembles the transaction.
  const share = royaltyOn(amount, royalty);
  if (royalty && share < SAFE_MIN_BOX_VALUE) {
    throw new Error('This offer is too small for its royalty to be paid, so it cannot be accepted.');
  }
}

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
  /**
   * The token's issuer box — the box whose id IS the token id.
   *
   * Required, because the contract reads the royalty out of it and can prove
   * it is genuine by that identity. A listing without it cannot be bought by
   * anyone: the purchase branch needs R6 and refuses when it is absent.
   */
  issuerBox: FleetBox;
}): EIP12UnsignedTransaction {
  const { tokenId, price, sellerAddress, utxos, height, issuerBox } = params;
  if (price <= 0n) throw new Error('Price must be greater than zero.');

  if (issuerBox.boxId !== tokenId) {
    // The contract checks this too, but failing here costs nothing while
    // failing there costs a signature and a rejected transaction.
    throw new Error('That issuer box does not belong to this token.');
  }

  const royalty = royaltyOf(issuerBox);
  const floor = minimumPrice(royalty);
  if (price < floor) {
    // Below this the royalty rounds to less than a box can hold, so the
    // contract's royalty check can never be satisfied and the listing would be
    // created unbuyable.
    throw new Error(
      `At a ${royalty?.percent}% royalty the lowest workable price is ${floor} nanoERG.`,
    );
  }

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
          R6: SBox(issuerBox as Parameters<typeof SBox>[0]).toHex(),
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
  /** The token's issuer box, whose R4 sets the creator's share. */
  issuerBox: FleetBox;
}): EIP12UnsignedTransaction {
  const { listingBox, price, sellerAddress, buyerAddress, buyerUtxos, height, issuerBox } = params;

  // Split out of the price, not added to it.
  //
  // The buyer pays exactly what the listing advertises; the contract requires
  // the seller to receive the remainder and the creator their share, both
  // tagged with this listing's id so one payment cannot settle two listings.
  //
  // Rounding must match the contract's integer division exactly. Pay a nanoERG
  // less and the script rejects the transaction; pay more and it comes out of
  // the seller.
  const royalty = royaltyOf(issuerBox);

  // A seller who is also the creator is paid once, in full.
  //
  // Splitting into two outputs to the same script would build a transaction the
  // contract rejects: it requires a SINGLE output carrying the whole price in
  // that case, precisely so neither half can be counted twice.
  const samePayee =
    royalty !== null &&
    ErgoAddress.fromBase58(sellerAddress).ergoTree === royalty.propositionBytes;

  const creatorGets = samePayee ? 0n : royaltyOn(price, royalty);
  const sellerGets = samePayee ? price : sellerReceives(price, royalty);

  const tag = SColl(SByte, listingBox.boxId).toHex();
  const builder = new TransactionBuilder(height)
    .from([listingBox], { ensureInclusion: true })
    .from(buyerUtxos)
    .to(new OutputBuilder(sellerGets, sellerAddress).setAdditionalRegisters({ R4: tag }));

  if (creatorGets > 0n && royalty) {
    builder.to(
      new OutputBuilder(creatorGets, ErgoAddress.fromErgoTree(royalty.propositionBytes))
        .setAdditionalRegisters({ R4: tag }),
    );
  }

  return builder.sendChangeTo(buyerAddress).payFee(FEE).build().toEIP12Object();
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
  /** The token's issuer box; the contract reads the creator's share from it. */
  issuerBox: FleetBox;
}): EIP12UnsignedTransaction {
  const { tokenId, amount, bidderAddress, utxos, height, issuerBox } = params;
  if (issuerBox.boxId !== tokenId) {
    throw new Error('That issuer box does not belong to this token.');
  }
  // The same floor a listing has, for the same reason: below it the creator's
  // share cannot fund its own output, so the contract's royalty check can never
  // be satisfied and the bid would be funded, locked, and impossible to accept.
  const bidFloor = royaltyOf(issuerBox) ? MIN_ROYALTY_BID : MIN_OFFER_VALUE;
  if (amount < bidFloor) {
    throw new Error(`The lowest workable bid on this token is ${bidFloor} nanoERG.`);
  }
  if (amount < MIN_OFFER_VALUE) {
    throw new Error('An offer must cover the holder\'s settlement costs and leave positive proceeds.');
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
          R6: SBox(issuerBox as Parameters<typeof SBox>[0]).toHex(),
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
  /** The delivered token's issuer box. */
  issuerBox: FleetBox;
}): EIP12UnsignedTransaction {
  const {
    offerBox,
    tokenId,
    bidderAddress,
    holderAddress,
    holderUtxos,
    listingBox,
    height,
    issuerBox,
  } = params;
  const royalty = royaltyOf(issuerBox);
  assertPositiveOfferNet(offerBox, royalty);

  const tag = SColl(SByte, offerBox.boxId).toHex();
  const creatorGets = royaltyOn(BigInt(offerBox.value), royalty);

  const builder = new TransactionBuilder(height)
    .from(listingBox ? [offerBox, listingBox] : [offerBox], { ensureInclusion: true })
    .from(holderUtxos)
    .to(
      new OutputBuilder(SAFE_MIN_BOX_VALUE, bidderAddress)
        .addTokens({ tokenId, amount: 1n })
        .setAdditionalRegisters({ R4: tag }),
    );

  // A separate box, carrying no token — which is exactly how the contract tells
  // it apart from the delivery and refuses to count one output twice.
  if (creatorGets > 0n && royalty) {
    builder.to(
      new OutputBuilder(creatorGets, ErgoAddress.fromErgoTree(royalty.propositionBytes))
        .setAdditionalRegisters({ R4: tag }),
    );
  }

  return builder.sendChangeTo(holderAddress).payFee(FEE).build().toEIP12Object();
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
  // The same floor a specific bid has. A collection bid cannot look up the
  // rate — it does not know which piece will settle it — so it takes the floor
  // every supported collection implies.
  if (amount < MIN_ROYALTY_BID) {
    throw new Error(`The lowest workable collection bid is ${MIN_ROYALTY_BID} nanoERG.`);
  }
  if (amount < MIN_OFFER_VALUE) {
    throw new Error('An offer must cover the holder\'s settlement costs and leave positive proceeds.');
  }
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
  /** The delivered token's issuer box, proved by id inside the script. */
  issuerBox: FleetBox;
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
    issuerBox,
  } = params;
  const royalty = royaltyOf(issuerBox);
  assertPositiveOfferNet(offerBox, royalty);

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
    // Slot 2 is the issuer box. Which piece is delivered is not known when the
    // bid is made, so neither is which issuer box carries its royalty — the
    // acceptor supplies it, and the script proves it by id.
    2: SBox(issuerBox as Parameters<typeof SBox>[0]).toHex(),
  });

  const tag = SColl(SByte, offerBox.boxId).toHex();
  const creatorGets = royaltyOn(BigInt(offerBox.value), royalty);

  const builder = new TransactionBuilder(height)
    .from(listingBox ? [input, listingBox] : [input], { ensureInclusion: true })
    .from(holderUtxos)
    .to(
      new OutputBuilder(SAFE_MIN_BOX_VALUE, bidderAddress)
        .addTokens({ tokenId, amount: 1n })
        .setAdditionalRegisters({ R4: tag }),
    );

  if (creatorGets > 0n && royalty) {
    builder.to(
      new OutputBuilder(creatorGets, ErgoAddress.fromErgoTree(royalty.propositionBytes))
        .setAdditionalRegisters({ R4: tag }),
    );
  }

  return builder.sendChangeTo(holderAddress).payFee(FEE).build().toEIP12Object();
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
    return ErgoAddress.fromPublicKey(pk).toString(NETWORK_PREFIX[NETWORK]);
  } catch {
    return null;
  }
}
