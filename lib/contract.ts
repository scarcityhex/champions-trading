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
  '19f3010904000400040004d00f05d00f0500040005000100d803d601e4c6a70408d602c6a70663d603e4c6a70505eb027201d195ede6720291b1db6308a77300d808d604e47202d605c672040404d60695e67205e472057301d607ed92720673028f72067303d608d07201d609c27204d60a9372087209d60b9572079d9c72037e72060573047305ededed93c572048cb2db6308a7730600017207aea5d9010c63ededed92c1720c95720a7203997203720b93c2720c7208e6c6720c040e93e4c6720c040ec5a7ecec90720b7307720aaea5d9010c63ededed92c1720c720b93c2720c7209e6c6720c040e93e4c6720c040ec5a77308';

/** contracts/collection-offer.es — a bidder locks ERG for ANY piece from one
 *  collection, membership proven against a Merkle root in R5. */
export const COLLECTION_OFFER_ERGO_TREE =
  '19b102090400040004d00f05d00f05000502050004000100d804d601e4c6a70408d602e3000ed603e3010c490ed604e30263eb027201d195edede67202e67203e67204d806d605e47202d606e47204d607c672060404d60895e67207e472077300d609ed92720873018f72087302d60a9572099d9cc1a77e72080573037304edededed93b0e47203cb7205d9010b3c0e490ed803d60d8c720b02d60e8c720d01d60f8c720b01958c720d02cbb3720e720fcbb3720f720ee4c6a7050eaea5d9010b63ededed93c2720bd07201aedb6308720bd9010d4d0eed938c720d017205928c720d027305e6c6720b040e93e4c6720b040ec5a793c5720672057209ec90720a7306aea5d9010b63edededed92c1720b720a93c2720bc2720693b1db6308720b7307e6c6720b040e93e4c6720b040ec5a77308';

/** contracts/offer.es — a bidder locks ERG and waits for a token. */
export const OFFER_ERGO_TREE =
  '19e601090400040004d00f05d00f05000502050004000100d803d601e4c6a70408d602c6a70663d603e4c6a7050eeb027201d195e67202d805d604e47202d605c672040404d60695e67205e472057300d607ed92720673018f72067302d6089572079d9cc1a77e72060573037304ededed93c5720472037207aea5d9010963ededed93c27209d07201aedb63087209d9010b4d0eed938c720b017203928c720b027305e6c67209040e93e4c67209040ec5a7ec9072087306aea5d9010963edededed92c17209720893c27209c2720493b1db630872097307e6c67209040e93e4c67209040ec5a77308';

/** The three scripts, addressed on each network. */
export const ADDRESSES = {
  mainnet: {
    sale: 'HhLWrwidFajKRcHhCkFDBsgEiCJkpKyLWFbpxGTD6f4QV8r2RLbGfWakMTg1ayih94Z91UfygsQqpNHMJi7FQcMmqmQx3hmT9NRTmCHfBWXwtC813qmNWq8LGaFkZoq5AA4gmw5vPbw9qKjLysHu7De3ELqyULsRSS3ZyjEc1JzAUMUFpPRvju9K2WEwfyBhudCvmhUNwFHUQbuaPZWPAmGf9DBNmNGogWrzZvCAnVpwFuzwUGdr3zWuJTscTcPmwZPnDhK4HwsRWzLcottUtcCGhzg7HP1Aon9KhEXTsf8yirJCXzkhbYsAvvHxS2gwdQUWrE1ZFciABHcqfDRB9Y',
    offer:
      'nQoRCPM7YDxyb8ZZY1r37RuuQRsQYCu5hGzXJRtChTvAd9uL6nTJ19TJvsQxWVKiJjo7TEPaR1VodopbCNPr6ooB9Ui558ZFo4g2w9caXNoGFTWN6ygV48Mh6ZfrkNSXvkLKkmEWiYGhjiucZgVRF1oYsHSe7bBpXjkA1fg8ERoggqwnBQ62yGvu3sSMHhjsRdYRjFBb5zqRJQm4wVhtmuvSvxz2X1syxzgjTzm14pTdTpmnP9WGPmq6scid94WcbQ8xPrSdpBeTM1QPb87M9WfAwTHG2G8bSfEgeU7EBb92Rjrj8ML5qb3vo51zHB2oFAw2',
    collectionOffer:
      '5PKfeDJbqaNTYBvuhk4Bw2GneJD4e32CGmmwT8UY2JwrhqjhQPELafpESkmN8HxruRw88KEf5viSaV2NMAtSqnbJUYc7j9ibgZER7JWQZDBKsmAc8VSnNgLqnPaoGd7Uw4SMfgujc539TjRpdkBRJ5jJWQCAAYriXLsYRKP16PJjw9JK2ZzVgazBxenaxjCVonsxaPfC6FzrTweuVKHB8XaZffDET53SS5Fa6WJ3GBHW6HZMygazRvPBAAcNr4K3qjBo4wB67Ti6F9cPvfqUxBoAmMQHpsQvpiA91oQb1cfyVFBbMXS9qtZxXHhYfnMcAgVKwcRk22ver7bRSgAPWETndDdwDeA8sjnqK2LCunnsSP54AN6PhE1jyYGuG4ABf45KbJi2ngGKjX23jJ4VTvLBWcfy7bWVZmmW1Lnffgg',
  },
  testnet: {
    sale: '2mq1DLGS91HmtseGFCN1JEmPTnSmg35c4Wx9A3GXgvuKVBVgEQE2DjaYNVnYB2rBDfqWbVC9mb2sPDE1MraYrfik58S9EvXvMRVwoBfcvTxa9beq5ygH7Jh6TxiakBcF8mjT9j9mhP8FWvPxpqGmgrw2PmzSKTHmQxUa7SbAPpcWUCSve4aWrdPLbWs6G5yw7BEe3Q1eG1gSdfYXQHP34fbexB7tM3LMGjmTpmrim5UrhmdoZNUgpQfRLV2F2ugvf3zyivwHK1TeMg6sRXtR1wWycKnfuUvRMuw98oC7C8k3BmmaEw3CC9JTQUM6nkzHnYUTorjWqx1RY5W3XbBUJKQ',
    offer:
      '5phVsx2VsTrZZSeYR6mVnpMvqXvW5D9vLxU174Ed2y9YqRMZpM68UY7wiDJxanPmpqRdVVZeoixnFJb1DSAnS2aLDTuaxJUEqB9EbD8FrGcbf9QV87sAJKicfuFAES8Xr9rWTZkz27FNA1V1ZqeeyVEB9hYLXjhsksM918wCeuedReJdFUokJB8wWvf4PiHk1V6cQ2Vfag7gQYC2GJW4AaQHKynVAF3qGiuqWspg9kctdvzdDrGxsZVqKKd3A3FHqZWphcAGUHy13BUs3fg7yAiMDYnPfy2rB3Gp58K3dNpaWC6tNDKybmSSvDRE8YenuL6tR',
    collectionOffer:
      'U1oNF8zbUh5ds7YqsWYF7xr5oAqPKHHhdPiUDZYewMhyMdhmLBdMyKgj5UhenMrmtnUN18t4z4oNh32H2enVDgkDTosxEu9FyiTajMTAqGirtfUkG17YQnNo4RVPoUGttWFdf6uApmdthost1qg5ndhUS13NjkgRjUtmwpsUVq8VRmSVATXGxeD6SvWH3MpwgKmrU4zkQUcwEbo9ogC1c5Y1uUjFa78f3w5BscQLKYay2PW5Mncp9VrBK2hkRW2USjPXgr2x9GryEvSTpmy2uGoqhEZvGTXUj5PB22x9h2ju8UmmCwCpYwWCSbVjQLBwxyFZBcrcLH2oGX622ttsEE9CZ8b9zQoToUmLuqjvW85wUkKj6iFaVbS8jw2atQxFBNri97F2bWjPNn6DLyahNF9CuG1L6x2jeqjMT37Gvxd',
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
