'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import PixelPanel from './ui/PixelPanel';
import PixelButton from './ui/PixelButton';
import { imageSources, rarityLabel, type Nft } from '@/lib/collections';
import { toErg, type Listing } from '@/lib/explorer';
import { pendingLabel, type Pending } from '@/lib/usePending';
import { EXPLORER_UI } from '@/lib/contract';

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
  dir,
  href,
  listing,
  topOffer,
  rarity,
  pending,
  action,
  busy,
  onAct,
}: {
  nft: Nft;
  dir: string;
  href: string;
  listing?: Listing;
  /** Highest live bid, shown when the token is not listed. */
  topOffer?: bigint;
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
        <p className="truncate font-pixel text-lg text-gray-200" title={nft.name}>
          {nft.name}
        </p>
      </Link>

      {/* Bottom row: what the piece costs and how rare it is on the left, the
          action on the right. Price above rarity because price is the number
          being decided on; rarity is the context for it. */}
      <div className="mt-1 flex min-h-[28px] items-end justify-between gap-2">
        <div className="min-w-0">
          {(listing || topOffer) && (
            <p className="truncate font-pixel text-lg text-amber-300">
              {listing ? `${toErg(listing.price)} ERG` : `bid ${toErg(topOffer!)}`}
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
        {/* A signed action replaces the button entirely. Leaving the button
            live would invite a second transaction spending a box the first one
            already claimed. */}
        {pending ? (
          <a
            href={`${EXPLORER_UI}/transactions/${pending.txId}`}
            target="_blank"
            rel="noreferrer"
            title="Waiting for the next block — click to follow the transaction"
            className="shrink-0 font-pixel text-base text-amber-300/70 underline"
          >
            {pendingLabel(pending)}
          </a>
        ) : (
          action && (
          <PixelButton
            size="sm"
            disabled={busy}
            onClick={() => onAct(action)}
            className="shrink-0"
            title={action === 'cancel' ? 'Take this listing back' : undefined}
          >
            {busy
              ? '…'
              : action === 'buy'
                ? 'Buy'
                : action === 'cancel'
                  ? 'Cancel'
                  : action === 'list'
                    ? 'List'
                    : 'Offer'}
          </PixelButton>
          )
        )}
      </div>
    </PixelPanel>
  );
}
