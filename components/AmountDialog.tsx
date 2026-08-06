'use client';

// AmountDialog — asks for an amount before a listing or an offer is signed.
//
// The two actions that need a number typed, and the two where a slip is
// expensive in opposite directions: a price with a misplaced decimal is a
// genuine NFT offered for a fraction of its worth, and a bid with one is ERG
// locked away far above what the bidder meant. Both are visible on chain the
// moment they land, so the guard has to be here, before signing.

import { useEffect, useState } from 'react';
import PixelPanel from './ui/PixelPanel';
import PixelButton from './ui/PixelButton';
import { parseErg, toErg, NANO } from '@/lib/explorer';
import {
  LISTING_BOX_VALUE,
  FEE,
  MIN_OFFER_VALUE,
  MIN_ROYALTY_BID,
  offerNet,
} from '@/lib/transactions';
import { royaltyForDisplay, royaltyOn, sellerReceives, type Royalty } from '@/lib/royalties';
import { issuerBoxOf } from '@/lib/explorer';

import type { Nft } from '@/lib/collections';

export default function AmountDialog({
  mode,
  nft,
  busy,
  onConfirm,
  onClose,
}: {
  mode: 'list' | 'offer';
  nft: Nft;
  busy: boolean;
  onConfirm: (amount: bigint) => void;
  onClose: () => void;
}) {
  const listing = mode === 'list';
  // Loaded, not configured: the rate is whatever this token's issuer box says.
  // Starts unknown, and unknown is treated as "there is one".
  //
  // Starting at null showed the pre-royalty floor for the moment the lookup
  // took, so a bid typed quickly was announced as valid and then refused by the
  // builder. Every collection here charges 5%, so assuming a royalty until the
  // box says otherwise is both truer and the safer direction to be wrong in.
  const [royalty, setRoyalty] = useState<Royalty | null>(null);
  const [rateKnown, setRateKnown] = useState(false);
  useEffect(() => {
    let live = true;
    issuerBoxOf(nft.tokenId).then((box) => {
      if (!live) return;
      setRoyalty(royaltyForDisplay(box ?? undefined));
      setRateKnown(true);
    });
    return () => {
      live = false;
    };
  }, [nft.tokenId]);
  const [text, setText] = useState('');
  const price = parseErg(text);
  const positive = price !== null && price > 0n;
  // The floor the builder will enforce, so the button and the error agree.
  // Quoting MIN_OFFER_VALUE here let someone place a bid the builder then
  // refused — or worse, one the contract could never settle.
  const bidFloor = royalty || !rateKnown ? MIN_ROYALTY_BID : MIN_OFFER_VALUE;
  const offerTooSmall = !listing && positive && price < bidFloor;
  // A listing has the same floor for the same reason: below it the royalty
  // cannot fund its own output and nobody could ever buy the piece.
  const listingTooSmall = listing && positive && (royalty || !rateKnown) && price < MIN_ROYALTY_BID;
  const valid = positive && !offerTooSmall && !listingTooSmall;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <PixelPanel
        className="w-full max-w-md p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="font-pixel-display text-sm text-amber-300">
            {listing ? 'LIST FOR SALE' : 'MAKE AN OFFER'}
          </h2>
          <PixelButton size="sm" onClick={onClose}>✕</PixelButton>
        </div>

        <p className="mb-3 font-pixel text-xl text-gray-200">{nft.name}</p>

        <label className="mb-1 block font-pixel text-base text-gray-500">
          {listing ? 'PRICE (ERG)' : 'YOUR BID (ERG)'}
        </label>
        <input
          autoFocus
          value={text}
          inputMode="decimal"
          placeholder="0.0"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && !busy) onConfirm(price);
          }}
          className="mb-3 w-full bg-black/50 px-2 py-1 font-pixel text-2xl text-amber-300 outline-none"
          style={{ border: '2px solid #0d0905' }}
        />

        <PixelPanel variant="inset" className="mb-3 p-2">
          {valid ? (
            listing ? (
              <>
                <Row label="Buyer pays" value={`${toErg(price)} ERG`} />
                {/* One "You receive", stated once and after the deduction.
                    An earlier version printed it twice — the full price here
                    and the net further down — which is worse than printing the
                    wrong number, because the seller has no way to tell which
                    one the contract will honour. */}
                {royalty && royaltyOn(price, royalty) > 0n && (
                  <Row
                    label={`Creator royalty (${royalty.percent}%)`}
                    value={`− ${toErg(royaltyOn(price, royalty))} ERG`}
                  />
                )}
                <Row
                  label="You receive"
                  value={`${toErg(sellerReceives(price, royalty))} ERG`}
                />
                {/* The listing box's own ERG is the seller's and comes back on
                    cancel, so it is not a cost — but it does have to be on hand,
                    and saying so beats an opaque "insufficient funds". */}
                <Row
                  label="Locked in the listing"
                  value={`${toErg(LISTING_BOX_VALUE)} ERG (returned on cancel)`}
                />
                <Row label="Network fee" value={`${toErg(FEE)} ERG`} />
              </>
            ) : (
              <>
                {/* The bid IS the box's ERG: it leaves the wallet now and stays
                    locked until someone delivers the token or it is withdrawn.
                    Saying "locked" rather than "offered" is the honest word. */}
                <Row label="Locked until accepted" value={`${toErg(price)} ERG`} />
                <Row
                  label="Holder receives"
                  value={`${toErg(offerNet(price, royalty))} ERG (net of costs and royalty)`}
                />
                <Row label="Network fee" value={`${toErg(FEE)} ERG`} />
                <Row label="Withdrawable" value="any time, until accepted" />
              </>
            )
          ) : (
            <p className="font-pixel text-lg text-gray-500">
              {text === ''
                ? 'Enter a price.'
                : offerTooSmall
                  ? `Minimum safe offer: ${toErg(bidFloor)} ERG.`
                  : listingTooSmall
                    ? `Minimum workable price: ${toErg(MIN_ROYALTY_BID)} ERG.`
                  : 'Not a valid amount (max 9 decimals).'}
            </p>
          )}
        </PixelPanel>

        <div className="flex justify-end gap-2">
          <PixelButton onClick={onClose}>Cancel</PixelButton>
          <PixelButton disabled={!valid || busy} onClick={() => valid && onConfirm(price)}>
            {busy ? 'Signing…' : listing ? 'List it' : 'Place offer'}
          </PixelButton>
        </div>

        {valid && price < NANO / 100n && (
          <p className="mt-2 font-pixel text-lg text-red-400">
            That is under 0.01 ERG — check the decimal point.
          </p>
        )}
      </PixelPanel>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="font-pixel text-lg text-gray-500">{label}</span>
      <span className="font-pixel text-lg text-gray-200">{value}</span>
    </div>
  );
}
