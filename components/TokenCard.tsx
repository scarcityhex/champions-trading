'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import PixelPanel from './ui/PixelPanel';
import { imageSources, rarityLabel, shortLabel, type Collection, type Nft } from '@/lib/collections';
import { toErg, type Listing } from '@/lib/explorer';
import type { BestOffer } from '@/lib/useMarketData';
import type { Pending } from '@/lib/usePending';

export type CardAction = 'buy' | 'cancel' | 'list' | 'offer' | null;

/**
 * What the connected wallet can do with this token.
 *
 * Deliberately a pure function of what we know rather than a flag set by the
 * caller: the states are mutually exclusive, and deriving them in one place is
 * what stops a "Buy" button appearing on a token the user is already selling.
 *
 * Order matters. A listing outranks ownership, because a token in the sale
 * contract is not in the wallet — offering "List" on it would build a
 * transaction spending a box the seller no longer holds.
 */
export function actionFor(
  listing: Listing | undefined,
  owned: boolean,
  address: string | null,
): CardAction {
  if (listing) return address && listing.seller === address ? 'cancel' : 'buy';
  if (owned) return 'list';
  // Anything else can be bid on, listed or not — that is the point of offers.
  return address ? 'offer' : null;
}

export default function TokenCard({
  nft,
  collection,
  dir,
  href,
  listing,
  topOffer,
  rarity,
}: {
  nft: Nft;
  collection: Collection;
  dir: string;
  href: string;
  listing?: Listing;
  /** Highest live bid on this piece, across specific and collection-wide. */
  topOffer?: BestOffer;
  /** Rarity percentile, 0.2 meaning the rarest piece in the collection. */
  rarity?: number;
  /** An action signed but not yet confirmed on chain. */
  pending?: Pending;
  action: CardAction;
  busy: boolean;
  onAct: (action: Exclude<CardAction, null>) => void;
}) {
  // Thumbnail, then the local original, then IPFS. Each error steps one level
  // down instead of blanking the tile — the local levels have real gaps.
  const sources = useMemo(() => imageSources(nft, dir), [nft, dir]);
  const [level, setLevel] = useState(0);
  const src = sources[level];
  const label = shortLabel(nft, collection);

  return (
    <PixelPanel variant="inset" className="flex flex-col p-2">
      <Link href={href} className="block">
        <div className="mb-2 aspect-square overflow-hidden bg-black/40">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={nft.name}
              loading="lazy"
              className="h-full w-full object-contain"
              onError={() => setLevel((l) => l + 1)}
            />
          ) : (
            <div className="flex h-full items-center justify-center font-pixel text-base text-gray-600">
              no art
            </div>
          )}
        </div>
        {/* Name and price share a line, which is what the abbreviation bought.
            Three fixed rows for every card regardless of state: a listed piece
            used to grow a fourth line and stand taller than its neighbours. */}
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate font-pixel text-lg text-gray-200" title={nft.name}>
            {label}
          </p>
          {listing && (
            <span className="shrink-0 font-pixel text-lg text-amber-300">
              {toErg(listing.price)}
            </span>
          )}
        </div>
      </Link>

      <div className="mt-1 flex min-h-[28px] items-center justify-between gap-2">
        <div className="min-w-0">
          {/* The bid a holder would act on, marked when it is collection-wide:
              that money can be taken by any holder with any qualifying piece,
              so it is not reserved for this one. */}
          {topOffer && (
            <p
              // Muted when it is your own: it is not an offer to you, and
              // colouring it like incoming demand would misread your own money.
              className={`truncate font-pixel text-lg ${
                topOffer.mine ? 'text-gray-500' : 'text-emerald-400'
              }`}
              title={
                topOffer.mine
                  ? 'Your own bid on this piece'
                  : topOffer.kind === 'collection'
                    ? 'A bid for any piece in this collection — another holder could take it first'
                    : 'A bid on this specific piece'
              }
            >
              {topOffer.mine ? 'your bid ' : 'bid '}
              {toErg(topOffer.amount)}
              {topOffer.kind === 'collection' && <span className="text-gray-500"> any</span>}
            </p>
          )}
          {rarityLabel(rarity) && (
            <p
              className="truncate font-pixel text-base text-gray-500"
              title={`Rarity rank across the surviving collection`}
            >
              {rarityLabel(rarity)}
            </p>
          )}
        </div>
      </div>
    </PixelPanel>
  );
}
