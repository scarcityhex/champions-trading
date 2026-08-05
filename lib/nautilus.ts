'use client';

// nautilus.ts — the EIP-12 dApp connector.
//
// This is the whole extent of the app's relationship with a user's funds: it
// asks the wallet to build and sign; the wallet decides. No key, seed, or
// signature ever reaches this code or any server, which is what keeps the
// project outside custody entirely (docs/architecture.md §2).

import { useCallback, useEffect, useState } from 'react';
import type { EIP12UnsignedTransaction } from '@fleet-sdk/common';
import type { FleetBox } from './transactions';
import { NETWORK, type ErgoNetwork } from './contract';

type ErgoApi = {
  get_change_address(): Promise<string>;
  get_used_addresses(): Promise<string[]>;
  get_utxos(amount?: string, tokenId?: string): Promise<FleetBox[]>;
  get_current_height(): Promise<number>;
  sign_tx(tx: EIP12UnsignedTransaction): Promise<unknown>;
  submit_tx(tx: unknown): Promise<string>;
  sign_data?(address: string, message: string): Promise<unknown>;
};

declare global {
  interface Window {
    ergoConnector?: {
      nautilus?: {
        connect(opts?: { createErgoObject?: boolean }): Promise<boolean>;
        disconnect?(): Promise<void>;
        isConnected?(): Promise<boolean>;
      };
    };
    ergo?: ErgoApi;
  }
}

export type WalletState = {
  installed: boolean;
  address: string | null;
  connecting: boolean;
  error: string | null;
  /** Token ids the connected wallet currently holds. */
  owned: Set<string>;
  /** Spendable boxes, needed as inputs for every transaction we build. */
  utxos: FleetBox[];
  /**
   * The network the connected wallet is on, read from its own address.
   *
   * Ergo encodes the network in the address prefix — mainnet P2PK addresses
   * start with `9`, testnet ones with `3`. That makes the check free and
   * exact, with no extra call to the wallet.
   */
  walletNetwork: ErgoNetwork | null;
};

/**
 * True when the wallet is on a different chain than this build talks to.
 *
 * Worth blocking on rather than warning about. The contract addresses are
 * per-network, so a mismatch builds a transaction against a contract that does
 * not exist on the chain the wallet would broadcast to — at best rejected, at
 * worst a listing sent to an address nobody controls on that network.
 */
export const isWrongNetwork = (s: Pick<WalletState, 'walletNetwork'>): boolean =>
  s.walletNetwork !== null && s.walletNetwork !== NETWORK;

/** Mainnet P2PK addresses begin with 9; testnet ones with 3. */
export function networkOfAddress(address: string): ErgoNetwork | null {
  if (address.startsWith('9')) return 'mainnet';
  if (address.startsWith('3')) return 'testnet';
  return null;
}

/** Remembers that this browser has approved the site, so a reload can restore
 *  the session without asking again. Not a credential — just a hint. */
const CONNECTED_KEY = 'champions-trading:wallet-connected';

export function useNautilus() {
  const [state, setState] = useState<WalletState>({
    installed: false,
    address: null,
    connecting: false,
    error: null,
    owned: new Set(),
    utxos: [],
    walletNetwork: null,
  });

  // The extension injects `ergoConnector` after page scripts run, so a single
  // check on mount races it and reports "not installed" to users who have it.
  //
  // Once found, this also restores an existing session. Nautilus remembers the
  // permission it granted this origin, so `connect()` on an already-authorised
  // site resolves without prompting — the wallet state only looked lost because
  // it lived in React state that a reload discards. Reconnecting silently is
  // what stops every refresh from demanding a click.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;

    const id = setInterval(async () => {
      const nautilus = window.ergoConnector?.nautilus;
      if (!nautilus) {
        if (++tries > 20) clearInterval(id);
        return;
      }
      clearInterval(id);
      if (cancelled) return;
      setState((s) => ({ ...s, installed: true }));

      try {
        // Restore only a session this browser has had before.
        //
        // The guard used to be `isConnected()`, and it failed twice over. On a
        // build that does not expose the method, the optional call yields
        // undefined and the negation sent us straight out — never reconnecting,
        // which is the bug this fixes. And even where it exists it can report
        // false right after a reload: the approval lives in the extension,
        // while the `ergo` object does not survive the page.
        //
        // Our own flag is the reliable signal. connect() resolves without a
        // prompt for an origin the user already approved, and a first-time
        // visitor never reaches it because the flag was never set.
        if (localStorage.getItem(CONNECTED_KEY) !== 'true') return;
        if (!(await nautilus.connect({ createErgoObject: true }))) {
          // Approval was revoked in the wallet; stop retrying on every load.
          localStorage.removeItem(CONNECTED_KEY);
          return;
        }
        if (cancelled || !window.ergo) return;
        const address = await window.ergo.get_change_address();
        const utxos = await window.ergo.get_utxos();
        const owned = new Set<string>();
        for (const box of utxos) {
          for (const asset of box.assets ?? []) owned.add(asset.tokenId);
        }
        if (!cancelled) {
          setState({
            installed: true,
            address,
            connecting: false,
            error: null,
            owned,
            utxos,
            walletNetwork: networkOfAddress(address),
          });
        }
      } catch {
        // A refused or expired session is not an error worth showing; the
        // Connect button is right there.
      }
    }, 100);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /**
   * Re-read balance and boxes, and hand the fresh boxes back.
   *
   * The wallet does not push updates, so this has to run both after anything
   * that spends AND immediately before anything is built. State alone is not
   * enough for the second case: React has not re-rendered by the time the
   * builder runs, so the caller needs the boxes returned directly.
   *
   * Building from stale boxes is the failure this exists to prevent, and it is
   * a quiet one — the wallet signs whatever it is given, `submit_tx` hands back
   * a transaction id, and the node then drops a transaction that spends inputs
   * which no longer exist. From the outside it looks like nothing happened.
   */
  const refresh = useCallback(async (): Promise<FleetBox[] | null> => {
    if (!window.ergo) return null;
    try {
      const utxos = await window.ergo.get_utxos();
      const owned = new Set<string>();
      for (const box of utxos) {
        for (const asset of box.assets ?? []) owned.add(asset.tokenId);
      }
      setState((s) => ({ ...s, utxos, owned }));
      return utxos;
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'Could not read wallet.' }));
      return null;
    }
  }, []);

  const connect = useCallback(async () => {
    const nautilus = window.ergoConnector?.nautilus;
    if (!nautilus) {
      setState((s) => ({ ...s, error: 'Nautilus not found. Install the extension to trade.' }));
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const granted = await nautilus.connect({ createErgoObject: true });
      if (!granted) throw new Error('Connection refused in the wallet.');
      const address = await window.ergo!.get_change_address();
      const utxos = await window.ergo!.get_utxos();
      const owned = new Set<string>();
      for (const box of utxos) {
        for (const asset of box.assets ?? []) owned.add(asset.tokenId);
      }
      try {
        // Recorded only after a connection actually succeeded, so the reload
        // path never tries to restore something that was never granted.
        localStorage.setItem(CONNECTED_KEY, 'true');
      } catch {
        /* private mode: the session simply will not survive a reload */
      }
      setState({
        installed: true,
        address,
        connecting: false,
        error: null,
        owned,
        utxos,
        walletNetwork: networkOfAddress(address),
      });
    } catch (e) {
      setState((s) => ({
        ...s,
        connecting: false,
        error: e instanceof Error ? e.message : 'Could not connect.',
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      localStorage.removeItem(CONNECTED_KEY);
    } catch {
      /* nothing to clear */
    }
    await window.ergoConnector?.nautilus?.disconnect?.();
    setState((s) => ({ ...s, address: null, owned: new Set(), utxos: [], walletNetwork: null }));
  }, []);

  /**
   * Hand a built transaction to the wallet and broadcast what comes back.
   *
   * The two steps are deliberately not collapsed: sign_tx is where the user
   * sees what they are agreeing to and can refuse, and a refusal must read as a
   * cancelled action rather than an error. Only a signed transaction is
   * submitted, and only the wallet can produce one.
   */
  const signAndSubmit = useCallback(
    async (tx: EIP12UnsignedTransaction): Promise<string> => {
      if (!window.ergo) throw new Error('Wallet not connected.');
      const signed = await window.ergo.sign_tx(tx);
      const txId = await window.ergo.submit_tx(signed);
      await refresh();
      return txId;
    },
    [refresh],
  );

  /** Current chain height, which every transaction needs as its creation height. */
  const currentHeight = useCallback(async (): Promise<number> => {
    if (!window.ergo) throw new Error('Wallet not connected.');
    return window.ergo.get_current_height();
  }, []);

  return { ...state, connect, disconnect, refresh, signAndSubmit, currentHeight };
}

/** `9hveS5…NxiNbQ` — addresses are 51 chars and never fit a button. */
export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
