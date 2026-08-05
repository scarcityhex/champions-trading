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

/** Seconds. Roughly a couple of Ergo blocks: fresh enough that a bought
 *  listing disappears quickly, slow enough to absorb a burst of visitors. */
export const revalidate = 30;

export async function GET(request: Request) {
  // `?fresh=1` skips the cache. Used by the refresh that follows a signed
  // transaction — the client cannot be shown a snapshot older than its own
  // action, which is how a just-accepted offer kept appearing as a live bid.
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  try {
    // Settled together: a partial read would be worse than a stale one.
    const [listings, offers, collectionOffers, height, recent] = await Promise.all([
      fetchListings(fresh),
      fetchOffers(fresh),
      fetchCollectionOffers(fresh),
      chainHeight(fresh),
      recentTrades(fresh),
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
    });
  } catch (e) {
    // A failing explorer must not take the gallery down with it; the UI shows
    // the catalog without prices and says so.
    return NextResponse.json(
      {
        listings: [],
        offers: [],
        collectionOffers: [],
        height: null,
        recent: [],
        error: e instanceof Error ? e.message : 'explorer unavailable',
      },
      { status: 200 },
    );
  }
}
