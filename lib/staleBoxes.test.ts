// staleBoxes.test.ts — transactions must be built from boxes read just now.
//
// The failure this guards against is silent, which is what makes it worth a
// test. The wallet signs whatever it is handed, submit_tx returns an id, and
// the node then drops a transaction that spends inputs which no longer exist.
// Nothing errors; the trade simply never happens, and the user is left looking
// at a transaction id the explorer has never heard of.
//
// wallet.utxos lives in React state and was only ever refreshed AFTER our own
// transactions, so a page left open — or a wallet used in another tab — went
// stale with no signal.

import { describe, expect, it } from 'vitest';
import { MockChain } from '@fleet-sdk/mock-chain';
import { buildOfferTx, type FleetBox } from './transactions';

const ERG = 1_000_000_000n;
const NFT = '5836c62731c4f5f0d0e4a5f0b3f9a4d0c2e8b1a7f6d3c9e2b8a4f1d7c3e9b2a8';

// Note on what these can and cannot show: the mock chain does not model the
// UTxO set, so it happily executes a transaction spending a box that is already
// gone. A real node does not. So the first test asserts the thing that IS
// checkable here — that a stale snapshot yields a transaction referencing a box
// the chain no longer has — rather than pretending to reproduce the rejection.
describe('building from stale boxes', () => {
  it('produces a transaction that spends a box the chain no longer has', () => {
    const chain = new MockChain({ height: 1_000_000 });
    const bidder = chain.newParty('bidder');
    bidder.addBalance({ nanoergs: 20n * ERG });

    // A snapshot, as `wallet.utxos` in React state is.
    const stale = bidder.utxos.toArray() as unknown as FleetBox[];

    // The wallet spends elsewhere; those boxes are gone.
    chain.execute(
      buildOfferTx({
        tokenId: NFT,
        amount: 2n * ERG,
        bidderAddress: bidder.address.toString(),
        utxos: stale,
        height: chain.height,
      }),
      { signers: [bidder] },
    );

    // Building from the snapshot still succeeds — nothing at build time can
    // tell, which is precisely why the failure is silent.
    const fromStale = buildOfferTx({
      tokenId: NFT,
      amount: 3n * ERG,
      bidderAddress: bidder.address.toString(),
      utxos: stale,
      height: chain.height,
    });
    expect(fromStale.inputs.length).toBeGreaterThan(0);

    // Every box the snapshot offered is gone from the wallet by now, so the
    // transaction names inputs that no longer exist. A node rejects that; the
    // user has already signed by then.
    const live = new Set(bidder.utxos.toArray().map((b) => b.boxId));
    expect(fromStale.inputs.some((input) => !live.has(input.boxId))).toBe(true);
  });

  it('succeeds when the boxes are re-read first', () => {
    const chain = new MockChain({ height: 1_000_000 });
    const bidder = chain.newParty('bidder');
    bidder.addBalance({ nanoergs: 20n * ERG });

    chain.execute(
      buildOfferTx({
        tokenId: NFT,
        amount: 2n * ERG,
        bidderAddress: bidder.address.toString(),
        utxos: bidder.utxos.toArray() as unknown as FleetBox[],
        height: chain.height,
      }),
      { signers: [bidder] },
    );

    // What useMarket.run now does: read the wallet again, then build.
    const fresh = bidder.utxos.toArray() as unknown as FleetBox[];
    const tx = buildOfferTx({
      tokenId: NFT,
      amount: 3n * ERG,
      bidderAddress: bidder.address.toString(),
      utxos: fresh,
      height: chain.height,
    });

    expect(chain.execute(tx, { signers: [bidder] })).toBe(true);
  });
});
