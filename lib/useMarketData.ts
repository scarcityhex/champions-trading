'use client';

// useMarketData — the live order book, indexed for the UI.
//
// Fetched from /api/market rather than the explorer directly, so every visitor
// shares one cached read. Re-fetched on demand after a transaction is
// submitted, since the chain will not tell us.

import { useCallback, useEffect, useState } from 'react';
import type { Listing, Offer } from './explorer';

type WireListing = Omit<Listing, 'price' | 'boxValue'> & { price: string; boxValue: string };
type WireOffer = Omit<Offer, 'amount'> & { amount: string };

export type MarketData = {
  /** tokenId -> the live listing for it. */
  listings: Map<string, Listing>;
  /** tokenId -> every live offer on it, best first. */
  offers: Map<string, Offer[]>;
  loading: boolean;
  error: string | null;
  /** Re-read the chain, skipping the server cache. Call after a transaction,
   *  or when the user asks. */
  refresh: () => void;
  /** When the currently displayed data was fetched. */
  fetchedAt: number | null;
};

export function useMarketData(): MarketData {
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [offers, setOffers] = useState<Map<string, Offer[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // The first load may use the shared 30s cache; every later one is forced
    // fresh, because it follows either a transaction or an explicit request.
    fetch(nonce === 0 ? '/api/market' : '/api/market?fresh=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { listings: WireListing[]; offers: WireOffer[]; error?: string }) => {
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

        setListings(l);
        setOffers(o);
        setFetchedAt(Date.now());
        setError(data.error ?? null);
      })
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

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

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

  return { listings, offers, loading, error, refresh, fetchedAt };
}
