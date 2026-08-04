'use client';

import { useMemo, useState } from 'react';
import PixelPanel from '@/components/ui/PixelPanel';
import PixelButton from '@/components/ui/PixelButton';
import Header from '@/components/Header';
import TokenCard, { actionFor, type CardAction } from '@/components/TokenCard';
import AmountDialog from '@/components/AmountDialog';
import TraitFilters, {
  matchesTraits,
  activeCount,
  type TraitSelection,
} from '@/components/TraitFilters';
import { useMarketContext } from '@/components/MarketProvider';
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

export default function Home() {
  const { wallet, data, actions, pending } = useMarketContext();
  const [tab, setTab] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);
  const [dialog, setDialog] = useState<{ mode: 'list' | 'offer'; nft: Nft } | null>(null);
  const [traits, setTraits] = useState<TraitSelection>({});
  const [search, setSearch] = useState('');

  const collection = VISIBLE_COLLECTIONS[tab];
  const rarity = useMemo(() => rarityPercentiles(collection), [collection]);

  const tokens = useMemo(() => {
    const base = (() => {
      if (filter === 'forSale') {
        return collection.live.filter((t) => data.listings.has(t.tokenId));
      }
      if (filter === 'mine') {
        // "Mine" covers held, listed, or bid on. A token in the sale contract
        // is still the seller's in every sense that matters, and a funded offer
        // is ERG already out of the wallet — both are things a user needs to
        // find again, and neither shows up in a plain balance.
        return collection.live.filter(
          (t) =>
            wallet.owned.has(t.tokenId) ||
            data.listings.get(t.tokenId)?.seller === wallet.address ||
            data.offers.get(t.tokenId)?.some((o) => o.bidder === wallet.address),
        );
      }
      return collection.live;
    })();

    const byTraits = base.filter((t) => matchesTraits(t.attributes, traits));

    return byTraits.filter((t) => matchesEdition(t, search));
  }, [
    collection,
    filter,
    traits,
    search,
    data.listings,
    data.offers,
    wallet.owned,
    wallet.address,
    pending.byToken,
  ]);

  const stats = useMemo(() => {
    const traits = new Set(
      collection.live.flatMap((t) => (t.attributes ?? []).map((a) => a.trait_type)),
    );
    let listed = 0;
    let floor: bigint | null = null;
    for (const t of collection.live) {
      const l = data.listings.get(t.tokenId);
      if (!l) continue;
      listed++;
      if (floor === null || l.price < floor) floor = l.price;
    }
    return {
      tokens: collection.live.length,
      burned: collection.tokens.length - collection.live.length,
      traits: traits.size,
      listed,
      floor,
    };
  }, [collection, data.listings]);

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
          </div>

          <TraitFilters
            collection={collection}
            selection={traits}
            onChange={(next) => {
              setTraits(next);
              setShown(PAGE);
            }}
          />

          <PixelPanel variant="inset" className="mb-4 flex flex-wrap gap-x-6 gap-y-1 p-3">
            <Stat
              label={activeCount(traits) > 0 ? 'MATCHING' : 'TOKENS'}
              value={
                activeCount(traits) > 0
                  ? `${tokens.length} of ${stats.tokens}`
                  : String(stats.tokens)
              }
            />
            {/* Stated rather than hidden: a collector who knows the mint size
                would otherwise think the catalogue is incomplete. */}
            {stats.burned > 0 && <Stat label="BURNED" value={String(stats.burned)} />}
            <Stat label="TRAITS" value={String(stats.traits)} />
            <Stat label="LISTED" value={data.loading ? '…' : String(stats.listed)} />
            <Stat label="FLOOR" value={stats.floor === null ? '—' : `${toErg(stats.floor)} ERG`} />
            <Stat label="ISSUER" value={collection.issuer ? shortAddress(collection.issuer) : '—'} />
          </PixelPanel>

          {data.error && (
            <PixelPanel variant="inset" className="mb-4 p-3">
              <p className="font-pixel text-lg text-red-400">
                Could not read the order book ({data.error}). Showing the catalog without prices.
              </p>
            </PixelPanel>
          )}

          {tokens.length === 0 ? (
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
              {tokens.slice(0, shown).map((t) => {
                const live = data.listings.get(t.tokenId);
                return (
                  <TokenCard
                    key={t.tokenId}
                    nft={t}
                    dir={collection.dir}
                    href={`/token/${t.tokenId}`}
                    listing={live}
                    topOffer={data.offers.get(t.tokenId)?.[0]?.amount}
                    rarity={rarity.get(t.tokenId)}
                    pending={pending.byToken.get(t.tokenId)}
                    action={actionFor(live, wallet.owned.has(t.tokenId), wallet.address)}
                    busy={actions.busy === t.tokenId}
                    onAct={(a) => act(t, a)}
                  />
                );
              })}
            </div>
          )}

          {shown < tokens.length && (
            <div className="mt-4 flex justify-center">
              <PixelButton onClick={() => setShown((n) => n + PAGE)}>
                Load more ({tokens.length - shown} left)
              </PixelButton>
            </div>
          )}
        </PixelPanel>
      </div>

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
