'use client';

// AmountDialog — asks for an amount before a listing or an offer is signed.
//
// The two actions that need a number typed, and the two where a slip is
// expensive in opposite directions: a price with a misplaced decimal is a
// genuine NFT offered for a fraction of its worth, and a bid with one is ERG
// locked away far above what the bidder meant. Both are visible on chain the
// moment they land, so the guard has to be here, before signing.

import { useState } from 'react';
import PixelPanel from './ui/PixelPanel';
import PixelButton from './ui/PixelButton';
import { parseErg, toErg, NANO } from '@/lib/explorer';
import { LISTING_BOX_VALUE, FEE } from '@/lib/transactions';
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
  const [text, setText] = useState('');
  const price = parseErg(text);
  const valid = price !== null && price > 0n;

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
                {/* The listing box's own ERG is the seller's and comes back on
                    cancel, so it is not a cost — but it does have to be on hand,
                    and saying so beats an opaque "insufficient funds". */}
                <Row label="You receive" value={`${toErg(price)} ERG`} />
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
                  value={`${toErg(price - LISTING_BOX_VALUE - FEE)} ERG (net of their costs)`}
                />
                <Row label="Network fee" value={`${toErg(FEE)} ERG`} />
                <Row label="Withdrawable" value="any time, until accepted" />
              </>
            )
          ) : (
            <p className="font-pixel text-lg text-gray-500">
              {text === '' ? 'Enter a price.' : 'Not a valid amount (max 9 decimals).'}
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
        {valid && !listing && price <= LISTING_BOX_VALUE + FEE && (
          <p className="mt-2 font-pixel text-lg text-red-400">
            Too small to be worth accepting: the holder&apos;s costs would eat all of it.
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
