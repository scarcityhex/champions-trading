// royaltyTransactions.test.ts — the EIP-24 split, executed against the script.
//
// The issuer box is not fetched here; it is CONSTRUCTED, and its id is computed
// the way the protocol computes one — blake2b256 over the serialized box. That
// id is then used as the token id, which is exactly the relationship the real
// chain has: a token's id is the id of the first input of its minting
// transaction. Reproducing it locally is what lets a test drive the contract's
// authenticity check rather than trusting it.
//
// The assertion that matters most is not that the creator is paid. It is that
// seller + creator == price, with the buyer paying the advertised figure and
// nothing more. A marketplace that quietly adds to the price at signing time is
// the thing this design exists to avoid.

import { describe, expect, it, beforeEach } from 'vitest';
import { serializeBox } from '@fleet-sdk/serializer';
import { OutputBuilder, SByte, SColl, SInt, TransactionBuilder } from '@fleet-sdk/core';
import { blake2b256, hex } from '@fleet-sdk/crypto';
import {
  MockChain,
  type KeyedMockChainParty,
  type NonKeyedMockChainParty,
} from '@fleet-sdk/mock-chain';
import { SALE_ERGO_TREE } from './contract';
import { buildBuyTx, buildCancelTx, buildListTx, FEE, LISTING_BOX_VALUE, type FleetBox } from './transactions';
import { royaltyOf, royaltyOn, sellerReceives, minimumPrice } from './royalties';

const ERG = 1_000_000_000n;
const PRICE = 10n * ERG;
const RATE = 50; // EIP-24 V1: percentage x 1000, so 5%

describe('EIP-24 royalties, end to end', () => {
  let chain: MockChain;
  let seller: KeyedMockChainParty;
  let buyer: KeyedMockChainParty;
  let creator: KeyedMockChainParty;
  let sale: NonKeyedMockChainParty;
  let issuerBox: FleetBox;
  let NFT: string;

  const utxosOf = (p: KeyedMockChainParty | NonKeyedMockChainParty) =>
    p.utxos.toArray() as unknown as FleetBox[];

  /** A box shaped like a real EIP-24 V1 issuer box, paying `to`. */
  function makeIssuer(rate: number | null, to: KeyedMockChainParty): FleetBox {
    const box = {
      value: 2_000_000n,
      ergoTree: to.address.ergoTree,
      creationHeight: 725_325,
      assets: [],
      additionalRegisters: rate === null ? {} : { R4: SInt(rate).toHex() },
      transactionId: '00'.repeat(32),
      index: 0,
    };
    // A box's id IS the hash of its serialization — the same rule the node
    // applies, which is why the contract can trust `issuer.id == token id`.
    const boxId = hex.encode(blake2b256(serializeBox(box as never).toBytes()));
    return { ...box, boxId } as unknown as FleetBox;
  }

  beforeEach(() => {
    chain = new MockChain({ height: 1_000_000 });
    seller = chain.newParty('seller');
    buyer = chain.newParty('buyer');
    creator = chain.newParty('creator');
    sale = chain.addParty(SALE_ERGO_TREE, 'sale');

    issuerBox = makeIssuer(RATE, creator);
    NFT = issuerBox.boxId;

    seller.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: NFT, amount: 1n }] });
    buyer.addBalance({ nanoergs: 100n * ERG });
  });

  function list(price = PRICE, issuer = issuerBox): FleetBox {
    const tx = buildListTx({
      tokenId: NFT,
      price,
      sellerAddress: seller.address.toString(),
      utxos: utxosOf(seller),
      height: chain.height,
      issuerBox: issuer,
    });
    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    return utxosOf(sale)[0];
  }

  it('reads 5% out of the issuer box rather than a configuration', () => {
    const royalty = royaltyOf(issuerBox);
    expect(royalty).not.toBeNull();
    expect(royalty!.rate).toBe(RATE);
    expect(royalty!.percent).toBe(5);
    expect(royaltyOn(PRICE, royalty)).toBe(ERG / 2n);
  });

  it('splits the advertised price: the buyer pays it, nobody adds to it', () => {
    const box = list();
    const sellerBefore = seller.balance.nanoergs;
    const buyerBefore = buyer.balance.nanoergs;

    const tx = buildBuyTx({
      listingBox: box,
      price: PRICE,
      sellerAddress: seller.address.toString(),
      buyerAddress: buyer.address.toString(),
      buyerUtxos: utxosOf(buyer),
      height: chain.height,
      issuerBox,
    });

    expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
    expect(buyer.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });

    const creatorGot = creator.balance.nanoergs;
    const sellerGot = seller.balance.nanoergs - sellerBefore;

    expect(creatorGot).toBe(ERG / 2n); // 5% of 10
    expect(sellerGot).toBe(19n * ERG / 2n); // the other 95%
    // The invariant worth stating on its own: the split is exactly the price.
    expect(sellerGot + creatorGot).toBe(PRICE);
    // And the buyer paid the advertised price plus only the network's own fee,
    // less the listing box ERG they sweep.
    expect(buyerBefore - buyer.balance.nanoergs).toBe(PRICE + FEE - LISTING_BOX_VALUE);
  });

  it('pays the full price to a seller whose token declares no royalty', () => {
    const plain = makeIssuer(null, creator);
    chain = new MockChain({ height: 1_000_000 });
    seller = chain.newParty('seller');
    buyer = chain.newParty('buyer');
    creator = chain.newParty('creator');
    sale = chain.addParty(SALE_ERGO_TREE, 'sale');
    const noRoyalty = makeIssuer(null, creator);
    seller.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: noRoyalty.boxId, amount: 1n }] });
    buyer.addBalance({ nanoergs: 100n * ERG });
    void plain;

    const listTx = buildListTx({
      tokenId: noRoyalty.boxId,
      price: PRICE,
      sellerAddress: seller.address.toString(),
      utxos: utxosOf(seller),
      height: chain.height,
      issuerBox: noRoyalty,
    });
    expect(chain.execute(listTx, { signers: [seller] })).toBe(true);

    const sellerBefore = seller.balance.nanoergs;
    const tx = buildBuyTx({
      listingBox: utxosOf(sale)[0],
      price: PRICE,
      sellerAddress: seller.address.toString(),
      buyerAddress: buyer.address.toString(),
      buyerUtxos: utxosOf(buyer),
      height: chain.height,
      issuerBox: noRoyalty,
    });
    expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
    expect(seller.balance.nanoergs - sellerBefore).toBe(PRICE);
    expect(creator.balance.nanoergs).toBe(0n);
  });

  // The cancel branch must not depend on anything the purchase branch needs.
  it('still lets the seller cancel', () => {
    const box = list();
    const tx = buildCancelTx({
      listingBox: box,
      sellerAddress: seller.address.toString(),
      sellerUtxos: utxosOf(seller),
      height: chain.height,
    });
    expect(chain.execute(tx, { signers: [seller] })).toBe(true);
    expect(seller.balance.tokens).toContainEqual({ tokenId: NFT, amount: 1n });
  });

  // The authenticity check is the whole basis of trust: a forged issuer box
  // would have to hash to the token id.
  it('refuses a listing whose issuer box is not the token’s', () => {
    const impostor = makeIssuer(1, creator); // 0.1%, and the wrong box entirely
    expect(() =>
      buildListTx({
        tokenId: NFT,
        price: PRICE,
        sellerAddress: seller.address.toString(),
        utxos: utxosOf(seller),
        height: chain.height,
        issuerBox: impostor,
      }),
    ).toThrow(/does not belong to this token/);
  });

  it('will not let a buyer keep the creator’s share', () => {
    const box = list();
    // A transaction that pays the seller the whole price and the creator
    // nothing is what a buyer would build if the split were only a UI
    // convention. The script must reject it.
    const cheating = buildBuyTx({
      listingBox: box,
      price: PRICE,
      sellerAddress: seller.address.toString(),
      buyerAddress: buyer.address.toString(),
      buyerUtxos: utxosOf(buyer),
      height: chain.height,
      issuerBox: makeIssuer(null, creator), // claims there is no royalty
    });
    expect(chain.execute(cheating, { signers: [buyer], throw: false })).toBe(false);
  });

  // ── The hole a review found ─────────────────────────────────────────────
  //
  // When the seller IS the creator, `exists` asked its two questions of the
  // same output: a box paying the seller's 95% also satisfies "at least the 5%
  // royalty, to that same script". The buyer paid 9.5 for a 10 ERG listing and
  // kept the difference. Not a corner case — Mage Champions pays royalty to a
  // plain P2PK, so the creator selling their own piece hit it every time.
  describe('when the seller is also the creator', () => {
    let solo: KeyedMockChainParty;
    let soloIssuer: FleetBox;
    let soloToken: string;

    beforeEach(() => {
      chain = new MockChain({ height: 1_000_000 });
      solo = chain.newParty('seller-and-creator');
      buyer = chain.newParty('buyer');
      sale = chain.addParty(SALE_ERGO_TREE, 'sale');
      soloIssuer = makeIssuer(RATE, solo);
      soloToken = soloIssuer.boxId;
      solo.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: soloToken, amount: 1n }] });
      buyer.addBalance({ nanoergs: 100n * ERG });
      chain.execute(
        buildListTx({
          tokenId: soloToken,
          price: PRICE,
          sellerAddress: solo.address.toString(),
          utxos: utxosOf(solo),
          height: chain.height,
          issuerBox: soloIssuer,
        }),
        { signers: [solo] },
      );
    });

    it('rejects a buyer paying only the 95% share', () => {
      const listing = utxosOf(sale)[0];
      const tx = new TransactionBuilder(chain.height)
        .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
        .to(
          new OutputBuilder(PRICE - (PRICE * BigInt(RATE)) / 1000n, solo.address)
            .setAdditionalRegisters({ R4: SColl(SByte, listing.boxId).toHex() }),
        )
        .sendChangeTo(buyer.address)
        .payFee(FEE)
        .build();

      expect(chain.execute(tx, { signers: [buyer], throw: false })).toBe(false);
    });

    it('takes the whole price in one output, and the builder produces it', () => {
      const before = buyer.balance.nanoergs;
      const soloBefore = solo.balance.nanoergs;
      const tx = buildBuyTx({
        listingBox: utxosOf(sale)[0],
        price: PRICE,
        sellerAddress: solo.address.toString(),
        buyerAddress: buyer.address.toString(),
        buyerUtxos: utxosOf(buyer),
        height: chain.height,
        issuerBox: soloIssuer,
      });
      expect(chain.execute(tx, { signers: [buyer] })).toBe(true);
      expect(solo.balance.nanoergs - soloBefore).toBe(PRICE);
      expect(before - buyer.balance.nanoergs).toBe(PRICE + FEE - LISTING_BOX_VALUE);
    });
  });

  // ── The ways a buyer might try to keep the creator's share ───────────────
  //
  // Added after a review claimed the royalty could be skipped. It could not,
  // but the claim was worth more than a one-off script: these are now the
  // permanent record that each route is closed.
  describe('a buyer trying to keep the royalty', () => {
    const tag = (id: string) => ({ R4: SColl(SByte, id).toHex() });

    /** Builds a purchase by hand, so it can be wrong on purpose. */
    function attempt(outs: (listing: FleetBox) => OutputBuilder[]): boolean {
      const listing = list();
      const tx = new TransactionBuilder(chain.height)
        .from([...sale.utxos.toArray(), ...buyer.utxos.toArray()])
        .to(outs(listing))
        .sendChangeTo(buyer.address)
        .payFee(FEE)
        .build();
      return chain.execute(tx, { signers: [buyer], throw: false });
    }

    const NET = PRICE - (PRICE * BigInt(RATE)) / 1000n;
    const ROY = (PRICE * BigInt(RATE)) / 1000n;

    it('rejects paying only the seller', () => {
      expect(
        attempt((l) => [
          new OutputBuilder(NET, seller.address).setAdditionalRegisters(tag(l.boxId)),
        ]),
      ).toBe(false);
    });

    it('rejects the royalty sent to any other address', () => {
      const thief = chain.newParty('thief');
      expect(
        attempt((l) => [
          new OutputBuilder(NET, seller.address).setAdditionalRegisters(tag(l.boxId)),
          new OutputBuilder(ROY, thief.address).setAdditionalRegisters(tag(l.boxId)),
        ]),
      ).toBe(false);
    });

    // Without the tag, one royalty output could settle two listings from the
    // same collection at once — they share a payout address.
    it('rejects an untagged royalty output', () => {
      expect(
        attempt((l) => [
          new OutputBuilder(NET, seller.address).setAdditionalRegisters(tag(l.boxId)),
          new OutputBuilder(ROY, creator.address),
        ]),
      ).toBe(false);
    });

    it('rejects a royalty short by a single nanoERG', () => {
      expect(
        attempt((l) => [
          new OutputBuilder(NET, seller.address).setAdditionalRegisters(tag(l.boxId)),
          new OutputBuilder(ROY - 1n, creator.address).setAdditionalRegisters(tag(l.boxId)),
        ]),
      ).toBe(false);
    });

    it('accepts the correct split, so the tests above prove something', () => {
      expect(
        attempt((l) => [
          new OutputBuilder(NET, seller.address).setAdditionalRegisters(tag(l.boxId)),
          new OutputBuilder(ROY, creator.address).setAdditionalRegisters(tag(l.boxId)),
        ]),
      ).toBe(true);
    });
  });

  it('refuses a price too small for the royalty to fund its own box', () => {
    const floor = minimumPrice(royaltyOf(issuerBox));
    expect(floor).toBe(20_000_000n); // 0.02 ERG at 5%
    expect(() => list(floor - 1n)).toThrow(/lowest workable price/);
    expect(sellerReceives(floor, royaltyOf(issuerBox))).toBe(19_000_000n);
  });
});

// ── The offer contracts' royalty branch ──────────────────────────────────────
//
// Written after noticing that every test in contracts/offer.test.ts and
// contracts/collection-offer.test.ts builds its issuer box with a null rate.
// Both suites were green and neither had ever executed the branch below, which
// is the same shape of gap that let two economic bugs through earlier.
describe('a bid settles the creator too', () => {
  let chain2: MockChain;
  let bidder: KeyedMockChainParty;
  let holder: KeyedMockChainParty;
  let author: KeyedMockChainParty;
  let offers: NonKeyedMockChainParty;
  let issuer: FleetBox;
  let token: string;
  const BID = 10n * ERG;

  const boxes = (p: KeyedMockChainParty | NonKeyedMockChainParty) =>
    p.utxos.toArray() as unknown as FleetBox[];

  beforeEach(async () => {
    const { OFFER_ERGO_TREE } = await import('./contract');
    chain2 = new MockChain({ height: 1_000_000 });
    bidder = chain2.newParty('bidder');
    holder = chain2.newParty('holder');
    author = chain2.newParty('author');
    offers = chain2.addParty(OFFER_ERGO_TREE, 'offers');

    const raw = {
      value: 2_000_000n,
      ergoTree: author.address.ergoTree,
      creationHeight: 725_325,
      assets: [],
      additionalRegisters: { R4: SInt(RATE).toHex() },
      transactionId: '00'.repeat(32),
      index: 0,
    };
    token = hex.encode(blake2b256(serializeBox(raw as never).toBytes()));
    issuer = { ...raw, boxId: token } as unknown as FleetBox;

    bidder.addBalance({ nanoergs: 100n * ERG });
    holder.addBalance({ nanoergs: 10n * ERG, tokens: [{ tokenId: token, amount: 1n }] });

    const { buildOfferTx } = await import('./transactions');
    expect(
      chain2.execute(
        buildOfferTx({
          tokenId: token,
          amount: BID,
          bidderAddress: bidder.address.toString(),
          utxos: boxes(bidder),
          height: chain2.height,
          issuerBox: issuer,
        }),
        { signers: [bidder] },
      ),
    ).toBe(true);
  });

  it('pays the creator out of the bid, and quotes the holder the truth', async () => {
    const { buildAcceptOfferTx, offerNet } = await import('./transactions');
    const before = holder.balance.nanoergs;

    expect(
      chain2.execute(
        buildAcceptOfferTx({
          offerBox: boxes(offers)[0],
          tokenId: token,
          bidderAddress: bidder.address.toString(),
          holderAddress: holder.address.toString(),
          holderUtxos: boxes(holder),
          height: chain2.height,
          issuerBox: issuer,
        }),
        { signers: [holder] },
      ),
    ).toBe(true);

    expect(bidder.balance.tokens).toContainEqual({ tokenId: token, amount: 1n });
    expect(author.balance.nanoergs).toBe((BID * BigInt(RATE)) / 1000n);
    // What the holder gained must be exactly what the dialog told them.
    expect(holder.balance.nanoergs - before).toBe(offerNet(BID, royaltyOf(issuer)));
  });

  it('rejects an acceptance that keeps the creator’s share', () => {
    const offerBox = boxes(offers)[0];
    const tx = new TransactionBuilder(chain2.height)
      .from([...offers.utxos.toArray(), ...holder.utxos.toArray()], { ensureInclusion: true })
      .to(
        new OutputBuilder(1_000_000n, bidder.address)
          .addTokens({ tokenId: token, amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, offerBox.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(FEE)
      .build();

    expect(chain2.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });

  // The separator the offer contracts rely on: the royalty output carries no
  // token, so the delivery can never be counted as both.
  it('rejects one output trying to be delivery and royalty at once', () => {
    const offerBox = boxes(offers)[0];
    const tx = new TransactionBuilder(chain2.height)
      .from([...offers.utxos.toArray(), ...holder.utxos.toArray()], { ensureInclusion: true })
      .to(
        // Sent to the creator, carrying the token, valued above the royalty —
        // one box pretending to be both required outputs.
        new OutputBuilder((BID * BigInt(RATE)) / 1000n, author.address)
          .addTokens({ tokenId: token, amount: 1n })
          .setAdditionalRegisters({ R4: SColl(SByte, offerBox.boxId).toHex() }),
      )
      .sendChangeTo(holder.address)
      .payFee(FEE)
      .build();

    expect(chain2.execute(tx, { signers: [holder], throw: false })).toBe(false);
  });
});
