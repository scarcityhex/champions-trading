'use client';

import { useEffect, useMemo, useState } from 'react';
import PixelPanel from '@/components/ui/PixelPanel';
import PixelButton from '@/components/ui/PixelButton';
import Header from '@/components/Header';
import TokenCard, { actionFor, type CardAction } from '@/components/TokenCard';
import AmountDialog from '@/components/AmountDialog';
import { isMine } from '@/lib/usePending';
import TraitFilters, {
  matchesTraits,
  activeCount,
  type TraitSelection,
} from '@/components/TraitFilters';
import { useMarketContext } from '@/components/MarketProvider';
import { bestOffer } from '@/lib/useMarketData';
import { COLLECTION_ROOTS } from '@/lib/contract';
import {
  VISIBLE_COLLECTIONS,
  rarityPercentiles,
  matchesEdition,
  type Nft,
} from '@/lib/collections';
import { toErg } from '@/lib/explorer';
import { shortAddress } from '@/lib/nautilus';

const PAGE = 24;

type Filter = 'all' | 'forSale' | 'mine';

/** How the grid is ordered. */
type Sort = 'numeric' | 'rarest' | 'cheapest';

const SORT_LABELS: Record<Sort, string> = {
  numeric: 'number',
  rarest: 'rarest',
  cheapest: 'cheapest',
};

export default function Home() {
  const { wallet, data, actions, pending, viewRequest, clearViewRequest } = useMarketContext();
  // Opens on the combined view: the site covers three collections, and landing
  // inside one of them presents a third of the inventory as if it were all.
  const [tab, setTab] = useState(-1);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);
  const [dialog, setDialog] = useState<{ mode: 'list' | 'offer'; nft: Nft } | null>(null);
  const [bidOnCollection, setBidOnCollection] = useState(false);
  const [traits, setTraits] = useState<TraitSelection>({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('numeric');

  /** -1 is the combined view across every visible collection. */
  const isAll = tab < 0;
  const collection = isAll ? null : VISIBLE_COLLECTIONS[tab];
  const shownCollections = isAll ? VISIBLE_COLLECTIONS : [VISIBLE_COLLECTIONS[tab]];

  // A token alone is not enough to render a card: the image path and the rarity
  // rank both depend on which collection it came from. Pairing them here means
  // no lookup by tokenId further down.
  const entries = useMemo(() => {
    const perCollection = shownCollections.map((c) => {
      // Ranked within its own collection, always. A percentile across three
      // collections would compare traits that do not exist in each other.
      const ranks = rarityPercentiles(c);
      return c.live.map((nft) => ({ nft, collection: c, rarity: ranks.get(nft.tokenId) }));
    });

    if (perCollection.length === 1) return perCollection[0];

    // Interleaved rather than concatenated. Ergo Champions alone is 493 pieces,
    // so a grouped list would put Mage Champions eighty pages down and a view
    // called "all collections" would look like one collection.
    const merged = perCollection[0].slice(0, 0);
    const longest = Math.max(...perCollection.map((l) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const list of perCollection) {
        if (i < list.length) merged.push(list[i]);
      }
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const visible = useMemo(() => {
    const base = entries.filter(({ nft }) => {
      if (filter === 'forSale') return data.listings.has(nft.tokenId);
      if (filter === 'mine') {
        // Held, listed, bid on, or signed and waiting for a block. The rule
        // lives in isMine so it can be tested — the pending clause was once
        // dropped here by a bad edit and nothing caught it.
        return isMine(nft.tokenId, wallet, data, pending.byToken);
      }
      return true;
    });

    // Trait filters are hidden in the combined view, so `traits` is empty there
    // and this is a no-op. Trait names are not shared between collections —
    // "robes" exists in Mage Champions and nowhere else — so a cross-collection
    // trait filter could only ever mean "match one collection, exclude the
    // others", which is not what a filter appears to promise.
    const filtered = base
      .filter(({ nft }) => matchesTraits(nft.attributes, traits))
      .filter(({ nft }) => matchesEdition(nft, search));

    if (sort === 'numeric') return filtered;

    // Copied before sorting: `entries` is memoised per tab and sorting in place
    // would permanently reorder it, so switching back to "number" would not
    // restore the original order.
    const sorted = [...filtered];

    if (sort === 'rarest') {
      // Undefined rank sorts last rather than first — a token with no rarity is
      // not the rarest, and treating a missing value as 0 would put it on top.
      sorted.sort((a, b) => (a.rarity ?? Infinity) - (b.rarity ?? Infinity));
      return sorted;
    }

    // Cheapest listed first, then everything unlisted. An unlisted piece has no
    // price, so it cannot be cheap — putting it above a real listing would be a
    // lie about what is available.
    sorted.sort((a, b) => {
      const pa = data.listings.get(a.nft.tokenId)?.price;
      const pb = data.listings.get(b.nft.tokenId)?.price;
      if (pa === undefined && pb === undefined) return 0;
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa === pb ? 0 : pa < pb ? -1 : 1;
    });
    return sorted;
  }, [entries, filter, traits, search, sort, data.listings, data.offers, wallet, pending.byToken]);

  const stats = useMemo(() => {
    let live = 0;
    let minted = 0;
    let listed = 0;
    let floor: bigint | null = null;
    const traitTypes = new Set<string>();

    for (const c of shownCollections) {
      live += c.live.length;
      minted += c.tokens.length;
      for (const t of c.live) {
        for (const a of t.attributes ?? []) traitTypes.add(a.trait_type);
        const l = data.listings.get(t.tokenId);
        if (!l) continue;
        listed++;
        if (floor === null || l.price < floor) floor = l.price;
      }
    }
    return { tokens: live, burned: minted - live, traits: traitTypes.size, listed, floor };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, data.listings]);

  const pick = (i: number) => {
    setTab(i);
    setShown(PAGE);
    // Trait names differ between collections ("robes" does not exist in Ergo
    // Champions), so a filter carried across tabs would silently match nothing.
    setTraits({});
    setSearch('');
  };
  const setF = (f: Filter) => {
    setFilter(f);
    setShown(PAGE);
  };

  // Clicking the wallet address in the header means "show me everything I
  // have", which is every collection crossed with the Mine filter. Filters and
  // search are cleared too: leaving a trait filter on would answer a different
  // question than the one the click asked.
  useEffect(() => {
    if (viewRequest !== 'wallet') return;
    setTab(-1);
    setFilter('mine');
    setTraits({});
    setSearch('');
    setShown(PAGE);
    clearViewRequest();
  }, [viewRequest, clearViewRequest]);

  const act = (nft: Nft, action: Exclude<CardAction, null>) => {
    const live = data.listings.get(nft.tokenId);
    if (action === 'list' || action === 'offer') setDialog({ mode: action, nft });
    else if (action === 'buy' && live) actions.buy(live);
    else if (action === 'cancel' && live) actions.cancel(live);
  };

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="mx-auto max-w-6xl">
        <Header />

        <PixelPanel className="p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            <PixelButton active={isAll} onClick={() => pick(-1)}>
              All collections
            </PixelButton>
            {VISIBLE_COLLECTIONS.map((c, i) => (
              <PixelButton key={c.key} active={i === tab} onClick={() => pick(i)}>
                {c.name}
              </PixelButton>
            ))}
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <PixelButton size="sm" active={filter === 'all'} onClick={() => setF('all')}>
              All
            </PixelButton>
            <PixelButton size="sm" active={filter === 'forSale'} onClick={() => setF('forSale')}>
              For sale
            </PixelButton>
            <PixelButton
              size="sm"
              active={filter === 'mine'}
              disabled={!wallet.address}
              onClick={() => setF('mine')}
              title={wallet.address ? undefined : 'Connect a wallet'}
            >
              Mine
            </PixelButton>

            <PixelPanel variant="inset" className="flex items-center gap-1 px-2 py-0.5">
              <span className="font-pixel text-lg text-gray-500">#</span>
              <input
                value={search}
                inputMode="numeric"
                placeholder="number"
                aria-label="Find by edition number"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShown(PAGE);
                }}
                onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
                className="w-24 bg-transparent font-pixel text-lg text-amber-300 outline-none placeholder:text-gray-600"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="font-pixel text-lg text-gray-500 hover:text-amber-300"
                >
                  ✕
                </button>
              )}
            </PixelPanel>

            <span className="ml-1 self-center font-pixel text-lg text-gray-500">sort</span>
            {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
              <PixelButton
                key={s}
                size="sm"
                active={sort === s}
                onClick={() => {
                  setSort(s);
                  setShown(PAGE);
                }}
                title={
                  s === 'cheapest'
                    ? 'Listed pieces first, cheapest to dearest; unlisted after'
                    : s === 'rarest'
                      ? 'Rarest first, ranked within each collection'
                      : 'By edition number'
                }
              >
                {SORT_LABELS[s]}
              </PixelButton>
            ))}
          </div>

          {/* Hidden in the combined view: trait names are not shared between
              collections, so a dropdown built from one would silently exclude
              the other two. The #number search stays, since an edition number
              means the same thing everywhere. */}
          {collection && (
            <TraitFilters
              collection={collection}
              selection={traits}
              onChange={(next) => {
                setTraits(next);
                setShown(PAGE);
              }}
            />
          )}

          {/* A bid on any piece, not a particular one. Only inside a single
              collection: the bid names one Merkle root, so "all collections"
              has nothing to name. */}
          {collection && (
            <PixelPanel variant="inset" className="mb-4 flex flex-wrap items-center gap-3 p-3">
              <span className="font-pixel text-lg text-gray-400">
                Bids on any piece:{' '}
                <span className="text-emerald-400">
                  {(data.collectionOffers.get(collection.key) ?? []).length}
                </span>
                {(data.collectionOffers.get(collection.key) ?? []).length > 0 && (
                  <>
                    {' · best '}
                    <span className="text-emerald-400">
                      {toErg(data.collectionOffers.get(collection.key)![0].amount)} ERG
                    </span>
                  </>
                )}
              </span>
              <PixelButton
                size="sm"
                disabled={!wallet.address}
                onClick={() => setBidOnCollection(true)}
                title={
                  wallet.address
                    ? 'Bid on any piece from this collection'
                    : 'Connect a wallet'
                }
              >
                Bid on any
              </PixelButton>
              {(data.collectionOffers.get(collection.key) ?? [])
                .filter((o) => o.bidder === wallet.address)
                .map((o) => (
                  <PixelButton
                    key={o.boxId}
                    size="sm"
                    onClick={() => actions.withdrawCollectionOffer(o)}
                    title="Take your locked ERG back; the bid stops applying"
                  >
                    Withdraw your {toErg(o.amount)} ERG bid
                  </PixelButton>
                ))}
            </PixelPanel>
          )}

          <PixelPanel variant="inset" className="mb-4 flex flex-wrap gap-x-6 gap-y-1 p-3">
            <Stat
              label={activeCount(traits) > 0 ? 'MATCHING' : 'TOKENS'}
              value={
                activeCount(traits) > 0
                  ? `${visible.length} of ${stats.tokens}`
                  : String(stats.tokens)
              }
            />
            {/* Stated rather than hidden: a collector who knows the mint size
                would otherwise think the catalogue is incomplete. */}
            {stats.burned > 0 && <Stat label="BURNED" value={String(stats.burned)} />}
            <Stat label="TRAITS" value={String(stats.traits)} />
            <Stat label="LISTED" value={data.loading ? '…' : String(stats.listed)} />
            <Stat label="FLOOR" value={stats.floor === null ? '—' : `${toErg(stats.floor)} ERG`} />
            {collection ? (
              <Stat
                label="ISSUER"
                value={collection.issuer ? shortAddress(collection.issuer) : '—'}
              />
            ) : (
              <Stat label="COLLECTIONS" value={String(VISIBLE_COLLECTIONS.length)} />
            )}
          </PixelPanel>

          {data.error && (
            <PixelPanel variant="inset" className="mb-4 p-3">
              <p className="font-pixel text-lg text-red-400">
                Could not read the order book ({data.error}). Showing the catalog without prices.
              </p>
            </PixelPanel>
          )}

          {visible.length === 0 ? (
            <p className="py-8 text-center font-pixel text-xl text-gray-500">
              {/* The trait message wins when traits are active: saying "nothing
                  listed" while listings exist that simply do not match the
                  filter sends the user hunting a problem that is not there. */}
              {search.trim()
                ? `No surviving #${search.trim().replace(/^#/, '')} in this collection.`
                : activeCount(traits) > 0
                ? filter === 'all'
                  ? 'No surviving token has that combination of traits.'
                  : 'Nothing matches those traits in this view. Try clearing a filter.'
                : filter === 'forSale'
                  ? 'Nothing listed in this collection yet.'
                  : filter === 'mine'
                    ? 'No tokens from this collection in your wallet.'
                    : 'Nothing here.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {visible.slice(0, shown).map(({ nft, collection: c, rarity }) => {
                const live = data.listings.get(nft.tokenId);
                return (
                  <TokenCard
                    key={nft.tokenId}
                    nft={nft}
                    collection={c}
                    dir={c.dir}
                    href={`/token/${nft.tokenId}`}
                    listing={live}
                    topOffer={bestOffer(nft.tokenId, c.key, data, wallet.address) ?? undefined}
                    rarity={rarity}
                    pending={pending.byToken.get(nft.tokenId)}
                    action={actionFor(live, wallet.owned.has(nft.tokenId), wallet.address)}
                    busy={actions.busy === nft.tokenId}
                    onAct={(a) => act(nft, a)}
                  />
                );
              })}
            </div>
          )}

          {shown < visible.length && (
            <div className="mt-4 flex justify-center">
              <PixelButton onClick={() => setShown((n) => n + PAGE)}>
                Load more ({visible.length - shown} left)
              </PixelButton>
            </div>
          )}
        </PixelPanel>
      </div>

      {bidOnCollection && collection && (
        <AmountDialog
          mode="offer"
          nft={{ ...collection.live[0], name: `any ${collection.name}` }}
          busy={actions.busy === `collection:${COLLECTION_ROOTS[collection.key]}`}
          onClose={() => setBidOnCollection(false)}
          onConfirm={(amount: bigint) => {
            actions.collectionOffer(COLLECTION_ROOTS[collection.key], amount);
            setBidOnCollection(false);
          }}
        />
      )}

      {dialog && (
        <AmountDialog
          mode={dialog.mode}
          nft={dialog.nft}
          busy={actions.busy === dialog.nft.tokenId}
          onClose={() => setDialog(null)}
          onConfirm={(amount: bigint) => {
            if (dialog.mode === 'list') actions.list(dialog.nft.tokenId, amount);
            else actions.offer(dialog.nft.tokenId, amount);
            setDialog(null);
          }}
        />
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-pixel text-base text-gray-500">{label} </span>
      <span className="font-pixel text-xl text-gray-200">{value}</span>
    </div>
  );
}
