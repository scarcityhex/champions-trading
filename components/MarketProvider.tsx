'use client';

// MarketProvider — wallet, order book and actions, shared across routes.
//
// Without this, navigating from the gallery to a token page would unmount the
// wallet hook and silently disconnect: the user would connect twice to do one
// thing. It also means one fetch of the order book per session instead of one
// per page.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useNautilus } from '@/lib/nautilus';
import { useMarketData, type MarketData } from '@/lib/useMarketData';
import { useMarket, type MarketState } from '@/lib/useMarket';
import { usePending, type PendingState } from '@/lib/usePending';

type Wallet = ReturnType<typeof useNautilus>;

type Market = {
  wallet: Wallet;
  data: MarketData;
  actions: MarketState;
  /** Signed but not yet visible on chain — see lib/usePending.ts. */
  pending: PendingState;
  /**
   * A one-shot request from the header for the gallery to show a particular
   * view — currently only "everything in my wallet".
   *
   * Passed through context rather than the URL because the gallery is a
   * statically prerendered page: reading search params there would force it
   * dynamic, or need a Suspense boundary, for a control that is not worth
   * either. The header also routes to `/`, so this works from a token page.
   *
   * Consumed and cleared by whoever acts on it, so it cannot fire twice.
   */
  viewRequest: 'wallet' | null;
  requestView: (v: 'wallet') => void;
  clearViewRequest: () => void;
};

const Ctx = createContext<Market | null>(null);

export function MarketProvider({ children }: { children: ReactNode }) {
  const wallet = useNautilus();
  const data = useMarketData();
  const pending = usePending(data, wallet.owned);
  // Every settled transaction re-reads the order book; the wallet re-reads
  // itself inside signAndSubmit.
  const actions = useMarket(wallet, data.refresh, pending.add);

  const [viewRequest, setViewRequest] = useState<'wallet' | null>(null);
  const requestView = useCallback((v: 'wallet') => setViewRequest(v), []);
  const clearViewRequest = useCallback(() => setViewRequest(null), []);

  return (
    <Ctx.Provider
      value={{ wallet, data, actions, pending, viewRequest, requestView, clearViewRequest }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useMarketContext(): Market {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMarketContext must be used inside <MarketProvider>');
  return ctx;
}
