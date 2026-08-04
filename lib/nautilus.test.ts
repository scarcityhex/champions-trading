// nautilus.test.ts — the network guard.
//
// The last thing standing between a user and signing a transaction against a
// contract address that does not exist on their chain. Cheap to test, and the
// failure is silent without it: both networks render an identical UI.

import { describe, expect, it } from 'vitest';
import { networkOfAddress, isWrongNetwork } from './nautilus';
import { ADDRESSES, NETWORK } from './contract';

describe('networkOfAddress', () => {
  it('reads the network out of the address prefix', () => {
    // Real addresses from the audited collections and from the contract pins.
    expect(networkOfAddress('9hyxVZLRuJ1zkgYfMPYHLTnBixAgZfLVwxioWhAXWTD3bLzmntC')).toBe('mainnet');
    expect(networkOfAddress('3WvsT2Gm4EpsM9Pg18PdY6XyhNNMqXDsvJTbbf6ihLvAmSb7u5RN')).toBe('testnet');
  });

  it('returns null for anything that is not a P2PK address', () => {
    // Contract addresses are P2S and carry no `9`/`3` prefix, so they must not
    // be mistaken for a wallet on some network.
    expect(networkOfAddress(ADDRESSES.mainnet.sale)).toBeNull();
    expect(networkOfAddress('')).toBeNull();
  });
});

describe('isWrongNetwork', () => {
  it('is false before a wallet is connected', () => {
    // Nothing to disagree with yet; blocking here would disable the UI for
    // every visitor who has not connected.
    expect(isWrongNetwork({ walletNetwork: null })).toBe(false);
  });

  it('is false when the wallet matches the build', () => {
    expect(isWrongNetwork({ walletNetwork: NETWORK })).toBe(false);
  });

  it('is true on a mismatch', () => {
    const other = NETWORK === 'mainnet' ? 'testnet' : 'mainnet';
    expect(isWrongNetwork({ walletNetwork: other })).toBe(true);
  });
});
