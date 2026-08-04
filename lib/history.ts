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

import { ErgoAddress, FEE_CONTRACT } from '@fleet-sdk/core';
import { sellerAddressFrom, offerTokenIdFrom } from './transactions';
import { NETWORK_PREFIX, NETWORK } from './contract';

/**
 * The miner fee address.
 *
 * Every transaction has one, it is an ordinary output like any other, and it
 * must never be mistaken for a counterparty. Derived rather than pasted so it
 * follows the network the app is built for.
 */
const FEE_ADDRESS = ErgoAddress.fromErgoTree(FEE_CONTRACT)
  .toString(NETWORK_PREFIX[NETWORK]);

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
  /** Which side initiated: a listing someone bought, or a bid someone took. */
  kind: 'sale' | 'offerAccepted';
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
export function extractTrades(
  tx: RawTx,
  contracts: { sale: string; offer: string },
): Trade[] {
  const trades: Trade[] = [];

  for (const input of tx.inputs) {
    const isSale = input.address === contracts.sale;
    const isOffer = input.address === contracts.offer;
    if (!isSale && !isOffer) continue;

    // The settling output identifies itself by tag. Its absence means this spend
    // was a cancellation (the only other branch either contract allows).
    const tag = settlementTag(input.boxId);
    const settlement = tx.outputs.find((o) => o.additionalRegisters?.R4?.serializedValue === tag);
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
      const tokenId = offerTokenIdFrom(input.additionalRegisters?.R5?.serializedValue ?? '');
      const bidder = sellerAddressFrom(input.additionalRegisters?.R4?.serializedValue ?? '');
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
      const seller =
        tx.outputs
          .filter(
            (o) =>
              o.address !== bidder &&
              o.address !== contracts.offer &&
              o.address !== FEE_ADDRESS,
          )
          .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)))[0]?.address ?? '';
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
        kind: 'offerAccepted',
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
