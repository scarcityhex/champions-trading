// collection-offer.test.ts — a bid on any piece from one collection.
//
// The important thing these tests establish is that two independent
// implementations of the same hash tree agree: lib/merkle.ts builds the proof
// in TypeScript, and the compiled ErgoScript recomputes the root from it. A
// mismatch in concatenation order or leaf hashing would make every honest
// accept fail, and no amount of reading either side proves they match.
//
// The rest are the attacks. This contract holds a stranger's ERG and pays out
// on evidence the spender supplies, so the evidence has to be unforgeable.

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@fleet-sdk/compiler';
import {
  ErgoUnsignedInput,
  OutputBuilder,
  RECOMMENDED_MIN_FEE_VALUE,
  SAFE_MIN_BOX_VALUE,
  SBool,
  SByte,
  SColl,
  TransactionBuilder,
} from '@fleet-sdk/core';
import { SPair } from '@fleet-sdk/serializer';
import {
  MockChain,
  type KeyedMockChainParty,
  type NonKeyedMockChainParty,
} from '@fleet-sdk/mock-chain';
import { ADDRESSES, COLLECTION_OFFER_ERGO_TREE, NETWORK_PREFIX } from '../lib/contract';
import {
  buildAcceptCollectionOfferTx,
  buildCancelCollectionOfferTx,
  buildCollectionOfferTx,
  collectionRootFrom,
  type FleetBox,
} from '../lib/transactions';
import { merkleProof, merkleRootHex } from '../lib/merkle';

const ERG = 1_000_000_000n;
const BID = 3n * ERG;

/** A synthetic collection: odd count on purpose, so promoted nodes are covered. */
const COLLECTION = Array.from({ length: 7 }, (_, i) => `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32));
const OUTSIDER = 'ff'.repeat(32);
const ROOT = merkleRootHex(COLLECTION);

describe('collection-offer.es', () => {
  let chain: MockChain;
  let bidder: KeyedMockChainParty;
  let holder: KeyedMockChainParty;
  let offers: NonKeyedMockChainParty;

  const utxosOf = (p: KeyedMockChainParty | NonKeyedMockChainParty) =>
    p.utxos.toArray() as unknown as FleetBox[];

  beforeEach(() => {
    chain = new MockChain({ height: 1_000_000 });
    bidder = chain.newParty('bidder');
    holder = chain.newParty('holder');
    offers = chain.addParty(COLLECTION_OFFER_ERGO_TREE, 'collection-offers');
    bidder.addBalance({ nanoergs: 50n * ERG });
    holder.addBalance({
      nanoergs: 5n * ERG,
      tokens: [
        { tokenId: COLLECTION[3], amount: 1n },
        { tokenId: OUTSIDER, amount: 1n },
      ],
    });
  });

  function bid(amount = BID, root = ROOT): FleetBox {
    const tx = buildCollectionOfferTx({
      root,
      amount,
      bidderAddress: bidder.address.toString(),
      utxos: utxosOf(bidder),
      height: chain.height,
    });
    expect(chain.execute(tx, { signers: [bidder] })).toBe(true);
    return utxosOf(offers)[offers.utxos.length - 1];
  }

  it('funds the bid and records the collection root', () => {
    const box = bid();
    expect(BigInt(box.value)).toBe(BID);
    expect(collectionRootFrom(box.additionalRegisters.R5!)).toBe(ROOT);
  });

  // The one that proves the two implementations agree.
  it('accepts a member token, with a proof built in TypeScript', () => {
    const box = bid();
    const before = holder.balance.nanoergs;

    const tx = buildAcceptCollectionOfferTx({
      offerBox: box,
      tokenId: COLLECTION[3],
      collectionTokenIds: COLLECTION,
      bidderAddress: bidder.address.toString(),
      holderAddress: holder.address.toString(),
      holderUtxos: utxosOf(holder),
      height: chain.height,
    });

    expect(chain.execute(tx, { signers: [holder] })).toBe(true);
    expect(bidder.balance.tokens).toContainEqual({ tokenId: COLLECTION[3], amount: 1n });
    expect(holder.balance.nanoergs).toBe(before + BID - SAFE_MIN_BOX_VALUE - RECOMMENDED_MIN_FEE_VALUE);
  });

  it('accepts any member, not just one position in the tree', () => {
    // A path is different at every leaf — left/right siblings, and the promoted
    // node at the odd end. Covering only the middle would hide an off-by-one.
    for (const tokenId of COLLECTION) {
      const fresh = new MockChain({ height: 1_000_000 });
      const b = fresh.newParty('bidder');
      const h = fresh.newParty('holder');
      const o = fresh.addParty(COLLECTION_OFFER_ERGO_TREE, 'offers');
      b.addBalance({ nanoergs: 20n * ERG });
      h.addBalance({ nanoergs: 5n * ERG, tokens: [{ tokenId, amount: 1n }] });

      fresh.execute(
        buildCollectionOfferTx({
          root: ROOT,
          amount: BID,
          bidderAddress: b.address.toString(),
          utxos: b.utxos.toArray() as unknown as FleetBox[],
          height: fresh.height,
        }),
        { signers: [b] },
      );

      const tx = buildAcceptCollectionOfferTx({
        offerBox: o.utxos.toArray()[0] as unknown as FleetBox,
        tokenId,
        collectionTokenIds: COLLECTION,
        bidderAddress: b.address.toString(),
        holderAddress: h.address.toString(),
        holderUtxos: h.utxos.toArray() as unknown as FleetBox[],
        height: fresh.height,
      });
      expect(fresh.execute(tx, { signers: [h] }), tokenId).toBe(true);
    }
  });

  it('lets the bidder withdraw, with no proof supplied at all', () => {
    // The cancel branch runs without context variables. If the script unwrapped
    // them eagerly it would abort here and strand the bidder's ERG — which is
    // exactly why collection-offer.es guards the option access.
    const box = bid();
    const before = bidder.balance.nanoergs;

    const tx = buildCancelCollectionOfferTx({
      offerBox: box,
      bidderAddress: bidder.address.toString(),
      bidderUtxos: utxosOf(bidder),
      height: chain.height,
    });

    expect(chain.execute(tx, { signers: [bidder] })).toBe(true);
    expect(bidder.balance.nanoergs).toBe(before + BID - RECOMMENDED_MIN_FEE_VALUE);
  });

  // ── Attacks ──────────────────────────────────────────────────────────────

  it('refuses to build a delivery for a token outside the collection', () => {
    const box = bid();
    expect(() =>
      buildAcceptCollectionOfferTx({
        offerBox: box,
        tokenId: OUTSIDER,
        collectionTokenIds: COLLECTION,
        bidderAddress: bidder.address.toString(),
        holderAddress: holder.address.toString(),
        holderUtxos: utxosOf(holder),
        height: chain.height,
      }),
    ).toThrow(/not part of the collection/);
  });

  it('rejects a forged proof for a token outside the collection', () => {
    // The builder refuses, so the attack has to be hand-rolled: deliver the
    // outsider while presenting a valid path belonging to a member. This is the
    // whole point of the root — the recomputation must not land on it.
    const box = bid();
    const stolenPath = merkleProof(COLLECTION, COLLECTION[3])!;

    const input = new ErgoUnsignedInput(box).setContextExtension({
      0: SColl(SByte, OUTSIDER).toHex(),
      1: SColl(
        SPair(SColl(SByte), SBool),
        stolenPath.map((s) => [s.sibling, s.siblingIsLeft] as [Uint8Array, boolean]),
      ).toHex(),
    });

    const tx = new TransactionBuilder(chain.height)
      .from([input], { ensureInclusion: true })
      .from(utxosOf(holder))
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, bidder.address)
          .addTokens({ tokenId: OUTSIDER, amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, box.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  it('rejects an empty proof, which would claim the leaf is the root', () => {
    const box = bid();
    const input = new ErgoUnsignedInput(box).setContextExtension({
      0: SColl(SByte, COLLECTION[3]).toHex(),
      1: SColl(SPair(SColl(SByte), SBool), []).toHex(),
    });

    const tx = new TransactionBuilder(chain.height)
      .from([input], { ensureInclusion: true })
      .from(utxosOf(holder))
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, bidder.address)
          .addTokens({ tokenId: COLLECTION[3], amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, box.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  it('rejects delivery to anyone but the bidder', () => {
    const box = bid();
    const path = merkleProof(COLLECTION, COLLECTION[3])!;
    const input = new ErgoUnsignedInput(box).setContextExtension({
      0: SColl(SByte, COLLECTION[3]).toHex(),
      1: SColl(
        SPair(SColl(SByte), SBool),
        path.map((s) => [s.sibling, s.siblingIsLeft] as [Uint8Array, boolean]),
      ).toHex(),
    });

    const tx = new TransactionBuilder(chain.height)
      .from([input], { ensureInclusion: true })
      .from(utxosOf(holder))
      .to(
        // Token kept by the holder, ERG taken anyway.
        new OutputBuilder(SAFE_MIN_BOX_VALUE, holder.address)
          .addTokens({ tokenId: COLLECTION[3], amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, box.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  // Several bids coexisting is the point of the feature, so the double-settle
  // attack matters more here than anywhere: a bidder running three bids must
  // not pay all three for one NFT.
  it('rejects two bids settled by one delivery', () => {
    const first = bid();
    bid();
    expect(offers.utxos.length).toBe(2);

    const path = merkleProof(COLLECTION, COLLECTION[3])!;
    const ext = {
      0: SColl(SByte, COLLECTION[3]).toHex(),
      1: SColl(
        SPair(SColl(SByte), SBool),
        path.map((s) => [s.sibling, s.siblingIsLeft] as [Uint8Array, boolean]),
      ).toHex(),
    };
    const inputs = utxosOf(offers).map((b) => new ErgoUnsignedInput(b).setContextExtension(ext));

    const tx = new TransactionBuilder(chain.height)
      .from(inputs, { ensureInclusion: true })
      .from(utxosOf(holder))
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, bidder.address)
          .addTokens({ tokenId: COLLECTION[3], amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, first.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  it('rejects a bid whose root belongs to a different collection', () => {
    const otherRoot = merkleRootHex([OUTSIDER, 'ee'.repeat(32)]);
    const box = bid(BID, otherRoot);
    expect(() =>
      buildAcceptCollectionOfferTx({
        offerBox: box,
        tokenId: COLLECTION[3],
        collectionTokenIds: [OUTSIDER, 'ee'.repeat(32)],
        bidderAddress: bidder.address.toString(),
        holderAddress: holder.address.toString(),
        holderUtxos: utxosOf(holder),
        height: chain.height,
      }),
    ).toThrow(/not part of the collection/);
  });
});

describe('pinned collection-offer constants', () => {
  it('still match a fresh compile, on both networks', () => {
    const tree = compile(readFileSync(join(__dirname, 'collection-offer.es'), 'utf8'), {
      version: 1,
    });
    expect(tree.toHex()).toBe(COLLECTION_OFFER_ERGO_TREE);
    expect(tree.toAddress(NETWORK_PREFIX.mainnet).toString()).toBe(ADDRESSES.mainnet.collectionOffer);
    expect(tree.toAddress(NETWORK_PREFIX.testnet).toString()).toBe(ADDRESSES.testnet.collectionOffer);
  });
});
