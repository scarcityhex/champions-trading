'use client';

// MarketProvider — wallet, order book and actions, shared across routes.
//
// Without this, navigating from the gallery to a token page would unmount the
// wallet hook and silently disconnect: the user would connect twice to do one
// thing. It also means one fetch of the order book per session instead of one
// per page.

import { createContext, useContext, type ReactNode } from 'react';
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
};

const Ctx = createContext<Market | null>(null);

export function MarketProvider({ children }: { children: ReactNode }) {
  const wallet = useNautilus();
  const data = useMarketData();
  const pending = usePending(data, wallet.owned);
  // Every settled transaction re-reads the order book; the wallet re-reads
  // itself inside signAndSubmit.
  const actions = useMarket(wallet, data.refresh, pending.add);

  return <Ctx.Provider value={{ wallet, data, actions, pending }}>{children}</Ctx.Provider>;
}

export function useMarketContext(): Market {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useMarketContext must be used inside <MarketProvider>');
  return ctx;
}
