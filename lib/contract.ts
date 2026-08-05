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
const configuredNetwork = process.env.NEXT_PUBLIC_ERGO_NETWORK ?? 'mainnet';
if (configuredNetwork !== 'mainnet' && configuredNetwork !== 'testnet') {
  throw new Error(
    'NEXT_PUBLIC_ERGO_NETWORK must be explicitly set to "mainnet" or "testnet"; ' +
      `received ${JSON.stringify(configuredNetwork)}.`,
  );
}

// Preserve the original local behavior: mainnet when unset. Typos still fail
// instead of silently selecting a different network.
export const NETWORK: ErgoNetwork = configuredNetwork;

/** Address-byte prefix per network, as Ergo encodes it. */
export const NETWORK_PREFIX = { mainnet: 0, testnet: 16 } as const;

/** contracts/sale.es — a seller locks a token and waits for ERG. */
export const SALE_ERGO_TREE =
  '193700d801d601e4c6a70408eb027201d1aea5d9010263ededed92c17202e4c6a7050593c27202d07201e6c67202040e93e4c67202040ec5a7';

/** contracts/collection-offer.es — a bidder locks ERG for ANY piece from one
 *  collection, membership proven against a Merkle root in R5. */
export const COLLECTION_OFFER_ERGO_TREE =
  '19a3010205020100d803d601e4c6a70408d602e3000ed603e3010c490eeb027201d195ede67202e67203d801d604e47202ed93b0e47203cb7204d901053c0e490ed803d6078c720502d6088c720701d6098c720501958c720702cbb372087209cbb372097208e4c6a7050eaea5d9010563ededed93c27205d07201aedb63087205d901074d0eed938c7207017204928c7207027300e6c67205040e93e4c67205040ec5a77301';

/** contracts/offer.es — a bidder locks ERG and waits for a token. */
export const OFFER_ERGO_TREE =
  '194d010502d801d601e4c6a70408eb027201d1aea5d9010263ededed93c27202d07201aedb63087202d901044d0eed938c720401e4c6a7050e928c7204027300e6c67202040e93e4c67202040ec5a7';

/** The three scripts, addressed on each network. */
export const ADDRESSES = {
  mainnet: {
    sale: 'BhRyuhANCEte3LK3mjjSgKBjcsLhC9Ms5Ka2TUW43kJk5JhfdjPHVoPRG6hFuxBpMz2cM7ZegPYTQefYQxkj',
    offer:
      'DpKxDXj2Aa6hewpAWktyiWKDBk7Dg4ttNLN4rdYvx9UdkRmcMhL1YKKXtwbpFUFNXWipaLmLME4Pf6oRHA1xdHP5Wm7aP21oW1NjpXud5LMrL12CjM',
    collectionOffer:
      '6yz51M1S226iGvLQmU77H86dbo2xdujnDMwWGV3m8Tk58hobtJ7V4PXi6ANqNRippGEXGqavND9qbrekTPXtcYEnJKLnWQQejTh7c7mr3AswSP9VX3jHFq6Qz9VRdxFcZyZwuGihbbcCZBaFhKRLdRv4K6jDw9iuuQ2NbMwEtWDo87p6NyUihPj7h6ZmLpWAcW26ti9VCEdT4V4VhhqgBJ5bTtzRHBkERiPoLQf86',
  },
  testnet: {
    sale: '28wD6bdVybbJAZ27mHjAcrJBeTmkhEvC44NGjKPmLA9juD4vhrPguDdcLCfSCa5NKv4EZg9931uduP9KQCnMe',
    offer:
      '2MzJLhAKscc4rE3m1ncUHy38RoGEeLauDcqofBEQAmTWon11ccKuxrAJCgRDLrjLKwqgJwgA4smqcqUv7jh1TuLEoxESDyyBq9nwjd7fiLnFHQTkSPe',
    collectionOffer:
      'drnaxh6fbwEJBtT8CYERL3YU6AZMTbSbkGjixySCFLPcUGe3yu6dXFUPcDqwHCxob7HbqqbGPNJZqhHP7bsScGzT843LxJSrDAdscfw8QFptxbJDcRWjwLTT7htaoRgoeA8NQ6CUKLEaoYs1MVikFseyndP1UotqzcuyukXvbhtPD5KMTZWZQAWtxBg52yhs7pcbkNuWUfN6xTfCd3sDKcczw2Dfayrr8QTZQ11uQ',
  },
} as const;

export const SALE_ADDRESS = ADDRESSES[NETWORK].sale;
export const OFFER_ADDRESS = ADDRESSES[NETWORK].offer;
export const COLLECTION_OFFER_ADDRESS = ADDRESSES[NETWORK].collectionOffer;

/**
 * Merkle root per collection, over the token ids that still exist.
 *
 * Pinned like the addresses, and for the same reason: a bid names a root, so a
 * root that moves silently makes every existing collection bid unreachable by
 * the app. lib/merkle.test.ts rebuilds these from the catalogue and fails if
 * they drift — which is what a burn or a catalogue edit would cause.
 *
 * Regenerate with: npx tsx scripts/print-roots.ts
 */
export const COLLECTION_ROOTS: Record<string, string> = {
  ERGOCHAMPIONS: 'f446665d83beda705e227e53e388a80ebb158e4c0e4a85f98571ff4cd298c532',
  ERGOMUMMY: '1aad8dde9730246db70e80dabbc36c9c7feed33dc53733cf77172e808609c604',
  MAGECHAMPIONS: '86a89244b3422f7d9b931a8ad215d4acedb33e057abd2bd19b94fa3c5e0b9d56',
};

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
