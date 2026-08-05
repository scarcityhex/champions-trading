'use client';

// useMarketData — the live order book, indexed for the UI.
//
// Fetched from /api/market rather than the explorer directly, so every visitor
// shares one cached read. Re-fetched on demand after a transaction is
// submitted, since the chain will not tell us.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CollectionOffer, Listing, Offer } from './explorer';
import type { Trade } from './history';
import { COLLECTION_ROOTS } from './contract';

type WireListing = Omit<Listing, 'price' | 'boxValue'> & { price: string; boxValue: string };
type WireOffer = Omit<Offer, 'amount'> & { amount: string };
type WireCollectionOffer = Omit<CollectionOffer, 'amount'> & { amount: string };

/** Merkle root -> collection key, so a bid can name what it covers. */
const COLLECTION_BY_ROOT = new Map(Object.entries(COLLECTION_ROOTS).map(([k, r]) => [r, k]));

export type MarketData = {
  /** tokenId -> the live listing for it. */
  listings: Map<string, Listing>;
  /** tokenId -> every live offer on it, best first. */
  offers: Map<string, Offer[]>;
  /** collection key -> every live collection-wide bid, best first. */
  collectionOffers: Map<string, CollectionOffer[]>;
  loading: boolean;
  error: string | null;
  /** Re-read the shared market snapshot. Pending state covers the short server
   *  cache window after a transaction without exposing a public cache bypass. */
  refresh: () => void;
  /** When the currently displayed data was fetched. */
  fetchedAt: number | null;
  /** Current chain height, so a stale index can say how far behind it is. */
  height: number | null;
  /** Trades read live from the chain, newest first. */
  recent: Trade[];
};

export function useMarketData(): MarketData {
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [offers, setOffers] = useState<Map<string, Offer[]>>(new Map());
  const [collectionOffers, setCollectionOffers] = useState<Map<string, CollectionOffer[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [recent, setRecent] = useState<Trade[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Browser caching is disabled; the server still coalesces explorer reads.
    fetch('/api/market', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (data: {
          listings: WireListing[];
          offers: WireOffer[];
          collectionOffers?: WireCollectionOffer[];
          height?: number | null;
          recent?: Trade[];
          error?: string;
        }) => {
        if (cancelled) return;

        const l = new Map<string, Listing>();
        for (const raw of data.listings ?? []) {
          const parsed: Listing = {
            ...raw,
            price: BigInt(raw.price),
            boxValue: BigInt(raw.boxValue),
          };
          // Two boxes can hold the same token only if one is already spent and
          // the explorer is mid-refresh; keep the cheaper, which is the one a
          // buyer would want and the one that will still be there.
          const existing = l.get(raw.tokenId);
          if (!existing || parsed.price < existing.price) l.set(raw.tokenId, parsed);
        }

        const o = new Map<string, Offer[]>();
        for (const raw of data.offers ?? []) {
          const parsed: Offer = { ...raw, amount: BigInt(raw.amount) };
          const list = o.get(raw.tokenId);
          if (list) list.push(parsed);
          else o.set(raw.tokenId, [parsed]);
        }
        // Best bid first: a holder deciding whether to accept should not have
        // to scan for the highest.
        for (const list of o.values()) list.sort((a, b) => (b.amount > a.amount ? 1 : -1));

        // Grouped by collection, since that is the unit a collection bid names.
        // A root we do not recognise is dropped: we could not tell a user which
        // pieces it covers, and showing an unattributable bid is worse than
        // showing none.
        const co = new Map<string, CollectionOffer[]>();
        for (const raw of data.collectionOffers ?? []) {
          const key = COLLECTION_BY_ROOT.get(raw.root);
          if (!key) continue;
          const parsed: CollectionOffer = { ...raw, amount: BigInt(raw.amount) };
          const list = co.get(key);
          if (list) list.push(parsed);
          else co.set(key, [parsed]);
        }
        for (const list of co.values()) list.sort((a, b) => (b.amount > a.amount ? 1 : -1));

        setListings(l);
        setOffers(o);
        setCollectionOffers(co);
        setHeight(data.height ?? null);
        setRecent(data.recent ?? []);
        setFetchedAt(Date.now());
        setError(data.error ?? null);
      },
      )
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'could not load the order book');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => {
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  // Someone who tabs away, trades elsewhere and comes back expects to see it.
  // Only on focus, and only if the data is already a minute old: polling a
  // page nobody is looking at spends other people's rate limit for nothing.
  useEffect(() => {
    const onFocus = () => {
      if (!fetchedAt || Date.now() - fetchedAt > 60_000) refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchedAt, refresh]);

  // Memoised because consumers depend on the whole object: `isMine` takes it,
  // so exhaustive-deps asks for `data` rather than its fields. A fresh literal
  // every render made the gallery re-filter all 2,061 tokens on renders where
  // nothing it reads had changed.
  return useMemo(
    () => ({
      listings,
      offers,
      collectionOffers,
      loading,
      error,
      refresh,
      fetchedAt,
      height,
      recent,
    }),
    [listings, offers, collectionOffers, loading, error, refresh, fetchedAt, height, recent],
  );
}

export type BestOffer = {
  amount: bigint;
  /** A collection-wide bid can be settled with any qualifying piece. */
  kind: 'specific' | 'collection';
  bidder: string;
  boxId: string;
  /** This wallet placed it. Never true for a collection bid — see below. */
  mine: boolean;
};

/**
 * The most a holder could get for one token right now.
 *
 * Both kinds compete for the same piece, so the useful number is the maximum
 * across them — a 2 ERG collection bid beats a 1 ERG bid on that exact token,
 * and the holder should see 2.
 *
 * Ties go to the specific offer. It names this token and nothing else, so
 * accepting it cannot be beaten to the punch by another holder settling the
 * same collection bid with a different piece.
 *
 * `me` changes what is shown, in two different ways:
 *
 *   - Your own COLLECTION bid is dropped entirely. It applies to every piece,
 *     so it would print the same number on all 1,447 cards — your own money,
 *     rendered as if it were market demand. The panel above the grid already
 *     states it once, next to the button that withdraws it.
 *   - Your own SPECIFIC bid is kept but marked. It is information about that
 *     one token that exists nowhere else, and hiding it would lose the only
 *     trace of a bid you placed.
 */
export function bestOffer(
  tokenId: string,
  collectionKey: string,
  data: Pick<MarketData, 'offers' | 'collectionOffers'>,
  me: string | null = null,
): BestOffer | null {
  const specific = data.offers.get(tokenId)?.[0];
  const collection = (data.collectionOffers.get(collectionKey) ?? []).find(
    (o) => o.bidder !== me,
  );

  const candidates: BestOffer[] = [];
  if (specific) {
    candidates.push({
      amount: specific.amount,
      kind: 'specific',
      bidder: specific.bidder,
      boxId: specific.boxId,
      mine: Boolean(me) && specific.bidder === me,
    });
  }
  if (collection) {
    candidates.push({
      amount: collection.amount,
      kind: 'collection',
      bidder: collection.bidder,
      boxId: collection.boxId,
      mine: false,
    });
  }
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    if (a.amount !== b.amount) return b.amount > a.amount ? 1 : -1;
    return a.kind === 'specific' ? -1 : 1;
  })[0];
}
