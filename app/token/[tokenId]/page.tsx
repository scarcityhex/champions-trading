'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import PixelPanel from '@/components/ui/PixelPanel';
import PixelButton from '@/components/ui/PixelButton';
import Header from '@/components/Header';
import { PAGE_WIDTH } from '@/components/ui/page';
import AmountDialog from '@/components/AmountDialog';
import { actionFor } from '@/components/TokenCard';
import { useMarketContext } from '@/components/MarketProvider';
import {
  BY_TOKEN_ID,
  collectionOf,
  traitCounts,
  detailSources,
  rarityPercentiles,
  rarityLabel,
} from '@/lib/collections';
import { toErg, type CollectionOffer, type Offer } from '@/lib/explorer';
import { offerNet, MIN_ROYALTY_BID } from '@/lib/transactions';
import { royaltyForDisplay, royaltyOn, sellerReceives, type Royalty } from '@/lib/royalties';
import { issuerBoxOf } from '@/lib/explorer';
import { shortAddress } from '@/lib/nautilus';
import { EXPLORER_UI } from '@/lib/contract';
import { pendingLabel, type Pending } from '@/lib/usePending';

/**
 * Split from the body below on purpose.
 *
 * The unknown-token case has to return before any hook that depends on the
 * token runs, and a hook cannot live behind an early return — going from a
 * known token to an unknown one would render fewer hooks than the previous
 * pass and React would throw. Two components, each with a fixed hook order.
 */
export default function TokenPage({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = use(params);
  const nft = BY_TOKEN_ID.get(tokenId);
  const collection = collectionOf(tokenId);

  if (!nft || !collection) {
    return (
      <main className="min-h-screen p-4 md:p-8">
        <div className={PAGE_WIDTH}>
          <Header />
          <PixelPanel className="p-6">
            <h1 className="mb-2 font-pixel-display text-sm text-red-400">UNKNOWN TOKEN</h1>
            {/* Not a 404 by accident — this is the anti-forgery message. A token
                that is not in the catalog is not one of these collections, no
                matter what its name says. */}
            <p className="mb-4 font-pixel text-xl text-gray-300">
              This token id is not part of Ergo Champions, Ergo Mummy or Mage Champions. Anyone can
              mint a token using a collection&apos;s name — only the token id proves origin.
            </p>
            <p className="mb-4 break-all font-pixel text-lg text-gray-500">{tokenId}</p>
            <Link href="/"><PixelButton>Back to the gallery</PixelButton></Link>
          </PixelPanel>
        </div>
      </main>
    );
  }

  if (nft.burned) return <BurnedToken tokenId={tokenId} nft={nft} />;

  return <TokenDetail tokenId={tokenId} nft={nft} collection={collection} />;
}

/**
 * A token that no longer exists.
 *
 * Deliberately NOT the unknown-token screen above. That one says "this is not
 * from these collections", which for a burned piece would be a false accusation
 * of forgery — it was genuine, it just does not exist any more. It gets its own
 * page rather than a 404 because links to it exist and will keep arriving.
 */
function BurnedToken({
  tokenId,
  nft,
}: {
  tokenId: string;
  nft: NonNullable<ReturnType<typeof BY_TOKEN_ID.get>>;
}) {
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className={PAGE_WIDTH}>
        <Header />
        <PixelPanel className="p-6">
          <h1 className="mb-2 font-pixel-display text-sm text-gray-400">BURNED</h1>
          <p className="mb-3 font-pixel text-3xl text-gray-200">{nft.name}</p>
          <p className="mb-4 font-pixel text-xl text-gray-300">
            {nft.neverSold
              ? 'This token was destroyed by the collection issuer without ever having been sold. It cannot be traded by anyone.'
              : 'This token was destroyed by a holder after being sold. It cannot be traded by anyone.'}
          </p>
          <p className="mb-4 break-all font-pixel text-lg text-gray-600">{tokenId}</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/"><PixelButton>Back to the gallery</PixelButton></Link>
            <a
              href={`${EXPLORER_UI}/token/${tokenId}`}
              target="_blank"
              rel="noreferrer"
            >
              <PixelButton>Verify on the explorer</PixelButton>
            </a>
          </div>
        </PixelPanel>
      </div>
    </main>
  );
}

function TokenDetail({
  tokenId,
  nft,
  collection,
}: {
  tokenId: string;
  nft: NonNullable<ReturnType<typeof BY_TOKEN_ID.get>>;
  collection: NonNullable<ReturnType<typeof collectionOf>>;
}) {
  const { wallet, data, actions, pending } = useMarketContext();
  const [dialog, setDialog] = useState<'list' | 'offer' | null>(null);

  const listing = data.listings.get(tokenId);
  const offers = data.offers.get(tokenId) ?? [];
  const collectionBids = data.collectionOffers.get(collection.key) ?? [];
  const action = actionFor(listing, wallet.owned.has(tokenId), wallet.address);
  const busy = actions.busy === tokenId;
  const inFlight = pending.byToken.get(tokenId);
  const counts = traitCounts(collection);
  const rank = rarityPercentiles(collection).get(tokenId);
  const sources = useMemo(() => detailSources(nft, collection.dir), [nft, collection.dir]);

  // The creator's share is a fact about the token, published at mint time in
  // its issuer box. Loaded here so the price can be shown split rather than as
  // a single number that turns into two in the wallet popup.
  const [royalty, setRoyalty] = useState<Royalty | null>(null);
  useEffect(() => {
    let live = true;
    issuerBoxOf(tokenId).then((box) => {
      if (live) setRoyalty(royaltyForDisplay(box ?? undefined));
    });
    return () => {
      live = false;
    };
  }, [tokenId]);

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className={PAGE_WIDTH}>
        <Header />

        <PixelPanel className="p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="font-pixel-display text-sm text-amber-300 md:text-base">{nft.name}</h1>
              {rarityLabel(rank) && (
                <span className="font-pixel text-xl text-amber-300/80">
                  {rarityLabel(rank)} rarest of {collection.live.length}
                </span>
              )}
            </div>
            <Link href="/"><PixelButton size="sm">← Gallery</PixelButton></Link>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Artwork sources={sources} alt={nft.name} />

            <div className="flex flex-col gap-4">
              <PriceBlock
                listing={listing}
                action={action}
                pending={inFlight}
                busy={busy}
                royalty={royalty}
                onBuy={() => listing && actions.buy(listing)}
                onCancel={() => listing && actions.cancel(listing)}
                onList={() => setDialog('list')}
                onOffer={() => setDialog('offer')}
                connected={Boolean(wallet.address)}
              />
              <Offers
                royalty={royalty}
                offers={offers}
                collectionBids={collectionBids}
                me={wallet.address}
                // A piece you have listed is still yours to give: the token sits
                // in the sale contract, whose cancel branch is your signature.
                // Treating "not in my wallet" as "not mine" hid the Accept
                // button on exactly the pieces most likely to attract a bid.
                owned={wallet.owned.has(tokenId) || listing?.seller === wallet.address}
                listed={listing?.seller === wallet.address ? listing : undefined}
                busy={busy}
                onAccept={(o) =>
                  actions.acceptOffer(
                    o,
                    listing?.seller === wallet.address ? listing : undefined,
                  )
                }
                onWithdraw={actions.withdrawOffer}
                onAcceptCollection={(o) =>
                  actions.acceptCollectionOffer(
                    o,
                    tokenId,
                    collection.live.map((t) => t.tokenId),
                    listing?.seller === wallet.address ? listing : undefined,
                  )
                }
                onMake={() => setDialog('offer')}
              />
              <Provenance
                tokenId={tokenId}
                nft={nft}
                issuer={collection.issuer}
                listing={listing}
              />
            </div>
          </div>

          <h2 className="mb-2 mt-4 font-pixel-display text-sm text-gray-400">
            TRAITS{' '}
            <span className="font-pixel text-base text-gray-600">
              rarity out of {collection.live.length} surviving
              {collection.tokens.length !== collection.live.length &&
                ` of ${collection.tokens.length} minted`}
            </span>
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {(nft.attributes ?? []).map((a) => {
              const n = counts.get(a.trait_type)?.get(a.value) ?? 0;
              const pct = (n / collection.live.length) * 100;
              return (
                <PixelPanel key={`${a.trait_type}:${a.value}`} variant="inset" className="p-2">
                  <p className="truncate font-pixel text-base text-gray-500">{a.trait_type}</p>
                  <p className="truncate font-pixel text-xl text-gray-200" title={a.value}>
                    {a.value}
                  </p>
                  <p className="font-pixel text-base text-amber-300/80">
                    {n} of {collection.live.length} · {pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%
                  </p>
                </PixelPanel>
              );
            })}
          </div>
        </PixelPanel>
      </div>

      {dialog && (
        <AmountDialog
          mode={dialog}
          nft={nft}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(amount: bigint) => {
            if (dialog === 'list') actions.list(tokenId, amount);
            else actions.offer(tokenId, amount);
            setDialog(null);
          }}
        />
      )}
    </main>
  );
}

function Artwork({ sources, alt }: { sources: string[]; alt: string }) {
  // Starts at the detail tier rather than the thumbnail: this is the view where
  // resolution is the point. Falls through the same chain on error, which is
  // exercised in practice — 176 Mage Champions have no local copy at all.
  const [level, setLevel] = useState(0);
  const src = sources[level];

  return (
    <PixelPanel variant="inset" className="p-2">
      <div className="aspect-square overflow-hidden bg-black/40">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            className="h-full w-full object-contain"
            onError={() => setLevel((l) => l + 1)}
          />
        ) : (
          <div className="flex h-full items-center justify-center font-pixel text-xl text-gray-600">
            artwork unavailable
          </div>
        )}
      </div>
    </PixelPanel>
  );
}

function PriceBlock({
  listing,
  action,
  pending,
  busy,
  connected,
  onBuy,
  onCancel,
  onList,
  onOffer,
  royalty,
}: {
  listing?: { price: bigint; seller: string; boxValue: bigint };
  action: ReturnType<typeof actionFor>;
  pending?: Pending;
  busy: boolean;
  connected: boolean;
  onBuy: () => void;
  onCancel: () => void;
  onList: () => void;
  onOffer: () => void;
  /** Read from the token's issuer box; null until it loads, or if it has none. */
  royalty: Royalty | null;
}) {
  const creatorGets = listing ? royaltyOn(listing.price, royalty) : 0n;
  const sellerGets = listing ? sellerReceives(listing.price, royalty) : 0n;
  return (
    <PixelPanel variant="inset" className="p-3">
      {listing ? (
        <>
          <p className="font-pixel text-base text-gray-500">PRICE</p>
          <p className="mb-1 font-pixel text-4xl text-amber-300">{toErg(listing.price)} ERG</p>
          <p className="mb-3 font-pixel text-lg text-gray-500" title={listing.seller}>
            Seller {shortAddress(listing.seller)}
          </p>
          {/* Itemised rather than folded into one number. The buyer is paying
              two different people, and a total that quietly exceeds the price
              on the card is the kind of surprise that gets found in the wallet
              popup — which is the worst place to find it. */}
          {creatorGets > 0n && royalty && (
            <div className="mb-3 border-t border-black/40 pt-2">
              <Line label="You pay" value={`${toErg(listing.price)} ERG`} strong />
              <Line
                label={`Creator royalty (${royalty.percent}%)`}
                value={`${toErg(creatorGets)} ERG`}
              />
              <Line label="Seller receives" value={`${toErg(sellerGets)} ERG`} />
            </div>
          )}
        </>
      ) : (
        <p className="mb-3 font-pixel text-xl text-gray-400">Not for sale.</p>
      )}

      {pending ? (
        <div>
          <p className="font-pixel text-xl text-amber-300/80">{pendingLabel(pending)}</p>
          {/* Same caveat as the header receipt: the explorer will deny knowing
              this transaction for the first minutes, and that sentence reads as
              a failure to anyone who has not been warned. */}
          <p className="font-pixel text-lg text-gray-500">
            Waiting for the next block. Ergo mines one about every 2 minutes on
            average, sometimes much longer. The explorer may not find it until then —
            that is the explorer catching up, not a failure.{' '}
            <a
              href={`${EXPLORER_UI}/transactions/${pending.txId}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Follow it
            </a>
          </p>
        </div>
      ) : !connected ? (
        <p className="font-pixel text-lg text-gray-500">Connect a wallet to trade.</p>
      ) : action === 'buy' ? (
        <PixelButton disabled={busy} onClick={onBuy}>
          {busy ? 'Signing…' : `Buy for ${listing ? toErg(listing.price) : ''} ERG`}
        </PixelButton>
      ) : action === 'cancel' ? (
        <PixelButton disabled={busy} onClick={onCancel}>
          {busy ? 'Signing…' : 'Cancel listing'}
        </PixelButton>
      ) : action === 'list' ? (
        <PixelButton disabled={busy} onClick={onList}>
          {busy ? 'Signing…' : 'List for sale'}
        </PixelButton>
      ) : action === 'offer' ? (
        <PixelButton disabled={busy} onClick={onOffer}>
          {busy ? 'Signing…' : 'Make an offer'}
        </PixelButton>
      ) : (
        <p className="font-pixel text-lg text-gray-500">You do not hold this token.</p>
      )}
    </PixelPanel>
  );
}

/**
 * Live bids on this token.
 *
 * Every one is funded ERG sitting in the offer contract, not an expression of
 * interest — which is why the holder gets an Accept button that settles it on
 * the spot, with no counterparty to wait for.
 *
 * Sorted best-first upstream. The net figure matters: the acceptor funds the
 * delivery box and the fee out of the bid, so the headline is not what they
 * walk away with.
 */
/** One row of a money breakdown: label left, figure right. */
function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`font-pixel text-lg ${strong ? 'text-gray-300' : 'text-gray-500'}`}>
        {label}
      </span>
      <span className={`font-pixel text-lg ${strong ? 'text-amber-300' : 'text-gray-400'}`}>
        {value}
      </span>
    </div>
  );
}

function Offers({
  offers,
  collectionBids,
  me,
  owned,
  listed,
  busy,
  onAccept,
  onWithdraw,
  onAcceptCollection,
  onMake,
  royalty,
}: {
  offers: Offer[];
  collectionBids: CollectionOffer[];
  /** Needed for the net: an accepted bid pays the creator out of the bid. */
  royalty: Royalty | null;
  me: string | null;
  owned: boolean;
  /** Set when this wallet has the piece listed, which Accept must undo. */
  listed?: { price: bigint };
  busy: boolean;
  onAccept: (offer: Offer) => void;
  onWithdraw: (offer: Offer) => void;
  onAcceptCollection: (offer: CollectionOffer) => void;
  onMake: () => void;
}) {
  return (
    <PixelPanel variant="inset" className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-pixel-display text-sm text-gray-400">OFFERS</h2>
        {me && !owned && (
          <PixelButton size="sm" disabled={busy} onClick={onMake}>
            Make an offer
          </PixelButton>
        )}
      </div>

      {/* Collection-wide bids first, and marked. They can be settled with any
          qualifying piece, so a holder reading this should know the money is
          not reserved for them — another holder can take it first. */}
      {collectionBids.length > 0 && (
        <ul className="mb-2 flex flex-col gap-2">
          {collectionBids.map((o) => {
            const net = offerNet(o.amount, royalty);
            // The builder refuses a bid below the floor, so a button offering
            // to accept one is promising something that cannot happen.
            const belowFloor = Boolean(royalty) && o.amount < MIN_ROYALTY_BID;
            const safe = net > 0n && !belowFloor;
            return (
              <li key={o.boxId} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-pixel text-xl text-emerald-400">
                    {toErg(o.amount)} ERG
                  </span>
                  <span className="ml-2 font-pixel text-base text-gray-500">
                    for any piece {o.bidder === me ? '· yours' : ''}
                  </span>
                  {owned && o.bidder !== me && (
                    <p className={`font-pixel text-base ${safe ? 'text-gray-500' : 'text-red-400'}`}>
                      {safe ? `you would receive ${toErg(net)} ERG` : 'cannot accept: costs exceed bid'}
                    </p>
                  )}
                </div>
                {owned && o.bidder !== me && (
                  <PixelButton size="sm" disabled={busy || !safe} onClick={() => onAcceptCollection(o)}>
                    Accept
                  </PixelButton>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {listed && (
        <p className="mb-2 font-pixel text-base text-gray-500">
          Accepting cancels your {toErg(listed.price)} ERG listing in the same
          transaction.
        </p>
      )}

      {offers.length === 0 ? (
        <p className="font-pixel text-lg text-gray-500">
          {collectionBids.length > 0
            ? 'No bid on this piece specifically.'
            : 'No offers yet. Anyone can bid on this token, listed or not.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {offers.map((o) => {
            const mine = o.bidder === me;
            const net = offerNet(o.amount, royalty);
            // The builder refuses a bid below the floor, so a button offering
            // to accept one is promising something that cannot happen.
            const belowFloor = Boolean(royalty) && o.amount < MIN_ROYALTY_BID;
            const safe = net > 0n && !belowFloor;
            return (
              <li key={o.boxId} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-pixel text-2xl text-amber-300">{toErg(o.amount)} ERG</span>
                  <span className="ml-2 font-pixel text-base text-gray-500" title={o.bidder}>
                    {mine ? 'you' : shortAddress(o.bidder)}
                  </span>
                  {owned && !mine && (
                    <p className={`font-pixel text-base ${safe ? 'text-gray-500' : 'text-red-400'}`}>
                      {safe
                        ? `you would receive ${toErg(net)} ERG`
                        : 'cannot accept: costs exceed bid'}
                    </p>
                  )}
                </div>
                {mine ? (
                  <PixelButton size="sm" disabled={busy} onClick={() => onWithdraw(o)}>
                    Withdraw
                  </PixelButton>
                ) : owned ? (
                  <PixelButton size="sm" disabled={busy || !safe} onClick={() => onAccept(o)}>
                    Accept
                  </PixelButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PixelPanel>
  );
}

function Provenance({
  tokenId,
  nft,
  issuer,
  listing,
}: {
  tokenId: string;
  nft: { contentHash?: string; imageUrl?: string };
  issuer: string;
  /** When present, the holder is already known and no lookup is needed. */
  listing?: { seller: string };
}) {
  const [holder, setHolder] = useState<{ address: string | null; listed?: boolean } | null>(null);

  useEffect(() => {
    // A listed token is held by the sale contract — that is what "listed" means,
    // and the listing we already have names the seller. Asking the explorer
    // again would spend a round trip to be told something we can prove from the
    // data in hand, on the page most likely to be opened repeatedly.
    if (listing) {
      return;
    }

    let cancelled = false;
    fetch(`/api/holder/${tokenId}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setHolder(d))
      .catch(() => !cancelled && setHolder({ address: null }));
    return () => {
      cancelled = true;
    };
  }, [tokenId, listing]);

  return (
    <PixelPanel variant="inset" className="p-3">
      <h2 className="mb-2 font-pixel-display text-sm text-gray-400">PROVENANCE</h2>
      <Field label="Token id" value={tokenId} mono />
      <Field label="Issued by" value={issuer} mono />
      <Field
        label="Held by"
        value={
          listing
            ? `the sale contract, listed by ${shortAddress(listing.seller)}`
            : holder === null
              ? 'checking…'
              : (holder.address ?? 'unknown')
        }
        mono={!listing && Boolean(holder?.address)}
      />
      {/* R8 is why serving the artwork from this domain is checkable rather
          than something the visitor has to take on faith. */}
      {nft.contentHash && <Field label="SHA-256 of artwork" value={nft.contentHash} mono />}
      {nft.imageUrl && <Field label="Canonical source" value={nft.imageUrl} mono />}
      <a
        href={`${EXPLORER_UI}/token/${tokenId}`}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block font-pixel text-lg text-amber-300 underline"
      >
        View on the Ergo explorer
      </a>
    </PixelPanel>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-1">
      <span className="font-pixel text-base text-gray-500">{label} </span>
      <span
        className={`font-pixel text-lg text-gray-300 ${mono ? 'break-all' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
