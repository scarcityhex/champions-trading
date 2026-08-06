// history.ts — reading settled trades out of raw transactions.
//
// Kept as a pure function, separate from the script that fetches, for two
// reasons: it can be tested without a network, and it is the one piece where a
// mistake writes a permanent wrong number into the history file. A sale
// recorded at the wrong price is worse than no history at all, because it looks
// authoritative.
//
// Every field here is derivable from the chain, so the file this produces is a
// cache with a long memory — never a source of truth (docs/history-and-storage.md).

import { sellerAddressFrom, offerTokenIdFrom, collectionRootFrom } from './transactions';
import { COLLECTION_ROOTS } from './contract';
import { BY_TOKEN_ID, COLLECTIONS } from './collections';

/**
 * The miner fee address.
 *
 * Every transaction has one, it is an ordinary output like any other, and it
 * must never be mistaken for a counterparty. Derived rather than pasted so it
 * follows the network the app is built for.
 */

export type Trade = {
  txId: string;
  /** The contract box that was spent to settle this trade. Unique per trade:
   *  a box can only be spent once, which is what makes re-indexing an
   *  overlapping range idempotent instead of double-counting. */
  boxId: string;
  tokenId: string;
  /** nanoERG, as a string — this ends up in JSON. */
  price: string;
  seller: string;
  buyer: string;
  height: number;
  timestamp: number;
  /** Which side initiated, and how. */
  kind: 'sale' | 'offerAccepted' | 'collectionOfferAccepted';
};

type RawBox = {
  boxId: string;
  address: string;
  value: string | number;
  assets?: Array<{ tokenId: string; amount: string | number }>;
  additionalRegisters?: Record<string, { serializedValue: string; renderedValue?: string }>;
};

export type RawTx = {
  id: string;
  inclusionHeight: number;
  timestamp: number;
  inputs: RawBox[];
  outputs: RawBox[];
};

/** The `R4 == <settled box id>` tag both contracts require, as serialized hex. */
const settlementTag = (boxId: string) => `0e20${boxId}`;

/**
 * Trades settled by one transaction.
 *
 * A transaction can settle several at once — that is legal and tested — so this
 * returns a list rather than one result.
 *
 * Spends that are not trades are skipped, and a cancellation is exactly that:
 * the seller took their listing back, no price, no counterparty, nothing to
 * record. Recording cancellations as zero-value sales would poison every floor
 * and average computed from this file.
 */
/** Tokens this venue lists. Anything else in a settlement is somebody's noise. */
const knownToken = (tokenId: string): boolean => BY_TOKEN_ID.has(tokenId);

/**
 * The token ids a collection bid can legitimately be settled with.
 *
 * A collection bid commits to a Merkle root, not to a token, so the only honest
 * way to say which piece settled it is to resolve that root back to a
 * collection and look for a member of THAT one. "Any token in the catalogue" is
 * not enough: a settlement may carry an extra output holding a piece from a
 * different collection, and the indexer would record that as the trade —
 * reproduced in review with a Mage Champions planted in an Ergo Mummy bid.
 */
function membersOfRoot(rootHex: string | null | undefined): Set<string> | null {
  if (!rootHex) return null;
  const key = Object.keys(COLLECTION_ROOTS).find((k) => COLLECTION_ROOTS[k] === rootHex);
  const collection = key ? COLLECTIONS.find((c) => c.key === key) : undefined;
  return collection ? new Set(collection.live.map((t) => t.tokenId)) : null;
}

export function extractTrades(
  tx: RawTx,
  contracts: { sale: string; offer: string; collectionOffer?: string },
): Trade[] {
  const trades: Trade[] = [];

  for (const input of tx.inputs) {
    const isSale = input.address === contracts.sale;
    const isOffer = input.address === contracts.offer;
    const isCollection =
      Boolean(contracts.collectionOffer) && input.address === contracts.collectionOffer;
    if (!isSale && !isOffer && !isCollection) continue;

    // The settling output identifies itself by tag. Its absence means this spend
    // was a cancellation (the only other branch either contract allows).
    const tag = settlementTag(input.boxId);
    const tagged = tx.outputs.filter((o) => o.additionalRegisters?.R4?.serializedValue === tag);
    if (tagged.length === 0) continue;

    // Since royalties, TWO outputs carry the tag: the settlement and the
    // creator's share. Taking the first would sometimes read the royalty as the
    // whole trade — a 0.5 ERG sale recorded where 10 ERG changed hands, or the
    // creator listed as the buyer.
    //
    // The settlement is the larger output for a sale (the seller's 95% against
    // the creator's 5%) and the one carrying the token for a bid. Decided by
    // content rather than position, because output order is the builder's
    // choice and nothing on chain fixes it.
    // For a bid, the delivery is the tagged output carrying a token this
    // marketplace actually knows.
    //
    // "Carries any token" is not enough: the contracts permit extra outputs, so
    // a settlement built by hand can place a tagged box holding some unrelated
    // token ahead of the real delivery, and the indexer would record that as
    // the piece traded. Checking membership makes the history describe this
    // venue's collections or nothing at all.
    // A specific offer names its token in R5, which is stronger than any
    // catalogue check: the delivery must carry exactly that token. A collection
    // bid names none, so membership of this venue's catalogue is the test.
    //
    // Neither is "carries any token". The contracts permit extra outputs, so a
    // hand-built settlement can put a tagged box holding something unrelated
    // ahead of the real delivery, and the indexer would record that as the
    // piece traded.
    const wanted = isOffer
      ? offerTokenIdFrom(input.additionalRegisters?.R5?.serializedValue ?? '')
      : null;
    // For a collection bid, membership of THIS bid's collection, resolved from
    // the root in R5 — not merely of the catalogue.
    const members = isCollection
      ? membersOfRoot(collectionRootFrom(input.additionalRegisters?.R5?.serializedValue ?? ''))
      : null;
    // An unrecognised root is not a licence to accept any catalogued token —
    // it means we cannot say what this bid was for, so nothing is recorded.
    if (isCollection && !members) continue;
    const eligible = (tokenId: string): boolean =>
      wanted ? tokenId === wanted : members ? members.has(tokenId) : knownToken(tokenId);

    // Gathered across EVERY tagged output, not the first that looks right.
    //
    // The contracts permit extra outputs, so a settlement can carry two tagged
    // deliveries — a decoy piece from the same collection first, the real one
    // second. Searching output by output records whichever the builder listed
    // first, which says nothing about the trade. Collecting the whole set and
    // insisting on exactly one is the only reading that cannot be steered.
    const delivered = isSale
      ? []
      : [
          ...new Set(
            tagged.flatMap((o) =>
              (o.assets ?? []).filter((a) => eligible(a.tokenId)).map((a) => a.tokenId),
            ),
          ),
        ];

    // Zero or several: ambiguous, so nothing is recorded. A missing row can be
    // rebuilt from the chain; a wrong one is quietly false forever.
    if (!isSale && delivered.length !== 1) continue;

    const settlement = isSale
      ? tagged.reduce((a, b) => (BigInt(b.value) > BigInt(a.value) ? b : a))
      : tagged.find((o) => o.assets?.some((a) => a.tokenId === delivered[0]));
    if (!settlement) continue;

    if (isSale) {
      const tokenId = input.assets?.[0]?.tokenId;
      const seller = sellerAddressFrom(input.additionalRegisters?.R4?.serializedValue ?? '');
      const price = input.additionalRegisters?.R5?.renderedValue;
      if (!tokenId || !seller || !price) continue;

      // The buyer is whoever ended up with the token, not whoever paid — with
      // change outputs there can be several addresses in a transaction, and only
      // one of them receives the NFT.
      const received = tx.outputs.find((o) => o.assets?.some((a) => a.tokenId === tokenId));
      if (!received) continue;

      trades.push({
        txId: tx.id,
        boxId: input.boxId,
        tokenId,
        price,
        seller,
        buyer: received.address,
        height: tx.inclusionHeight,
        timestamp: tx.timestamp,
        kind: 'sale',
      });
    } else {
      const bidder = sellerAddressFrom(input.additionalRegisters?.R4?.serializedValue ?? '');
      // A specific offer names its token in R5. A collection bid names a Merkle
      // root instead, so the piece that settled it is only knowable from the
      // delivery output — which is the settlement box we already found.
      const tokenId = isCollection
        ? // Exactly one eligible token, or nothing.
          //
          // The delivery may legitimately carry several tokens, and an
          // adversarial one deliberately puts a piece from another collection
          // first — reproduced in review, where a Mage Champions ahead of the
          // real Ergo Mummy was recorded as the trade. Taking assets[0] reads
          // whichever the builder chose to list first, which is not a fact
          // about the trade at all. Ambiguity is dropped rather than guessed:
          // a missing row is recoverable, a wrong one is quietly false.
          (() => {
            const hits = (settlement.assets ?? []).filter((a) => eligible(a.tokenId));
            return hits.length === 1 ? hits[0].tokenId : null;
          })()
        : offerTokenIdFrom(input.additionalRegisters?.R5?.serializedValue ?? '');
      if (!tokenId || !bidder) continue;

      // On an accepted offer the bid IS the offer box's ERG, and the seller is
      // whoever delivered the token — the change address, not anything named in
      // a register. The settlement output is the delivery to the bidder, so the
      // seller is the other party that received value.
      //
      // The miner fee box has to be excluded explicitly. It is an ordinary
      // output to a P2S contract, and taking the first non-bidder output
      // recorded the FEE ADDRESS as the seller — which is what the first real
      // trade through this marketplace actually produced. Largest-value among
      // what remains, because the change output is where the bid lands.
        // Taken from the INPUT that carried the token, not from whoever received
        // the most ERG.
        //
        // The old rule — largest non-bidder, non-fee output — was forgeable: an
        // extra, larger payment to an unrelated address made that address the
        // recorded seller. Reproduced in review. Who delivered the piece is not
        // a matter of who was paid most; it is written in the input that held
        // it, either as the address itself or, when the piece was listed, in
        // the sale box's R4.
        const source = tx.inputs.find((i) => i.assets?.some((a) => a.tokenId === tokenId));
        const seller = source
          ? source.address === contracts.sale
            ? sellerAddressFrom(source.additionalRegisters?.R4?.serializedValue ?? '')
            : source.address
          : '';
        if (!seller) continue;

      trades.push({
        txId: tx.id,
        boxId: input.boxId,
        tokenId,
        price: String(input.value),
        seller,
        buyer: bidder,
        height: tx.inclusionHeight,
        timestamp: tx.timestamp,
        kind: isCollection ? 'collectionOfferAccepted' : 'offerAccepted',
      });
    }
  }

  return trades;
}

/** Newest first, and de-duplicated by the box each trade settled. */
export function mergeTrades(existing: Trade[], incoming: Trade[]): Trade[] {
  const byBox = new Map(existing.map((t) => [t.boxId, t]));
  for (const t of incoming) byBox.set(t.boxId, t);
  return [...byBox.values()].sort((a, b) => b.height - a.height || b.timestamp - a.timestamp);
}
