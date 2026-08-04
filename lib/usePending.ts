'use client';

// usePending — what you have signed but the chain has not shown yet.
//
// Ergo blocks are ~2 minutes apart, and everything the app reads from the
// explorer is confirmed-only. Meanwhile the wallet already knows about your
// pending spend and stops reporting the token as yours. So between signing a
// listing and the next block, a token was in neither place: not owned, not
// listed. It simply vanished from the interface.
//
// This closes that window by remembering the action locally until the order
// book agrees. It is a display aid and nothing more — the chain remains the
// only authority, and anything recorded here is discarded the moment reality
// disagrees or enough time passes that the transaction is not coming.

import { useCallback, useEffect, useState } from 'react';
import { NETWORK } from './contract';
import type { MarketData } from './useMarketData';

export type PendingKind = 'list' | 'buy' | 'cancel' | 'offer' | 'accept' | 'withdraw';

export type Pending = {
  tokenId: string;
  kind: PendingKind;
  txId: string;
  /** The contract box this action spends, for the four that spend one. */
  boxId?: string;
  signedAt: number;
};

/**
 * How long to keep showing a pending action.
 *
 * Generous on purpose. Ergo targets two minutes but the interval is a Poisson
 * process — a ten-minute gap is unremarkable, and dropping a real pending
 * action early puts the token back into the limbo this exists to prevent. The
 * cost of waiting too long is a stale label; the cost of giving up too early is
 * the original bug.
 */
const EXPIRES_AFTER = 30 * 60_000;

// Per network, so a testnet session cannot leave labels on a mainnet page.
const STORAGE_KEY = `champions-trading:pending:${NETWORK}`;

const LABELS: Record<PendingKind, string> = {
  list: 'listing…',
  buy: 'buying…',
  cancel: 'cancelling…',
  offer: 'offering…',
  accept: 'accepting…',
  withdraw: 'withdrawing…',
};

export const pendingLabel = (p: Pending): string => LABELS[p.kind];

/**
 * Has the chain caught up with this action?
 *
 * Two shapes, and the distinction is what makes this reliable: actions that
 * CREATE a contract box are settled once something for that token appears;
 * actions that SPEND one are settled once that specific box is gone. Both are
 * read from the order book we already fetch, so no extra request is needed.
 */
export function isSettled(
  p: Pending,
  data: Pick<MarketData, 'listings' | 'offers'>,
  owned: Set<string>,
): boolean {
  const listing = data.listings.get(p.tokenId);
  const offers = data.offers.get(p.tokenId) ?? [];

  switch (p.kind) {
    case 'list':
      return Boolean(listing);
    case 'offer':
      return offers.length > 0;
    case 'buy':
      // The box is gone AND the token arrived: a listing can also vanish
      // because someone else bought it first, and that is not this user's
      // action settling.
      return !listing && owned.has(p.tokenId);
    case 'cancel':
      return !listing && owned.has(p.tokenId);
    case 'accept':
    case 'withdraw':
      return !offers.some((o) => o.boxId === p.boxId);
  }
}

/**
 * Does this token belong in the user's "Mine" view?
 *
 * Four ways to own something here, and missing any of them makes a piece
 * vanish with no explanation:
 *
 *   - it is in the wallet
 *   - it is in the sale contract, listed by this wallet
 *   - this wallet has a funded bid on it — that is ERG already spent
 *   - an action on it is signed and waiting for a block
 *
 * The last one is the whole reason usePending exists. Between signing a listing
 * and the next block the wallet has already given the token up and the contract
 * box is not visible yet, so without this the piece is in neither place and
 * simply disappears for two minutes.
 *
 * Extracted and exported so it can be tested. It was inlined in the gallery
 * once, and the pending clause was silently dropped by a bad edit that nothing
 * caught — the filter still compiled and still looked right.
 */
export function isMine(
  tokenId: string,
  wallet: { owned: Set<string>; address: string | null },
  data: Pick<MarketData, 'listings' | 'offers'>,
  pending: Map<string, Pending>,
): boolean {
  if (wallet.owned.has(tokenId)) return true;
  if (pending.has(tokenId)) return true;
  if (!wallet.address) return false;
  if (data.listings.get(tokenId)?.seller === wallet.address) return true;
  return Boolean(data.offers.get(tokenId)?.some((o) => o.bidder === wallet.address));
}

export type PendingState = {
  /** tokenId -> the action awaiting confirmation. */
  byToken: Map<string, Pending>;
  add: (p: Omit<Pending, 'signedAt'>) => void;
};

export function usePending(data: MarketData, owned: Set<string>): PendingState {
  const [items, setItems] = useState<Pending[]>([]);

  // Restored on mount so a page refresh mid-block does not reopen the gap.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setItems(JSON.parse(raw) as Pending[]);
    } catch {
      // A malformed or unavailable store is not worth failing over; the worst
      // case is the original behaviour.
    }
  }, []);

  const persist = useCallback((next: Pending[]) => {
    setItems(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode, quota — display still works for this session */
    }
  }, []);

  // Drop anything the chain has confirmed or that has waited too long. Runs
  // whenever the order book changes, which is exactly when the answer can
  // change.
  useEffect(() => {
    if (items.length === 0 || data.loading) return;
    const now = Date.now();
    const kept = items.filter(
      (p) => now - p.signedAt < EXPIRES_AFTER && !isSettled(p, data, owned),
    );
    if (kept.length !== items.length) persist(kept);
  }, [items, data, owned, persist]);

  const add = useCallback(
    (p: Omit<Pending, 'signedAt'>) => {
      // Keyed by token: a second action on the same token replaces the first,
      // since only the newest can still be outstanding.
      const next = [
        ...items.filter((x) => x.tokenId !== p.tokenId),
        { ...p, signedAt: Date.now() },
      ];
      persist(next);
    },
    [items, persist],
  );

  return { byToken: new Map(items.map((p) => [p.tokenId, p])), add };
}
