// usePending.test.ts — when a pending label is allowed to disappear.
//
// The rule matters in both directions. Clearing too early puts the token back
// into the two-minute limbo the feature exists to prevent; clearing too late
// leaves a label claiming something is in flight when it settled long ago, and
// worse, keeps the action button hidden.
//
// isSettled is exported for exactly this reason. A test that reimplemented the
// rule would pass while the real one was broken, which is worse than no test.

import { describe, expect, it } from 'vitest';
import { isSettled, pendingLabel, type Pending, type PendingKind } from './usePending';
import type { Listing, Offer } from './explorer';

const TOKEN = '5836c62731c4f5f0d0e4a5f0b3f9a4d0c2e8b1a7f6d3c9e2b8a4f1d7c3e9b2a8';
const ME = '9hveS5VmStvpiybxya1adrvJipaz6Pi8bJMuttKuMvsijNiNxiv';
const BOX = 'aa'.repeat(32);

const pending = (kind: PendingKind, boxId?: string): Pending => ({
  tokenId: TOKEN,
  kind,
  txId: 'tx',
  boxId,
  signedAt: Date.now(),
});

const listing = (): Listing => ({
  boxId: BOX,
  tokenId: TOKEN,
  price: 1_000_000_000n,
  boxValue: 1_000_000n,
  seller: ME,
  box: {} as Listing['box'],
});

const offer = (boxId = BOX): Offer => ({
  boxId,
  tokenId: TOKEN,
  amount: 1_000_000_000n,
  bidder: ME,
  box: {} as Offer['box'],
});

/** Calls the real rule; no reimplementation to drift out of step. */
const settled = (
  p: Pending,
  listings: Map<string, Listing>,
  offers: Map<string, Offer[]>,
  owned: Set<string>,
) => isSettled(p, { listings, offers }, owned);

const empty = { listings: new Map<string, Listing>(), offers: new Map<string, Offer[]>() };

describe('settlement rule', () => {
  it('keeps a listing pending until the contract box appears', () => {
    const p = pending('list');
    expect(settled(p, empty.listings, empty.offers, new Set())).toBe(false);
    expect(settled(p, new Map([[TOKEN, listing()]]), empty.offers, new Set())).toBe(true);
  });

  it('keeps an offer pending until the bid appears', () => {
    const p = pending('offer');
    expect(settled(p, empty.listings, empty.offers, new Set())).toBe(false);
    expect(settled(p, empty.listings, new Map([[TOKEN, [offer()]]]), new Set())).toBe(true);
  });

  // The subtle one. A listing can vanish because somebody ELSE bought it, and
  // treating that as our purchase settling would clear the label on a token the
  // user never received.
  it('does not treat a listing bought by someone else as our purchase', () => {
    const p = pending('buy');
    expect(settled(p, empty.listings, empty.offers, new Set())).toBe(false);
    expect(settled(p, empty.listings, empty.offers, new Set([TOKEN]))).toBe(true);
  });

  it('clears a cancel only once the token is back in the wallet', () => {
    const p = pending('cancel');
    // Box already gone, but the wallet has not caught up: still pending.
    expect(settled(p, empty.listings, empty.offers, new Set())).toBe(false);
    expect(settled(p, empty.listings, empty.offers, new Set([TOKEN]))).toBe(true);
  });

  // Accept and withdraw spend one specific box, so they must key on it: another
  // bid arriving on the same token is not our action settling.
  it('clears an accept only when that exact offer box is gone', () => {
    const p = pending('accept', BOX);
    expect(settled(p, empty.listings, new Map([[TOKEN, [offer(BOX)]]]), new Set())).toBe(false);
    // A different bid on the same token — ours is settled, this one is not it.
    expect(settled(p, empty.listings, new Map([[TOKEN, [offer('bb'.repeat(32))]]]), new Set())).toBe(
      true,
    );
    expect(settled(p, empty.listings, empty.offers, new Set())).toBe(true);
  });

  it('clears a withdraw on the same rule', () => {
    const p = pending('withdraw', BOX);
    expect(settled(p, empty.listings, new Map([[TOKEN, [offer(BOX)]]]), new Set())).toBe(false);
    expect(settled(p, empty.listings, empty.offers, new Set())).toBe(true);
  });
});

describe('pendingLabel', () => {
  it('names every action, so no state renders blank', () => {
    const kinds: PendingKind[] = ['list', 'buy', 'cancel', 'offer', 'accept', 'withdraw'];
    for (const k of kinds) {
      const label = pendingLabel(pending(k));
      expect(label, k).toBeTruthy();
      expect(label.endsWith('…'), k).toBe(true);
    }
  });
});
