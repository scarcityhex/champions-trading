'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import PixelPanel from '@/components/ui/PixelPanel';
import PixelButton from '@/components/ui/PixelButton';
import Header from '@/components/Header';
import { BY_TOKEN_ID, VISIBLE_COLLECTIONS } from '@/lib/collections';
import { toErg } from '@/lib/explorer';
import { shortAddress } from '@/lib/nautilus';
import history from '@/data/history.json';
import type { Trade } from '@/lib/history';
import { EXPLORER_UI } from '@/lib/contract';

const PAGE = 40;

/** Collections hidden from browsing stay hidden here too, so Activity and the
 *  gallery never disagree about what this venue offers. */
const VISIBLE_TOKENS = new Set(VISIBLE_COLLECTIONS.flatMap((c) => c.tokens.map((t) => t.tokenId)));

export default function ActivityPage() {
  const [shown, setShown] = useState(PAGE);

  const trades = useMemo(
    () => (history.trades as Trade[]).filter((t) => VISIBLE_TOKENS.has(t.tokenId)),
    [],
  );

  const stats = useMemo(() => {
    if (trades.length === 0) return null;
    const total = trades.reduce((sum, t) => sum + BigInt(t.price), 0n);
    return { count: trades.length, volume: total, average: total / BigInt(trades.length) };
  }, [trades]);

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="mx-auto max-w-5xl">
        <Header />

        <PixelPanel className="p-4">
          <h1 className="mb-3 font-pixel-display text-sm text-amber-300 md:text-base">ACTIVITY</h1>

          {stats && (
            <PixelPanel variant="inset" className="mb-4 flex flex-wrap gap-x-6 gap-y-1 p-3">
              <Stat label="TRADES" value={String(stats.count)} />
              <Stat label="VOLUME" value={`${toErg(stats.volume)} ERG`} />
              <Stat label="AVERAGE" value={`${toErg(stats.average)} ERG`} />
            </PixelPanel>
          )}

          {trades.length === 0 ? (
            <PixelPanel variant="inset" className="p-4">
              <p className="mb-2 font-pixel text-xl text-gray-300">Nothing has traded yet.</p>
              {/* Worth stating plainly rather than showing an ambiguous empty
                  table: these contracts are new, so an empty history is the
                  honest state, not a loading failure. */}
              <p className="font-pixel text-lg text-gray-500">
                This page is built from settled transactions on chain, refreshed periodically. It
                fills in as trades happen.
              </p>
            </PixelPanel>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse">
                  <thead>
                    <tr className="text-left">
                      {['ITEM', 'PRICE', 'FROM', 'TO', 'WHEN', ''].map((h) => (
                        <th key={h} className="pb-2 font-pixel text-base font-normal text-gray-500">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.slice(0, shown).map((t) => (
                      <Row key={t.boxId} trade={t} />
                    ))}
                  </tbody>
                </table>
              </div>

              {shown < trades.length && (
                <div className="mt-4 flex justify-center">
                  <PixelButton onClick={() => setShown((n) => n + PAGE)}>
                    Load more ({trades.length - shown} left)
                  </PixelButton>
                </div>
              )}
            </>
          )}

          {history.updatedAt && (
            <p className="mt-4 font-pixel text-base text-gray-600">
              Indexed to height {history.lastHeight} ·{' '}
              {new Date(history.updatedAt).toLocaleString()}
            </p>
          )}
        </PixelPanel>
      </div>
    </main>
  );
}

function Row({ trade }: { trade: Trade }) {
  const nft = BY_TOKEN_ID.get(trade.tokenId);
  return (
    <tr className="border-t" style={{ borderColor: '#2e2010' }}>
      <td className="py-2 pr-3">
        <Link
          href={`/token/${trade.tokenId}`}
          className="font-pixel text-lg text-gray-200 hover:text-amber-300"
        >
          {nft?.name ?? `${trade.tokenId.slice(0, 10)}…`}
        </Link>
      </td>
      <td className="py-2 pr-3 font-pixel text-lg text-amber-300">
        {toErg(BigInt(trade.price))} ERG
      </td>
      <td className="py-2 pr-3 font-pixel text-lg text-gray-400" title={trade.seller}>
        {shortAddress(trade.seller)}
      </td>
      <td className="py-2 pr-3 font-pixel text-lg text-gray-400" title={trade.buyer}>
        {shortAddress(trade.buyer)}
      </td>
      <td className="py-2 pr-3 font-pixel text-lg text-gray-500">
        {new Date(trade.timestamp).toLocaleDateString()}
        {/* An accepted bid and a bought listing are both trades, but they say
            different things about who moved first — worth keeping visible. */}
        {trade.kind === 'offerAccepted' && (
          <span className="ml-1 text-gray-600">(offer)</span>
        )}
      </td>
      <td className="py-2">
        <a
          href={`${EXPLORER_UI}/transactions/${trade.txId}`}
          target="_blank"
          rel="noreferrer"
          className="font-pixel text-lg text-gray-600 underline hover:text-amber-300"
        >
          tx
        </a>
      </td>
    </tr>
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
