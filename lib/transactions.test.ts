// transactions.test.ts — the builders, driven end to end against the contract.
//
// contracts/sale.test.ts proves the SCRIPT is safe by hand-crafting attacks.
// This proves the APP builds transactions the script accepts — a different
// failure mode, and the likelier one: a correct contract fronted by a builder
// that forgets a register produces a marketplace where nothing works, or worse,
// where a listing cannot be cancelled.
//
// The list -> buy round trip is the important one. It spends the exact box the
// list builder produced, rather than a box the test wrote itself, so a register
// the builder gets wrong cannot pass unnoticed.

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@fleet-sdk/compiler';
import { serializeBox } from '@fleet-sdk/serializer';
import { blake2b256, hex } from '@fleet-sdk/crypto';
import { SInt } from '@fleet-sdk/core';
import {
  MockChain,
  type KeyedMockChainParty,
  type NonKeyedMockChainParty,
} from '@fleet-sdk/mock-chain';
import { ADDRESSES, NETWORK_PREFIX, SALE_ERGO_TREE } from './contract';
import {
  buildBuyTx,
  buildCancelTx,
  buildListTx,
  sellerAddressFrom,
  LISTING_BOX_VALUE,
  type FleetBox,
} from './transactions';

/**
 * An issuer box whose id is genuinely the hash of its own serialization —
 * which is what makes it a valid token id, and what the sale contract checks.
 * A hand-written id would pass the builder's guard and fail the script.
 */
function issuerFor(rate: number | null, ergoTree: string): { box: FleetBox; tokenId: string } {
  const box = {
    value: 2_000_000n,
    ergoTree,
    creationHeight: 725_325,
    assets: [],
    additionalRegisters: rate === null ? {} : { R4: SInt(rate).toHex() },
    transactionId: '00'.repeat(32),
    index: 0,
  };
  const tokenId = hex.encode(blake2b256(serializeBox(box as never).toBytes()));
  return { box: { ...box, boxId: tokenId } as unknown as FleetBox, tokenId };
}

// Derived, not invented. The sale contract requires the issuer box handed to
// it to hash to the token id, so a literal token id cannot be listed at all.
// Built with no royalty so the figures these tests assert stay whole-price;
// the split itself is covered in lib/royaltyTransactions.test.ts.
const { box: ISSUER, tokenId: NFT } = issuerFor(null, '0008cd02b55510f92d1f6ebe1572e6a7f745dd63c2aa3ae26c4f921f20df2f5f4215de84');
const ERG = 1_000_000_000n;
const PRICE = 7n * ERG;

describe('transaction builders', () => {
  let chain: MockChain;
  let seller: KeyedMockChainParty;
  let buyer: KeyedMockChainParty;
  let sale: NonKeyedMockChainParty;

  const utxosOf = (p: KeyedMockChainParty | NonKeyedMockChainParty) =>
    p.utxos.toArray() as unknown as FleetBox[];

  beforeEach(() => {
    chain = new MockChain({ height: 1_000_000 });
    seller = chain.newParty('seller');
    buyer = chain.newParty('buyer');
    sale = chain.addParty(SALE_ERGO_TREE, 'sale');
    seller.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: NFT, amount: 1n }] });
    buyer.addBalance({ nanoergs: 100n * ERG });
  });

  /** Lists the NFT and returns the listing box the contract now holds. */
  function list(price = PRICE): FleetBox {
    const tx = buildListTx({
      tokenId: NFT,
      price,
      sellerAddress: seller.address.toString(),
      utxos: utxosOf(seller),
      height: chain.height,
      issuerBox: ISSUER,
    });
    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    return utxosOf(sale)[0];
  }

  it('sends the listing to the contract with the seller and price in registers', () => {
    const box = list();

    expect(sale.utxos.length).toBe(1);
    expect(box.assets).toContainEqual({ tokenId: NFT, amount: 1n });
    expect(BigInt(box.value)).toBe(LISTING_BOX_VALUE);
    // R4 must decode back to the seller, or the cancel branch is unprovable and
    // the buy builder would pay an address that does not exist.
    expect(sellerAddressFrom(box.additionalRegisters.R4!)).toBe(seller.address.toString());
    expect(seller.balance.tokens).toHaveLength(0);
  });

  it('completes a list -> buy round trip', () => {
    const box = list();
    const sellerBefore = seller.balance.nanoergs;

    const tx = buildBuyTx({
      listingBox: box,
      price: PRICE,
      sellerAddress: seller.address.toString(),
      buyerAddress: buyer.address.toString(),
      buyerUtxos: utxosOf(buyer),
      height: chain.height,
      issuerBox: ISSUER,
    });

    expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
    expect(buyer.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
    expect(seller.balance.nanoergs).toBe(sellerBefore + PRICE);
    expect(sale.utxos.length).toBe(0);
  });

  it('completes a list -> cancel round trip, returning the box ERG too', () => {
    const box = list();
    const before = seller.balance.nanoergs;

    const tx = buildCancelTx({
      listingBox: box,
      sellerAddress: seller.address.toString(),
      sellerUtxos: utxosOf(seller),
      height: chain.height,
    });

    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    expect(seller.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
    // The listing's own ERG comes home; only the network fee is gone.
    expect(seller.balance.nanoergs).toBe(before + LISTING_BOX_VALUE - 1_100_000n);
    expect(sale.utxos.length).toBe(0);
  });

  it('will not let a buyer other than the payer take the NFT for less', () => {
    const box = list();
    const tx = buildBuyTx({
      listingBox: box,
      price: PRICE - 1n, // an app bug, or a tampered price
      sellerAddress: seller.address.toString(),
      buyerAddress: buyer.address.toString(),
      buyerUtxos: utxosOf(buyer),
      height: chain.height,
      issuerBox: ISSUER,
    });
    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });

  it('will not let a stranger cancel a listing', () => {
    const box = list();
    const tx = buildCancelTx({
      listingBox: box,
      sellerAddress: buyer.address.toString(),
      sellerUtxos: utxosOf(buyer),
      height: chain.height,
    });
    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });

  it('refuses a non-positive price instead of building a dead listing', () => {
    // A zero-price box is spendable by anyone for nothing. Better to fail here
    // than to let a wallet sign it.
    expect(() =>
      buildListTx({
        tokenId: NFT,
        price: 0n,
        sellerAddress: seller.address.toString(),
        utxos: utxosOf(seller),
        height: chain.height,
      issuerBox: ISSUER,
      }),
    ).toThrow(/greater than zero/);
  });

  it('rejects malformed R4 rather than inventing a seller', () => {
    expect(sellerAddressFrom('')).toBeNull();
    expect(sellerAddressFrom('0e20' + 'ab'.repeat(32))).toBeNull(); // a Coll[Byte], not a SigmaProp
    expect(sellerAddressFrom('08cd' + 'ab'.repeat(10))).toBeNull(); // truncated key
  });
});

describe('pinned contract constants', () => {
  // lib/contract.ts hardcodes the address so the browser never compiles the
  // script. If sale.es changes, the real address moves and every listing made
  // under the old one becomes invisible to the app. This is the tripwire.
  it('still match a fresh compile of sale.es, on both networks', () => {
    const tree = compile(readFileSync(join(__dirname, '..', 'contracts', 'sale.es'), 'utf8'), {
      version: 1,
    });
    expect(tree.toHex()).toBe(SALE_ERGO_TREE);
    expect(tree.toAddress(NETWORK_PREFIX.mainnet).toString()).toBe(ADDRESSES.mainnet.sale);
    expect(tree.toAddress(NETWORK_PREFIX.testnet).toString()).toBe(ADDRESSES.testnet.sale);
  });

  it('never confuses the two networks', () => {
    // A testnet deploy carrying a mainnet address would build transactions
    // against a contract that does not exist on that chain.
    expect(ADDRESSES.mainnet.sale).not.toBe(ADDRESSES.testnet.sale);
    expect(ADDRESSES.mainnet.offer).not.toBe(ADDRESSES.testnet.offer);
  });
});
