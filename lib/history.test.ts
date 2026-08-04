// history.test.ts — the trade classifier.
//
// The indexer writes a permanent file, so a mistake here is a wrong number that
// looks authoritative forever. Tested against synthetic transactions rather
// than the chain, because the cases that matter (a cancellation, several trades
// in one transaction) are exactly the ones that will be rare in real data and
// impossible to summon on demand.

import { describe, expect, it } from 'vitest';
import { ErgoAddress } from '@fleet-sdk/core';
import { extractTrades, mergeTrades, type RawTx, type Trade } from './history';

const SALE = 'BhRyuhANCEte3LK3mjjSgKBjcsLhC9Ms5Ka2TUW43kJk5JhfdjPHVoPRG6hFuxBpMz2cM7ZegPYTQefYQxkj';
const OFFER = 'DpKxDXj2Aa6hewpAWktyiWKDBk7Dg4ttNLN4rdYvx9UdkRmcMhL1YKKXtwbpFUFNXWipaLmLME4Pf6oRHA1xdHP5Wm7aP21oW1NjpXud5LMrL12CjM';
const CONTRACTS = { sale: SALE, offer: OFFER };

const SELLER_PK = '02b55510f92d1f6ebe1572e6a7f745dd63c2aa3ae26c4f921f20df2f5f4215de84';
const SELLER = '9hveS5VmStvpiybxya1adrvJipaz6Pi8bJMuttKuMvsijNiNxiv';
const BUYER = '9gtuMt4YTz5e1cskqyUAzVCXcQMHNtrF7RyfbnhHvNiQ1UoR697';
const NFT = '5836c62731c4f5f0d0e4a5f0b3f9a4d0c2e8b1a7f6d3c9e2b8a4f1d7c3e9b2a8';
const BOX = 'aa'.repeat(32);

const reg = (hex: string, rendered?: string) => ({ serializedValue: hex, renderedValue: rendered });

function saleInput(boxId = BOX, price = '5000000000') {
  return {
    boxId,
    address: SALE,
    value: '1000000',
    assets: [{ tokenId: NFT, amount: '1' }],
    additionalRegisters: {
      R4: reg(`08cd${SELLER_PK}`),
      R5: reg('0580c8afa025', price),
    },
  };
}

const tx = (over: Partial<RawTx>): RawTx => ({
  id: 'tx1',
  inclusionHeight: 1_500_000,
  timestamp: 1_700_000_000_000,
  inputs: [],
  outputs: [],
  ...over,
});

describe('extractTrades', () => {
  it('reads a completed sale', () => {
    const t = extractTrades(
      tx({
        inputs: [saleInput()],
        outputs: [
          // payment to the seller, tagged with the listing it settles
          { boxId: 'o1', address: SELLER, value: '5000000000', additionalRegisters: { R4: reg(`0e20${BOX}`) } },
          // the NFT lands with the buyer as change
          { boxId: 'o2', address: BUYER, value: '1000000', assets: [{ tokenId: NFT, amount: '1' }] },
        ],
      }),
      CONTRACTS,
    );

    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      tokenId: NFT,
      price: '5000000000',
      buyer: BUYER,
      kind: 'sale',
      height: 1_500_000,
    });
    // Decoded from R4, never taken from an output address — a change output can
    // belong to anyone.
    expect(t[0].seller.startsWith('9')).toBe(true);
  });

  // The one that would corrupt every statistic drawn from this file.
  it('ignores a cancellation instead of recording a zero-price sale', () => {
    const t = extractTrades(
      tx({
        inputs: [saleInput()],
        outputs: [
          // the seller simply takes the NFT back; no tagged payment anywhere
          { boxId: 'o1', address: SELLER, value: '900000', assets: [{ tokenId: NFT, amount: '1' }] },
        ],
      }),
      CONTRACTS,
    );
    expect(t).toEqual([]);
  });

  it('reads an accepted offer, with the bid as the price', () => {
    const offerBox = 'bb'.repeat(32);
    const t = extractTrades(
      tx({
        inputs: [
          {
            boxId: offerBox,
            address: OFFER,
            value: '4000000000', // the bid IS the box value
            additionalRegisters: {
              R4: reg(`08cd${SELLER_PK}`), // the bidder
              R5: reg(`0e20${NFT}`),
            },
          },
        ],
        outputs: [
          // delivery to the bidder, tagged
          {
            boxId: 'o1',
            address: SELLER,
            value: '1000000',
            assets: [{ tokenId: NFT, amount: '1' }],
            additionalRegisters: { R4: reg(`0e20${offerBox}`) },
          },
          // the holder takes the bid as change
          { boxId: 'o2', address: BUYER, value: '3998900000' },
        ],
      }),
      CONTRACTS,
    );

    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ price: '4000000000', kind: 'offerAccepted', tokenId: NFT });
  });

  it('reads several trades settled by one transaction', () => {
    const second = 'cc'.repeat(32);
    const t = extractTrades(
      tx({
        inputs: [saleInput(BOX), saleInput(second)],
        outputs: [
          { boxId: 'p1', address: SELLER, value: '5000000000', additionalRegisters: { R4: reg(`0e20${BOX}`) } },
          { boxId: 'p2', address: SELLER, value: '5000000000', additionalRegisters: { R4: reg(`0e20${second}`) } },
          { boxId: 'o3', address: BUYER, value: '2000000', assets: [{ tokenId: NFT, amount: '1' }] },
        ],
      }),
      CONTRACTS,
    );
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.boxId)).toEqual([BOX, second]);
  });

  it('ignores transactions that never touch either contract', () => {
    expect(
      extractTrades(
        tx({
          inputs: [{ boxId: 'x', address: BUYER, value: '1000' }],
          outputs: [{ boxId: 'y', address: SELLER, value: '900' }],
        }),
        CONTRACTS,
      ),
    ).toEqual([]);
  });
});

describe('mergeTrades', () => {
  const t = (boxId: string, height: number): Trade => ({
    txId: 't',
    boxId,
    tokenId: NFT,
    price: '1',
    seller: SELLER,
    buyer: BUYER,
    height,
    timestamp: height,
    kind: 'sale',
  });

  // Re-running the indexer over an overlapping range must not double-count. A
  // box can only be spent once, which is what makes boxId the right key.
  it('is idempotent over an overlapping range', () => {
    const first = mergeTrades([], [t('a', 1), t('b', 2)]);
    const again = mergeTrades(first, [t('b', 2), t('c', 3)]);
    expect(again.map((x) => x.boxId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns newest first', () => {
    expect(mergeTrades([], [t('a', 1), t('c', 3), t('b', 2)]).map((x) => x.height)).toEqual([3, 2, 1]);
  });
});

// ── Regression: the first real trade this marketplace settled ──────────────
//
// Shapes taken verbatim from mainnet transaction db4cd9cb… at height 1,843,575
// (an accepted offer on Mage Champions #906). The original classifier recorded
// the MINER FEE ADDRESS as the seller, because the fee box is an ordinary
// output and it happened to come before the change. No synthetic test caught
// it — the fixtures written by hand did not include a fee output at all.
describe('accepted offer, from a real transaction', () => {
  const BIDDER_PK = '02b55510f92d1f6ebe1572e6a7f745dd63c2aa3ae26c4f921f20df2f5f4215de84';
  // Derived, not pasted: the bidder is decoded from R4, so an address written by
  // hand that does not match the key would make the fixture disagree with
  // itself and test nothing.
  const BIDDER = ErgoAddress.fromPublicKey(BIDDER_PK).toString();
  const SELLER = '9hveS5VmStvpiybxya1adrvJipaz6Pi8bJMuttKuMvsijNiNxiv';
  const FEE =
    '2iHkR7CWvD1R4j1yZg5bkeDRQavjAaVPeTDFGGLZduHyfWMuYpmhHocX8GJoaieTx78FntzJbCBVL6rf96ocJoZdmWBL2fci7NqWgAirppPQmZ7fN9V6z13Ay6brPriBKYqLp1bT2Fk4FkFLCfdPpe';
  const TOKEN = '9354c19d525f0000000000000000000000000000000000000000000000000000';
  const OFFER_BOX = 'dd'.repeat(32);

  const realTx: RawTx = {
    id: 'db4cd9cbde544d7b',
    inclusionHeight: 1_843_575,
    timestamp: 1_785_900_000_000,
    inputs: [
      {
        boxId: OFFER_BOX,
        address: OFFER,
        value: '1000000000', // the 1 ERG bid
        additionalRegisters: {
          R4: reg(`08cd${BIDDER_PK}`),
          R5: reg(`0e20${TOKEN}`),
        },
      },
    ],
    outputs: [
      // 1. delivery to the bidder, tagged
      {
        boxId: 'o1',
        address: BIDDER,
        value: '1000000',
        assets: [{ tokenId: TOKEN, amount: '1' }],
        additionalRegisters: { R4: reg(`0e20${OFFER_BOX}`) },
      },
      // 2. the miner fee — an ordinary output, and the one that fooled us
      { boxId: 'o2', address: FEE, value: '1100000' },
      // 3. the seller's change, carrying the bid
      { boxId: 'o3', address: SELLER, value: '16743300000', assets: [] },
    ],
  };

  it('names the token holder as the seller, not the fee contract', () => {
    const [trade] = extractTrades(realTx, CONTRACTS);
    expect(trade.seller).toBe(SELLER);
    expect(trade.seller).not.toBe(FEE);
    expect(trade.buyer).toBe(BIDDER);
    expect(trade.price).toBe('1000000000');
    expect(trade.kind).toBe('offerAccepted');
  });

  it('still finds the seller when the fee output comes last', () => {
    // Output ordering is not guaranteed, so the fix cannot depend on position.
    const shuffled = { ...realTx, outputs: [realTx.outputs[0], realTx.outputs[2], realTx.outputs[1]] };
    expect(extractTrades(shuffled, CONTRACTS)[0].seller).toBe(SELLER);
  });
});
