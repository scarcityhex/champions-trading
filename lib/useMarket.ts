'use client';

// useMarket — list, buy and cancel, wired to the wallet.
//
// One place where a user action becomes a signed transaction, so the rules that
// must hold for all three live together: read the height fresh, build, let the
// wallet sign, then re-read both the wallet and the order book.
//
// The re-read is not a nicety. The chain does not notify anyone, and a UI that
// keeps showing a listing it just bought will happily build a second purchase
// of a box that no longer exists.

import { useCallback, useState } from 'react';
import type { Listing, Offer } from './explorer';
import type { PendingKind } from './usePending';
import {
  buildAcceptOfferTx,
  buildBuyTx,
  buildCancelOfferTx,
  buildCancelTx,
  buildListTx,
  buildOfferTx,
} from './transactions';
import { isWrongNetwork, type useNautilus } from './nautilus';
import { NETWORK } from './contract';

type Wallet = ReturnType<typeof useNautilus>;

export type MarketState = {
  /** tokenId currently being signed, if any. */
  busy: string | null;
  error: string | null;
  /** Transaction id of the last successful action. */
  lastTxId: string | null;
  clear: () => void;
  list: (tokenId: string, price: bigint) => Promise<void>;
  buy: (listing: Listing) => Promise<void>;
  cancel: (listing: Listing) => Promise<void>;
  offer: (tokenId: string, amount: bigint) => Promise<void>;
  acceptOffer: (offer: Offer) => Promise<void>;
  withdrawOffer: (offer: Offer) => Promise<void>;
};

/** A wallet refusal is a choice, not a failure; it should not surface as red. */
function isUserRejection(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('reject') || msg.includes('declin') || msg.includes('cancel');
}

export function useMarket(
  wallet: Wallet,
  onSettled: () => void,
  onPending: (p: { tokenId: string; kind: PendingKind; txId: string; boxId?: string }) => void,
): MarketState {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTxId, setLastTxId] = useState<string | null>(null);

  const run = useCallback(
    async (
      tokenId: string,
      kind: PendingKind,
      build: (height: number) => ReturnType<typeof buildListTx>,
      boxId?: string,
    ) => {
      if (!wallet.address) {
        setError('Connect a wallet first.');
        return;
      }
      // Checked here rather than on each button: this is the one funnel every
      // action passes through, so a new action cannot forget the guard. The
      // contract addresses differ per network, so signing across a mismatch
      // sends value to an address nobody controls on the wallet's chain.
      if (isWrongNetwork(wallet)) {
        setError(
          `Your wallet is on ${wallet.walletNetwork}, but this site is running against ${NETWORK}. ` +
            'Switch networks in Nautilus before trading.',
        );
        return;
      }
      setBusy(tokenId);
      setError(null);
      try {
        // Fetched per action rather than held in state: a stale creation height
        // makes a transaction the node will not accept.
        const height = await wallet.currentHeight();
        const txId = await wallet.signAndSubmit(build(height));
        setLastTxId(txId);
        // Recorded before the refresh, so the very first read after signing
        // already knows there is something in flight.
        onPending({ tokenId, kind, txId, boxId });
        onSettled();
      } catch (e) {
        if (!isUserRejection(e)) {
          setError(e instanceof Error ? e.message : 'Transaction failed.');
        }
      } finally {
        setBusy(null);
      }
    },
    [wallet, onSettled, onPending],
  );

  const list = useCallback(
    (tokenId: string, price: bigint) =>
      run(tokenId, 'list', (height) =>
        buildListTx({
          tokenId,
          price,
          sellerAddress: wallet.address!,
          utxos: wallet.utxos,
          height,
        }),
      ),
    [run, wallet],
  );

  const buy = useCallback(
    (listing: Listing) =>
      run(listing.tokenId, 'buy', (height) =>
        buildBuyTx({
          listingBox: listing.box,
          price: listing.price,
          sellerAddress: listing.seller,
          buyerAddress: wallet.address!,
          buyerUtxos: wallet.utxos,
          height,
        }),
        listing.boxId,
      ),
    [run, wallet],
  );

  const cancel = useCallback(
    (listing: Listing) =>
      run(listing.tokenId, 'cancel', (height) =>
        buildCancelTx({
          listingBox: listing.box,
          sellerAddress: wallet.address!,
          sellerUtxos: wallet.utxos,
          height,
        }),
        listing.boxId,
      ),
    [run, wallet],
  );

  const offer = useCallback(
    (tokenId: string, amount: bigint) =>
      run(tokenId, 'offer', (height) =>
        buildOfferTx({
          tokenId,
          amount,
          bidderAddress: wallet.address!,
          utxos: wallet.utxos,
          height,
        }),
      ),
    [run, wallet],
  );

  const acceptOffer = useCallback(
    (o: Offer) =>
      run(o.tokenId, 'accept', (height) =>
        buildAcceptOfferTx({
          offerBox: o.box,
          tokenId: o.tokenId,
          bidderAddress: o.bidder,
          holderAddress: wallet.address!,
          holderUtxos: wallet.utxos,
          height,
        }),
        o.boxId,
      ),
    [run, wallet],
  );

  const withdrawOffer = useCallback(
    (o: Offer) =>
      run(o.tokenId, 'withdraw', (height) =>
        buildCancelOfferTx({
          offerBox: o.box,
          bidderAddress: wallet.address!,
          bidderUtxos: wallet.utxos,
          height,
        }),
        o.boxId,
      ),
    [run, wallet],
  );

  const clear = useCallback(() => {
    setError(null);
    setLastTxId(null);
  }, []);

  return { busy, error, lastTxId, clear, list, buy, cancel, offer, acceptOffer, withdrawOffer };
}
