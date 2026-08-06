// sale.test.ts — the security tests that matter.
//
// These run the REAL compiled ErgoScript against a mock chain that enforces the
// same consensus rules a node does. A test failing here is not a style problem;
// it means the contract would let someone take an NFT or ERG that is not
// theirs.
//
//   npm test
//
// Each test states the attack in its name. If you add a branch to sale.es, add
// the test that tries to abuse it first.

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@fleet-sdk/compiler';
import {
  MockChain,
  type KeyedMockChainParty,
  type NonKeyedMockChainParty,
} from '@fleet-sdk/mock-chain';
import {
  ErgoAddress,
  OutputBuilder,
  TransactionBuilder,
  RECOMMENDED_MIN_FEE_VALUE,
  SByte,
  SColl,
  SGroupElement,
  SInt,
  SLong,
  SSigmaProp,
} from '@fleet-sdk/core';
import { SBox, serializeBox } from '@fleet-sdk/serializer';
import { blake2b256, hex } from '@fleet-sdk/crypto';

const SALE_SCRIPT = readFileSync(join(__dirname, 'sale.es'), 'utf8');
const saleTree = compile(SALE_SCRIPT, { version: 1 });

/**
 * An issuer box carrying no royalty, and the token id it produces.
 *
 * Derived rather than written down: the purchase branch requires R6 to hold a
 * box whose id IS the token id, so a literal token id cannot be listed. Zero
 * royalty keeps the figures in these tests whole-price — the split has its own
 * suite in lib/royaltyTransactions.test.ts — while still exercising the
 * authenticity check on every purchase here.
 */
function issuerFor(rate: number | null, ergoTree: string) {
  const box = {
    value: 2_000_000n,
    ergoTree,
    creationHeight: 725_325,
    assets: [],
    additionalRegisters: rate === null ? {} : { R4: SInt(rate).toHex() },
    transactionId: '00'.repeat(32),
    index: 0,
  };
  const boxId = hex.encode(blake2b256(serializeBox(box as never).toBytes()));
  return { box: { ...box, boxId }, tokenId: boxId };
}

const ISSUER = issuerFor(
  null,
  '0008cd02b55510f92d1f6ebe1572e6a7f745dd63c2aa3ae26c4f921f20df2f5f4215de84',
);
const NFT = ISSUER.tokenId;

/** A second, unrelated token — its own issuer box, so its own id. */
const ISSUER_B = issuerFor(
  null,
  '0008cd0338fccd45a1f737d81cb90d0fc9876a278049615c2a75b803a4da2c6d7f5f1764',
);
const ERG = 1_000_000_000n;
const PRICE = 5n * ERG;
/** ERG parked in the listing box itself; the protocol minimum, plus headroom. */
const BOX_MIN = 1_000_000n;

describe('sale.es', () => {
  let chain: MockChain;
  let seller: KeyedMockChainParty;
  let buyer: KeyedMockChainParty;
  let stranger: KeyedMockChainParty;
  let sale: NonKeyedMockChainParty;

  /** A listing box: one NFT, seller in R4, price in R5, issuer box in R6. */
  function list(tokenId = NFT, issuer = ISSUER) {
    sale.addBalance(
      { nanoergs: BOX_MIN, tokens: [{ tokenId, amount: 1n }] },
      {
        R4: SSigmaProp(SGroupElement(seller.key.publicKey)).toHex(),
        R5: SLong(PRICE).toHex(),
        R6: SBox(issuer.box as never).toHex(),
      },
    );
    return sale.utxos.at(sale.utxos.length - 1)!;
  }

  /** An output paying `to` and tagged as settling `listingBoxId`. */
  function payment(to: ErgoAddress, value: bigint, listingBoxId: string) {
    return new OutputBuilder(value, to).setAdditionalRegisters({
      R4: SColl(SByte, listingBoxId).toHex(),
    });
  }

  beforeEach(() => {
    chain = new MockChain({ height: 1_000_000 });
    seller = chain.newParty('seller');
    buyer = chain.newParty('buyer');
    stranger = chain.newParty('stranger');
    sale = chain.addParty(saleTree.toHex(), 'sale');
    buyer.addBalance({ nanoergs: 100n * ERG });
    stranger.addBalance({ nanoergs: 100n * ERG });
  });

  it('lets the seller cancel and take the NFT back', () => {
    seller.addBalance({ nanoergs: 10n * ERG }); // to cover the network fee
    list();
    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...seller.utxos.toArray()])
      .sendChangeTo(seller.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    expect(seller.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
  });

  it('lets a buyer purchase by paying the asking price', () => {
    const box = list();
    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
      .to(payment(seller.address, PRICE, box.boxId))
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
    expect(buyer.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
    expect(seller.balance.nanoergs).toBe(PRICE);
  });

  it('rejects a buyer who underpays by a single nanoERG', () => {
    const box = list();
    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
      .to(payment(seller.address, PRICE - 1n, box.boxId))
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });

  it('rejects a buyer who pays the right amount to the wrong address', () => {
    const box = list();
    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
      .to(payment(stranger.address, PRICE, box.boxId))
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });

  it('rejects a payment that is not tagged with the listing it settles', () => {
    list();
    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
      .to(new OutputBuilder(PRICE, seller.address)) // no R4 tag
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });

  it('rejects a stranger trying to cancel someone else\'s listing', () => {
    list();
    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...stranger.utxos.toArray()])
      .sendChangeTo(stranger.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
  });

  // ── The attack the R4 tag exists to stop ──────────────────────────────────
  //
  // Without the tag, both listings would look at the same payment box, each see
  // enough value, and each approve on its own. The seller would ship two NFTs
  // and be paid for one. This is the single most important test in the file.
  it('rejects two listings settled by one shared payment box', () => {
    // Both listings must be genuinely purchasable, or this proves nothing.
    //
    // An earlier version gave the second listing a token id with no matching
    // issuer box, which made it unbuyable on the authenticity check alone — so
    // the test passed whether or not the R4 tag existed. A security test that
    // cannot fail is worse than no test, because it reads like cover.
    const boxA = list(NFT);
    list(ISSUER_B.tokenId, ISSUER_B);

    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
      // One box paying 2x the price, but tagged for listing A only.
      .to(payment(seller.address, PRICE * 2n, boxA.boxId))
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });

  it('allows two listings in one transaction when each is paid separately', () => {
    const boxA = list(NFT);
    const boxB = list(ISSUER_B.tokenId, ISSUER_B);

    const tx = new TransactionBuilder(chain.height)
      .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
      .to(payment(seller.address, PRICE, boxA.boxId))
      .to(payment(seller.address, PRICE, boxB.boxId))
      .sendChangeTo(buyer.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
    expect(seller.balance.nanoergs).toBe(PRICE * 2n);
  });
});
