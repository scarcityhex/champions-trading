// contract.ts — the compiled scripts and where they live on each network.
//
// Ergo has no deploy step. A contract's address is DERIVED from its script, so
// these addresses already exist and always have; "launching" the marketplace
// just means being the first to send a box to one.
//
// The flip side is that editing a .es file by one character produces different
// addresses. Listings made under the old script stay under the old script —
// correct, since those sellers agreed to those terms — but the app would
// silently stop seeing them. So the values are pinned here and the contract
// tests recompile the sources and assert they still match. If those fail, the
// address moved, and that is a migration, not a typo.
//
// Pinned rather than compiled at runtime because @fleet-sdk/compiler carries
// the whole sigma interpreter; there is no reason to ship it to a browser to
// recompute a constant.

export type ErgoNetwork = 'mainnet' | 'testnet';

/**
 * Which network the app talks to.
 *
 * Testnet exists so the wallet-to-node path can be exercised with worthless
 * coins before it is trusted with real ones. The contract tests validate the
 * scripts under consensus rules; they cannot validate that Nautilus builds and
 * signs what we think it does, or that a real node accepts the result.
 *
 * Read once, at module load. A network that could change at runtime would mean
 * an address and a balance that disagree about which chain they are on.
 */
export const NETWORK: ErgoNetwork =
  process.env.NEXT_PUBLIC_ERGO_NETWORK === 'testnet' ? 'testnet' : 'mainnet';

/** Address-byte prefix per network, as Ergo encodes it. */
export const NETWORK_PREFIX = { mainnet: 0, testnet: 16 } as const;

/** contracts/sale.es — a seller locks a token and waits for ERG. */
export const SALE_ERGO_TREE =
  '193700d801d601e4c6a70408eb027201d1aea5d9010263ededed92c17202e4c6a7050593c27202d07201e6c67202040e93e4c67202040ec5a7';

/** contracts/offer.es — a bidder locks ERG and waits for a token. */
export const OFFER_ERGO_TREE =
  '194d010502d801d601e4c6a70408eb027201d1aea5d9010263ededed93c27202d07201aedb63087202d901044d0eed938c720401e4c6a7050e928c7204027300e6c67202040e93e4c67202040ec5a7';

/** The same two scripts, addressed on each network. */
export const ADDRESSES = {
  mainnet: {
    sale: 'BhRyuhANCEte3LK3mjjSgKBjcsLhC9Ms5Ka2TUW43kJk5JhfdjPHVoPRG6hFuxBpMz2cM7ZegPYTQefYQxkj',
    offer:
      'DpKxDXj2Aa6hewpAWktyiWKDBk7Dg4ttNLN4rdYvx9UdkRmcMhL1YKKXtwbpFUFNXWipaLmLME4Pf6oRHA1xdHP5Wm7aP21oW1NjpXud5LMrL12CjM',
  },
  testnet: {
    sale: '28wD6bdVybbJAZ27mHjAcrJBeTmkhEvC44NGjKPmLA9juD4vhrPguDdcLCfSCa5NKv4EZg9931uduP9KQCnMe',
    offer:
      '2MzJLhAKscc4rE3m1ncUHy38RoGEeLauDcqofBEQAmTWon11ccKuxrAJCgRDLrjLKwqgJwgA4smqcqUv7jh1TuLEoxESDyyBq9nwjd7fiLnFHQTkSPe',
  },
} as const;

export const SALE_ADDRESS = ADDRESSES[NETWORK].sale;
export const OFFER_ADDRESS = ADDRESSES[NETWORK].offer;

/** Explorer mirrors per network, in preference order. */
export const EXPLORERS = {
  mainnet: ['https://api.ergoplatform.com/api/v1', 'https://api.sigmaspace.io/api/v1'],
  // Testnet has one public explorer; there is no mirror to fall back to.
  testnet: ['https://api-testnet.ergoplatform.com/api/v1'],
} as const;

/** Where a human goes to verify a transaction. */
export const EXPLORER_UI =
  NETWORK === 'testnet'
    ? 'https://testnet.ergoplatform.com/en'
    : 'https://explorer.ergoplatform.com/en';
