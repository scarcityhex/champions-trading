// offer.test.ts — the offer contract, and the builders that drive it.
//
// Same discipline as sale.test.ts: each test is named after the attack it
// attempts. An offer holds a stranger's ERG until someone delivers a token, so
// the failure modes are "the bidder loses their ERG without getting the NFT"
// and "the bidder can be made to pay twice for one".

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@fleet-sdk/compiler';
import { serializeBox } from '@fleet-sdk/serializer';
import { blake2b256, hex } from '@fleet-sdk/crypto';
import { SInt } from '@fleet-sdk/core';
import {
  OutputBuilder,
  RECOMMENDED_MIN_FEE_VALUE,
  SAFE_MIN_BOX_VALUE,
  SByte,
  SColl,
  TransactionBuilder,
} from '@fleet-sdk/core';
import {
  MockChain,
  type KeyedMockChainParty,
  type NonKeyedMockChainParty,
} from '@fleet-sdk/mock-chain';
import { ADDRESSES, NETWORK_PREFIX, OFFER_ERGO_TREE, SALE_ERGO_TREE } from '../lib/contract';
import {
  buildAcceptOfferTx,
  buildCancelOfferTx,
  buildListTx,
  buildOfferTx,
  MIN_OFFER_VALUE,
  offerTokenIdFrom,
  type FleetBox,
} from '../lib/transactions';

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
const { box: ISSUER_OTHER, tokenId: OTHER_DERIVED } = issuerFor(
  null,
  '0008cd0338fccd45a1f737d81cb90d0fc9876a278049615c2a75b803a4da2c6d7f5f1764',
);
const OTHER = OTHER_DERIVED;
const ERG = 1_000_000_000n;
const BID = 4n * ERG;

describe('offer.es', () => {
  let chain: MockChain;
  let bidder: KeyedMockChainParty;
  let holder: KeyedMockChainParty;
  let stranger: KeyedMockChainParty;
  let offers: NonKeyedMockChainParty;

  const utxosOf = (p: KeyedMockChainParty | NonKeyedMockChainParty) =>
    p.utxos.toArray() as unknown as FleetBox[];

  beforeEach(() => {
    chain = new MockChain({ height: 1_000_000 });
    bidder = chain.newParty('bidder');
    holder = chain.newParty('holder');
    stranger = chain.newParty('stranger');
    offers = chain.addParty(OFFER_ERGO_TREE, 'offers');
    bidder.addBalance({ nanoergs: 50n * ERG });
    holder.addBalance({ nanoergs: 5n * ERG, tokens: [{ tokenId: NFT, amount: 1n }] });
    stranger.addBalance({ nanoergs: 50n * ERG, tokens: [{ tokenId: OTHER, amount: 1n }] });
  });

  function offer(tokenId = NFT, amount = BID): FleetBox {
    const tx = buildOfferTx({
      tokenId,
      amount,
      bidderAddress: bidder.address.toString(),
      utxos: utxosOf(bidder),
      height: chain.height,
      issuerBox: tokenId === OTHER ? ISSUER_OTHER : ISSUER,
    });
    expect(chain.execute(tx, { signers: [bidder] })).toBe(true);
    return utxosOf(offers)[offers.utxos.length - 1];
  }

  it('funds the offer with the bid and names the wanted token', () => {
    const box = offer();
    expect(BigInt(box.value)).toBe(BID);
    expect(offerTokenIdFrom(box.additionalRegisters.R5!)).toBe(NFT);
  });

  it('lets the token holder accept, swapping token for ERG', () => {
    const box = offer();
    const holderBefore = holder.balance.nanoergs;

    const tx = buildAcceptOfferTx({
      offerBox: box,
      tokenId: NFT,
      bidderAddress: bidder.address.toString(),
      holderAddress: holder.address.toString(),
      holderUtxos: utxosOf(holder),
      height: chain.height,
      issuerBox: ISSUER,
    });

    expect(chain.execute(tx, { signers: [holder] })).toBe(true);
    expect(bidder.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
    expect(holder.balance.tokens).toHaveLength(0);
    // Net of the delivery box's min value and the network fee, both funded out
    // of the bid — this is the number the UI has to quote, not BID.
    expect(holder.balance.nanoergs).toBe(holderBefore + BID - 1_000_000n - 1_100_000n);
  });

  it('lets the bidder withdraw an unaccepted offer', () => {
    const box = offer();
    const before = bidder.balance.nanoergs;

    const tx = buildCancelOfferTx({
      offerBox: box,
      bidderAddress: bidder.address.toString(),
      bidderUtxos: utxosOf(bidder),
      height: chain.height,
    });

    expect(chain.execute(tx, { signers: [bidder] })).toBe(true);
    expect(bidder.balance.nanoergs).toBe(before + BID - 1_100_000n);
    expect(offers.utxos.length).toBe(0);
  });

  it('rejects a stranger trying to withdraw someone else\'s offer', () => {
    const box = offer();
    const tx = buildCancelOfferTx({
      offerBox: box,
      bidderAddress: stranger.address.toString(),
      bidderUtxos: utxosOf(stranger),
      height: chain.height,
    });
    expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
  });

  // The core one: the ERG must not be claimable by delivering something else.
  it('rejects delivery of the wrong token', () => {
    const box = offer(NFT);
    const tx = buildAcceptOfferTx({
      offerBox: box,
      tokenId: OTHER, // stranger holds this one, not the token bid on
      bidderAddress: bidder.address.toString(),
      holderAddress: stranger.address.toString(),
      holderUtxos: utxosOf(stranger),
      height: chain.height,
      issuerBox: ISSUER,
    });
    expect(chain.execute(tx, { signers: [stranger], throw: false })).toBe(false);
  });

  it('rejects taking the ERG while delivering the token to someone else', () => {
    const box = offer();
    const tx = buildAcceptOfferTx({
      offerBox: box,
      tokenId: NFT,
      // The holder tries to keep both: token to themselves, ERG to themselves.
      bidderAddress: holder.address.toString(),
      holderAddress: holder.address.toString(),
      holderUtxos: utxosOf(holder),
      height: chain.height,
      issuerBox: ISSUER,
    });
    expect(chain.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  // Same shape as the sale contract's shared-payment attack, from the other
  // side: two funded offers, one delivery. Without the R4 tag the bidder would
  // pay both bids and receive one NFT.
  //
  // Built by hand rather than through buildAcceptOfferTx, because the builder
  // cannot express this — it takes one offer box, and fleet's selector drops
  // any extra it does not need. The attack has to force both in.
  it('rejects two offers settled by one delivery', () => {
    const first = offer(NFT);
    offer(NFT); // a second, independently funded bid on the same token
    expect(offers.utxos.length).toBe(2);

    const tx = new TransactionBuilder(chain.height)
      .from(utxosOf(offers), { ensureInclusion: true })
      .from(utxosOf(holder))
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, bidder.address)
          .addTokens({ tokenId: NFT, amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, first.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  it('allows two offers in one transaction when each gets its own delivery', () => {
    // The control for the test above: same inputs, same funds, differing only
    // in that each offer is settled by its own tagged delivery. Without this
    // passing, the rejection above could be caused by anything.
    holder.addBalance({ tokens: [{ tokenId: OTHER, amount: 1n }] });
    const first = offer(NFT);
    const second = offer(OTHER);

    const tx = new TransactionBuilder(chain.height)
      .from(utxosOf(offers), { ensureInclusion: true })
      .from(utxosOf(holder))
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, bidder.address)
          .addTokens({ tokenId: NFT, amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, first.boxId).toHex() }),
      )
      .to(
        new OutputBuilder(SAFE_MIN_BOX_VALUE, bidder.address)
          .addTokens({ tokenId: OTHER, amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, second.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(RECOMMENDED_MIN_FEE_VALUE)
      .build();

    expect(chain.execute(tx, { signers: [holder] })).toBe(true);
    expect(bidder.balance.tokens).toHaveLength(2);
  });

  it('refuses an offer that would leave the holder with no proceeds', () => {
    expect(() =>
      buildOfferTx({
        tokenId: NFT,
        amount: MIN_OFFER_VALUE - 1n,
        bidderAddress: bidder.address.toString(),
        utxos: utxosOf(bidder),
        height: chain.height,
      issuerBox: ISSUER,
      }),
    ).toThrow(/lowest workable bid/);
  });

  it('allows the exact minimum offer that still has a positive net', () => {
    const box = offer(NFT, MIN_OFFER_VALUE);
    expect(BigInt(box.value)).toBe(MIN_OFFER_VALUE);
  });

  it('refuses to accept a legacy on-chain offer with a non-positive net', () => {
    const funded = offer();
    const unsafe = { ...funded, value: String(MIN_OFFER_VALUE - 1n) };

    expect(() =>
      buildAcceptOfferTx({
        offerBox: unsafe,
        tokenId: NFT,
        bidderAddress: bidder.address.toString(),
        holderAddress: holder.address.toString(),
        holderUtxos: utxosOf(holder),
        height: chain.height,
      issuerBox: ISSUER,
      }),
    ).toThrow(/no proceeds/);
  });

  it('rejects malformed R5 rather than inventing a token id', () => {
    expect(offerTokenIdFrom('')).toBeNull();
    expect(offerTokenIdFrom('08cd' + 'ab'.repeat(33))).toBeNull(); // a SigmaProp
    expect(offerTokenIdFrom('0e20' + 'zz'.repeat(32))).toBeNull();
  });
});

describe('pinned offer constants', () => {
  it('still match a fresh compile of offer.es, on both networks', () => {
    const tree = compile(readFileSync(join(__dirname, 'offer.es'), 'utf8'), { version: 1 });
    expect(tree.toHex()).toBe(OFFER_ERGO_TREE);
    expect(tree.toAddress(NETWORK_PREFIX.mainnet).toString()).toBe(ADDRESSES.mainnet.offer);
    expect(tree.toAddress(NETWORK_PREFIX.testnet).toString()).toBe(ADDRESSES.testnet.offer);
  });
});

// ── Taking a bid on a piece you have already listed ────────────────────────
//
// Reported from a real session: an offer arrived on an NFT that was already
// listed, and the Accept button never appeared — the token had left the wallet
// for the sale contract, so the UI concluded it was not the user's to give.
//
// It is theirs. sale.es cancels on the seller's signature with no other
// condition, so one transaction can spend the listing and settle the offer at
// the same time. These tests prove the two contracts agree on that, because
// nothing else does: each was written without knowing about the other.
describe('accepting an offer on a listed piece', () => {
  let chain: MockChain;
  let seller: KeyedMockChainParty;
  let buyer: KeyedMockChainParty;
  let sale: NonKeyedMockChainParty;
  let offerContract: NonKeyedMockChainParty;

  const utxosOf = (p: KeyedMockChainParty | NonKeyedMockChainParty) =>
    p.utxos.toArray() as unknown as FleetBox[];

  beforeEach(() => {
    chain = new MockChain({ height: 1_000_000 });
    seller = chain.newParty('seller');
    buyer = chain.newParty('buyer');
    sale = chain.addParty(SALE_ERGO_TREE, 'sale');
    offerContract = chain.addParty(OFFER_ERGO_TREE, 'offers');
    seller.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: NFT, amount: 1n }] });
    buyer.addBalance({ nanoergs: 50n * ERG });
  });

  /** Lists the NFT, then bids on it from the other wallet. */
  function listedWithABid() {
    chain.execute(
      buildListTx({
        tokenId: NFT,
        price: 9n * ERG,
        sellerAddress: seller.address.toString(),
        utxos: utxosOf(seller),
        height: chain.height,
      issuerBox: ISSUER,
      }),
      { signers: [seller] },
    );
    chain.execute(
      buildOfferTx({
        tokenId: NFT,
        amount: BID,
        bidderAddress: buyer.address.toString(),
        utxos: utxosOf(buyer),
        height: chain.height,
      issuerBox: ISSUER,
      }),
      { signers: [buyer] },
    );
    return { listing: utxosOf(sale)[0], offer: utxosOf(offerContract)[0] };
  }

  it('settles the bid and the listing in one transaction', () => {
    const { listing, offer } = listedWithABid();
    const before = seller.balance.nanoergs;

    const tx = buildAcceptOfferTx({
      offerBox: offer,
      tokenId: NFT,
      bidderAddress: buyer.address.toString(),
      holderAddress: seller.address.toString(),
      holderUtxos: utxosOf(seller),
      listingBox: listing,
      height: chain.height,
      issuerBox: ISSUER,
    });

    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    expect(buyer.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
    // The bid, plus the ERG that was locked in the listing box, minus the
    // delivery box and the fee.
    expect(seller.balance.nanoergs).toBe(before + BID + 1_000_000n - 1_000_000n - 1_100_000n);
    expect(sale.utxos.length).toBe(0);
    expect(offerContract.utxos.length).toBe(0);
  });

  it('will not let anyone but the seller do it', () => {
    // The listing is spent through sale.es's cancel branch, which is the
    // seller's signature. A stranger holding no claim cannot take the token out.
    const { listing, offer } = listedWithABid();

    const tx = buildAcceptOfferTx({
      offerBox: offer,
      tokenId: NFT,
      bidderAddress: buyer.address.toString(),
      holderAddress: buyer.address.toString(),
      holderUtxos: utxosOf(buyer),
      listingBox: listing,
      height: chain.height,
      issuerBox: ISSUER,
    });

    expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
  });
});
