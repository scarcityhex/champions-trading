// bestOffer.test.ts — the number a card shows above the rarity line.
//
// Two kinds of bid compete for the same piece, and the holder cares about one
// question: what is the most this is worth right now. Showing the specific bid
// while a larger collection bid sits unmentioned would understate it.

import { describe, expect, it } from 'vitest';
import { bestOffer } from './useMarketData';
import type { CollectionOffer, Offer } from './explorer';

const TOKEN = 'aa'.repeat(32);
const KEY = 'ERGOCHAMPIONS';
const ERG = 1_000_000_000n;

const specific = (amount: bigint): Offer => ({
  boxId: 's'.repeat(64),
  tokenId: TOKEN,
  amount,
  bidder: '9hveS5VmStvpiybxya1adrvJipaz6Pi8bJMuttKuMvsijNiNxiv',
  box: {} as Offer['box'],
});

const collection = (amount: bigint): CollectionOffer => ({
  boxId: 'c'.repeat(64),
  root: 'f4'.repeat(32),
  amount,
  bidder: '9gtuMt4YTz5e1cskqyUAzVCXcQMHNtrF7RyfbnhHvNiQ1UoR697',
  box: {} as CollectionOffer['box'],
});

const ME = '9hveS5VmStvpiybxya1adrvJipaz6Pi8bJMuttKuMvsijNiNxiv';
const OTHER = '9gtuMt4YTz5e1cskqyUAzVCXcQMHNtrF7RyfbnhHvNiQ1UoR697';

const data = (s?: Offer, c?: CollectionOffer) => ({
  offers: s ? new Map([[TOKEN, [s]]]) : new Map<string, Offer[]>(),
  collectionOffers: c ? new Map([[KEY, [c]]]) : new Map<string, CollectionOffer[]>(),
});

describe('bestOffer', () => {
  it('is null when nobody has bid', () => {
    expect(bestOffer(TOKEN, KEY, data())).toBeNull();
  });

  it('takes the specific bid when it is the only one', () => {
    expect(bestOffer(TOKEN, KEY, data(specific(ERG)))?.kind).toBe('specific');
  });

  it('takes the collection bid when it is the only one', () => {
    expect(bestOffer(TOKEN, KEY, data(undefined, collection(ERG)))?.kind).toBe('collection');
  });

  // The reason this function exists.
  it('prefers a larger collection bid over a smaller specific one', () => {
    const best = bestOffer(TOKEN, KEY, data(specific(ERG), collection(2n * ERG)))!;
    expect(best.amount).toBe(2n * ERG);
    expect(best.kind).toBe('collection');
  });

  it('prefers a larger specific bid over a smaller collection one', () => {
    const best = bestOffer(TOKEN, KEY, data(specific(3n * ERG), collection(ERG)))!;
    expect(best.amount).toBe(3n * ERG);
    expect(best.kind).toBe('specific');
  });

  // A collection bid can be settled by any holder with any qualifying piece, so
  // at equal value the specific one is the safer thing to act on.
  it('breaks a tie in favour of the specific bid', () => {
    expect(bestOffer(TOKEN, KEY, data(specific(ERG), collection(ERG)))?.kind).toBe('specific');
  });

  it('ignores a collection bid on a different collection', () => {
    const d = data(undefined, collection(5n * ERG));
    expect(bestOffer(TOKEN, 'MAGECHAMPIONS', d)).toBeNull();
  });
});

// ── Whose bid it is ────────────────────────────────────────────────────────
//
// A collection bid applies to every piece, so the bidder's own bid printed the
// same number on all 1,447 of their cards — their own money, styled as market
// demand. Reported from a real session with two wallets side by side.
describe('bestOffer, from the bidder\'s own view', () => {
  const mineCollection = (amount: bigint): CollectionOffer => ({
    ...collection(amount),
    bidder: ME,
  });
  const mineSpecific = (amount: bigint): Offer => ({ ...specific(amount), bidder: ME });

  it('hides your own collection bid from every card', () => {
    expect(bestOffer(TOKEN, KEY, data(undefined, mineCollection(2n * ERG)), ME)).toBeNull();
  });

  it('still shows someone else\'s collection bid', () => {
    const theirs: CollectionOffer = { ...collection(2n * ERG), bidder: OTHER };
    expect(bestOffer(TOKEN, KEY, data(undefined, theirs), ME)?.kind).toBe('collection');
  });

  // Kept, unlike the collection case: it is information about this one token
  // that exists nowhere else, so hiding it would lose the trace of a bid placed.
  it('keeps your own specific bid, marked as yours', () => {
    const best = bestOffer(TOKEN, KEY, data(mineSpecific(ERG)), ME)!;
    expect(best.mine).toBe(true);
    expect(best.amount).toBe(ERG);
  });

  it('does not mark a stranger\'s bid as yours', () => {
    const theirs: Offer = { ...specific(ERG), bidder: OTHER };
    expect(bestOffer(TOKEN, KEY, data(theirs), ME)?.mine).toBe(false);
  });

  it('shows everything when no wallet is connected', () => {
    // Without an address nothing can be "mine", so a visitor sees the market
    // as it is.
    expect(bestOffer(TOKEN, KEY, data(undefined, mineCollection(2n * ERG)))).not.toBeNull();
  });
});
