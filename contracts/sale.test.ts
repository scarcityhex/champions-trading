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
  SLong,
  SSigmaProp,
} from '@fleet-sdk/core';

const SALE_SCRIPT = readFileSync(join(__dirname, 'sale.es'), 'utf8');
const saleTree = compile(SALE_SCRIPT, { version: 1 });

const NFT = '5836c62731c4f5f0d0e4a5f0b3f9a4d0c2e8b1a7f6d3c9e2b8a4f1d7c3e9b2a8';
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

  /** A listing box: one NFT, seller in R4, price in R5. */
  function list(tokenId = NFT) {
    sale.addBalance(
      { nanoergs: BOX_MIN, tokens: [{ tokenId, amount: 1n }] },
      {
        R4: SSigmaProp(SGroupElement(seller.key.publicKey)).toHex(),
        R5: SLong(PRICE).toHex(),
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
    const NFT_B = '9494a174c9b3f1e8d2a7b5c0f3e6d9a2b8c4f7e1d5a9b3c6f0e4d8a2b7c1f5e9';
    const boxA = list(NFT);
    list(NFT_B);

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
    const NFT_B = '9494a174c9b3f1e8d2a7b5c0f3e6d9a2b8c4f7e1d5a9b3c6f0e4d8a2b7c1f5e9';
    const boxA = list(NFT);
    const boxB = list(NFT_B);

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
