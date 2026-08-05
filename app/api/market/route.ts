// GET /api/market — the live order book: listings and offers.
//
// The browser could call the explorer directly, but routing through here buys
// two things worth having: one cached response shared by every visitor instead
// of one explorer hit per page load (public explorers rate-limit, and a busy
// gallery would trip it), and a single place where the raw chain shape is
// normalized.
//
// Both sides come from one request so the UI can never render a token as "not
// for sale" from fresh listings while showing offers read a minute earlier.
//
// This is the "cache at the edge, not in a database" half of the no-DB design
// (docs/architecture.md §1). Nothing is stored — the cache expires and the next
// request re-reads the chain.

import { NextResponse } from 'next/server';
import {
  chainHeight,
  fetchCollectionOffers,
  fetchListings,
  fetchOffers,
  recentTrades,
} from '@/lib/explorer';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const rate = checkRateLimit(request, 'market', 30, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'too many market refreshes' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rate.retryAfter),
          'Cache-Control': 'private, no-store',
        },
      },
    );
  }

  try {
    // Settled together: a partial read would be worse than a stale one. These
    // reads always use the shared 30-second explorer cache. Pending transaction
    // state keeps the UI honest during that small window without exposing an
    // unauthenticated cache-bypass endpoint.
    const [listings, offers, collectionOffers, height, recent] = await Promise.all([
      fetchListings(),
      fetchOffers(),
      fetchCollectionOffers(),
      chainHeight(),
      recentTrades(),
    ]);
    return NextResponse.json({
      // JSON has no bigint, so amounts cross as strings and the client rebuilds
      // them. Never as numbers: nanoERG passes Number.MAX_SAFE_INTEGER at ~9M
      // ERG, and more to the point, a money value that rounds anywhere is a bug
      // waiting for the one listing big enough to expose it.
      listings: listings.map((l) => ({
        ...l,
        price: l.price.toString(),
        boxValue: l.boxValue.toString(),
      })),
      offers: offers.map((o) => ({ ...o, amount: o.amount.toString() })),
      collectionOffers: collectionOffers.map((o) => ({ ...o, amount: o.amount.toString() })),
      height,
      recent,
      fetchedAt: Date.now(),
    }, { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' } });
  } catch (e) {
    // A failing explorer must not take the gallery down with it; the UI shows
    // the catalog without prices and says so.
    console.error('market explorer read failed', e);
    return NextResponse.json(
      {
        listings: [],
        offers: [],
        collectionOffers: [],
        height: null,
        recent: [],
        error: 'explorer unavailable',
      },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
