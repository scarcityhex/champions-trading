// explorer.ts — everything the marketplace knows about live state, read from
// the chain. This file is the reason there is no database (docs/architecture.md
// §1): the two questions a marketplace has to answer are two endpoints.

import { ErgoAddress } from '@fleet-sdk/core';
import { SConstant, serializeBox } from '@fleet-sdk/serializer';
import { blake2b256, hex } from '@fleet-sdk/crypto';

import {
  collectionRootFrom,
  offerTokenIdFrom,
  sellerAddressFrom,
  type FleetBox,
} from './transactions';
import { extractTrades, type RawTx, type Trade } from './history';
import {
  COLLECTION_OFFER_ADDRESS,
  COLLECTION_OFFER_ERGO_TREE,
  EXPLORERS,
  NETWORK,
  NETWORK_PREFIX,
  OFFER_ADDRESS,
  OFFER_ERGO_TREE,
  SALE_ADDRESS,
  SALE_ERGO_TREE,
} from './contract';

/**
 * Explorer mirrors, in preference order.
 *
 * One public API was the only single point of failure left in the design: if it
 * rate-limited us or went down, listings, offers and holders all went with it
 * and the site degraded to a catalogue. Everything else here is either on chain
 * or a static file.
 *
 * The mainnet pair serve the identical v1 shape — verified against the four
 * endpoints this file uses, returning the same totals for the same queries. A
 * mirror that drifts from that shape is worse than no mirror, so adding one
 * means checking it, not just appending a URL.
 *
 * Testnet has a single public explorer and therefore no fallback. That is
 * acceptable there and would not be on mainnet: testnet downtime costs a
 * developer some time, mainnet downtime costs users their order book.
 */
export const EXPLORER_MIRRORS: readonly string[] = EXPLORERS[NETWORK];

/**
 * Which mirror to try first.
 *
 * Sticky, because the point of a fallback is not to pay the failing mirror's
 * timeout on every single request while it is down. It advances on an outage
 * and drifts back to the primary after a cooldown, so a blip does not
 * permanently demote the main explorer.
 */
let preferred = 0;
let demotedAt = 0;
const RETRY_PRIMARY_AFTER = 60_000;
const EXPLORER_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
const MAX_UNSPENT_PAGES = 50;

/** Nine decimals: 1 ERG = 1e9 nanoERG. */
export const NANO = 1_000_000_000n;

/** A box as the explorer returns it — registers are objects, values are strings. */
export type ExplorerBox = {
  boxId: string;
  transactionId: string;
  index: number;
  value: string | number;
  address: string;
  ergoTree: string;
  creationHeight: number;
  assets: Array<{ tokenId: string; amount: string | number }>;
  additionalRegisters: Record<string, { serializedValue: string; renderedValue?: string }>;
};

/**
 * Explorer shape -> fleet shape.
 *
 * The two disagree on registers: the explorer nests each one as
 * `{serializedValue, sigmaType, renderedValue}` while fleet wants the raw hex
 * string. Feeding an explorer box straight into TransactionBuilder produces a
 * transaction whose registers serialize as `[object Object]` and which the node
 * rejects, so this conversion is mandatory on every path that spends a box read
 * from the explorer.
 */
export function toFleetBox(box: ExplorerBox): FleetBox {
  const registers: Record<string, string> = {};
  for (const [name, reg] of Object.entries(box.additionalRegisters ?? {})) {
    if (reg?.serializedValue) registers[name] = reg.serializedValue;
  }
  return {
    boxId: box.boxId,
    transactionId: box.transactionId,
    index: box.index,
    ergoTree: box.ergoTree,
    creationHeight: box.creationHeight,
    value: String(box.value),
    assets: (box.assets ?? []).map((a) => ({ tokenId: a.tokenId, amount: String(a.amount) })),
    additionalRegisters: registers,
  };
}

/**
 * A token's issuer box — the box whose id IS the token id.
 *
 * On Ergo a token's id is the id of the first input of its minting
 * transaction, so `/boxes/{tokenId}` returns that box rather than the one the
 * token ended up in. The distinction is easy to miss and expensive to get
 * wrong: `/tokens/{id}.boxId` points at the minting OUTPUT, which carries the
 * EIP-004 name and image and no royalty at all. Reading that one and concluding
 * "no royalty declared" is a mistake this project has already made once.
 *
 * Cached for the session. An issuer box is immutable and already spent — it can
 * never change, so re-fetching it per listing is pure latency.
 */
const issuerBoxes = new Map<string, FleetBox | null>();

export async function issuerBoxOf(tokenId: string): Promise<FleetBox | null> {
  const cached = issuerBoxes.get(tokenId);
  if (cached !== undefined) return cached;
  try {
    // In a browser this must go through our own origin. The site's CSP sets
    // `connect-src 'self'`, so a direct call to the explorer is blocked — which
    // would break listing and buying while every test still passed.
    //
    // Both paths yield the RAW explorer shape, so the conversion below happens
    // exactly once. Converting twice drops every register.
    const box =
      typeof window === 'undefined'
        ? ((await api(`/boxes/${tokenId}`)) as ExplorerBox)
        : await viaOwnOrigin(tokenId);

    // Recomputed, not taken on trust.
    //
    // Comparing the declared `boxId` only checks that the explorer answered the
    // question we asked. The contract checks something stronger: that the box's
    // CONTENT hashes to the token id. A malformed or tampered response could
    // carry the right id beside different bytes, and the listing built from it
    // would lock an NFT nobody could ever buy. Hashing here costs microseconds
    // and closes the gap between what we verified and what the script will.
    const converted = box ? toFleetBox(box) : null;
    const value =
      converted &&
      hex.encode(blake2b256(serializeBox(converted as never).toBytes())) === tokenId
        ? converted
        : null;
    issuerBoxes.set(tokenId, value);
    return value;
  } catch {
    return null; // not cached: a transient failure should be retried
  }
}

async function viaOwnOrigin(tokenId: string): Promise<ExplorerBox | null> {
  const res = await fetch(`/api/issuer/${tokenId}`, {
    signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { box?: ExplorerBox };
  return body.box ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only these mean "this mirror is unwell". Everything else is an answer. */
function isOutage(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function api<T>(pathname: string, fresh = false): Promise<T> {
  if (preferred !== 0 && Date.now() - demotedAt > RETRY_PRIMARY_AFTER) preferred = 0;

  let lastError: unknown = null;

  // Two passes: a mirror that fails once often succeeds on the next try, and
  // rotating away before retrying costs nothing.
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < EXPLORER_MIRRORS.length; i++) {
      const index = (preferred + i) % EXPLORER_MIRRORS.length;
      try {
        // Cached by default so a busy gallery is one explorer read per 30s for
        // everyone. `fresh` is reserved for trusted background work such as
        // the sales indexer checking its scan height; it is deliberately not
        // exposed as a public API query parameter.
        const res = await fetch(
          `${EXPLORER_MIRRORS[index]}${pathname}`,
          fresh
            ? { cache: 'no-store', signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS) }
            : { next: { revalidate: 30 }, signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS) },
        );

        if (isOutage(res.status)) throw new Error(`HTTP ${res.status}`);

        // A 404 is the mirror answering, and every other mirror will answer the
        // same. Rotating would just spend a second round trip to be told no
        // again, so this returns rather than falls through.
        if (!res.ok) throw Object.assign(new Error(`explorer ${res.status} on ${pathname}`), {
          final: true,
        });

        if (index !== preferred) {
          preferred = index;
          demotedAt = Date.now();
        }
        return (await res.json()) as T;
      } catch (e) {
        if ((e as { final?: boolean })?.final) throw e;
        lastError = e;
      }
    }
    if (round === 0) await sleep(400);
  }

  throw new Error(
    `all explorer mirrors failed on ${pathname}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** Unspent boxes at an address, following pagination to the end. */
export async function unspentAt(address: string, fresh = false): Promise<ExplorerBox[]> {
  const out: ExplorerBox[] = [];
  for (let pageNumber = 0; pageNumber < MAX_UNSPENT_PAGES; pageNumber++) {
    const offset = pageNumber * PAGE_SIZE;
    const page = await api<{ items: ExplorerBox[]; total: number }>(
      `/boxes/unspent/byAddress/${address}?limit=${PAGE_SIZE}&offset=${offset}`,
      fresh,
    );

    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0) {
      throw new Error('explorer returned an invalid unspent-box page');
    }

    out.push(...page.items);
    if (out.length >= page.total || page.items.length === 0) return out;
  }

  throw new Error(`explorer pagination exceeded ${MAX_UNSPENT_PAGES} pages`);
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** Validate fields shared by contract boxes and holder lookup responses. */
function hasValidBoxShape(box: ExplorerBox): boolean {
  if (
    typeof box.address !== 'string' ||
    typeof box.ergoTree !== 'string' ||
    !Array.isArray(box.assets) ||
    !box.additionalRegisters ||
    typeof box.additionalRegisters !== 'object'
  ) {
    return false;
  }
  if (!HEX_64.test(box.boxId) || !HEX_64.test(box.transactionId)) return false;
  if (!Number.isSafeInteger(box.index) || box.index < 0) return false;
  if (!Number.isSafeInteger(box.creationHeight) || box.creationHeight < 0) return false;
  try {
    const parsedAddress = ErgoAddress.fromBase58(box.address);
    return (
      BigInt(box.value) > 0n &&
      parsedAddress.network === NETWORK_PREFIX[NETWORK] &&
      parsedAddress.ergoTree.toLowerCase() === box.ergoTree.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Reject boxes that merely claim to belong to one of our contracts. */
function isExpectedContractBox(
  box: ExplorerBox,
  address: string,
  ergoTree: string,
): boolean {
  return (
    hasValidBoxShape(box) &&
    box.address === address &&
    box.ergoTree.toLowerCase() === ergoTree
  );
}

/** Decode the authenticated register bytes; renderedValue is explorer UI data. */
function longRegister(serialized: string | undefined): bigint | null {
  if (!serialized) return null;
  try {
    const constant = SConstant.from<bigint>(serialized);
    return constant.type.code === 0x05 && typeof constant.data === 'bigint'
      ? constant.data
      : null;
  } catch {
    return null;
  }
}

export type Listing = {
  boxId: string;
  tokenId: string;
  /** Asking price in nanoERG. */
  price: bigint;
  /** ERG locked in the listing box itself — returns to the seller on cancel. */
  boxValue: bigint;
  /** The seller's address, decoded from R4. */
  seller: string;
  /** The box itself, ready to be spent by a buy or cancel. */
  box: FleetBox;
};

/**
 * Every live listing at the sale contract.
 *
 * This IS the order book. A listing exists because a box exists; it disappears
 * the moment that box is spent, with no cache to invalidate and no row to
 * delete. Nothing here can drift out of sync with reality, because it is read
 * from reality.
 *
 * Boxes that do not parse are skipped rather than thrown on: anyone may send
 * anything to a contract address, and one malformed box must not blank the
 * whole marketplace.
 */
export async function fetchListings(fresh = false, contractAddress = SALE_ADDRESS): Promise<Listing[]> {
  const boxes = await unspentAt(contractAddress, fresh);
  const listings: Listing[] = [];
  for (const box of boxes) {
    if (!isExpectedContractBox(box, contractAddress, SALE_ERGO_TREE)) continue;

    const price = longRegister(box.additionalRegisters?.R5?.serializedValue);
    const asset = box.assets?.[0];
    const seller = sellerAddressFrom(box.additionalRegisters?.R4?.serializedValue ?? '');
    // A listing missing any of these cannot be bought or cancelled by anyone,
    // so showing it would only offer the user a button that always fails.
    if (price === null || price <= 0n || box.assets.length !== 1 || !asset || !seller) continue;
    try {
      if (!HEX_64.test(asset.tokenId) || BigInt(asset.amount) !== 1n) continue;
      listings.push({
        boxId: box.boxId,
        tokenId: asset.tokenId,
        price,
        boxValue: BigInt(box.value),
        seller,
        box: toFleetBox(box),
      });
    } catch {
      continue;
    }
  }
  return listings;
}

export type Offer = {
  boxId: string;
  tokenId: string;
  /** The bid. On offer.es this IS the box's ERG — there is no price register,
   *  so an offer can never advertise more than it has funded. */
  amount: bigint;
  bidder: string;
  box: FleetBox;
};

/**
 * Every live offer at the offer contract.
 *
 * Same story as listings: the offers ARE the boxes. A bid that has been
 * accepted or withdrawn stops existing the moment its box is spent.
 */
export async function fetchOffers(fresh = false, contractAddress = OFFER_ADDRESS): Promise<Offer[]> {
  const boxes = await unspentAt(contractAddress, fresh);
  const offers: Offer[] = [];
  for (const box of boxes) {
    if (!isExpectedContractBox(box, contractAddress, OFFER_ERGO_TREE)) continue;

    const tokenId = offerTokenIdFrom(box.additionalRegisters?.R5?.serializedValue ?? '');
    const bidder = sellerAddressFrom(box.additionalRegisters?.R4?.serializedValue ?? '');
    if (!tokenId || !HEX_64.test(tokenId) || !bidder || box.assets.length !== 0) continue;
    try {
      if (BigInt(box.value) <= 0n) continue;
      offers.push({
        boxId: box.boxId,
        tokenId,
        amount: BigInt(box.value),
        bidder,
        box: toFleetBox(box),
      });
    } catch {
      continue;
    }
  }
  return offers;
}

export type CollectionOffer = {
  boxId: string;
  /** Merkle root naming the collection this bid covers. */
  root: string;
  amount: bigint;
  bidder: string;
  box: FleetBox;
};

/**
 * Every live collection-wide bid.
 *
 * Unlike a specific offer, this one names a Merkle root rather than a token —
 * it covers any piece whose id is in that tree. Which collection that is comes
 * from matching the root against COLLECTION_ROOTS; a root we do not recognise
 * is skipped, because we could not tell a user what it applies to.
 */
export async function fetchCollectionOffers(
  fresh = false,
  contractAddress = COLLECTION_OFFER_ADDRESS,
): Promise<CollectionOffer[]> {
  const boxes = await unspentAt(contractAddress, fresh);
  const offers: CollectionOffer[] = [];
  for (const box of boxes) {
    if (!isExpectedContractBox(box, contractAddress, COLLECTION_OFFER_ERGO_TREE)) continue;

    const root = collectionRootFrom(box.additionalRegisters?.R5?.serializedValue ?? '');
    const bidder = sellerAddressFrom(box.additionalRegisters?.R4?.serializedValue ?? '');
    if (!root || !HEX_64.test(root) || !bidder || box.assets.length !== 0) continue;
    try {
      if (BigInt(box.value) <= 0n) continue;
      offers.push({
        boxId: box.boxId,
        root,
        amount: BigInt(box.value),
        bidder,
        box: toFleetBox(box),
      });
    } catch {
      continue;
    }
  }
  return offers;
}

/**
 * Trades settled recently, read straight from the chain.
 *
 * The Activity page used to show only what a cron had written to a file, so a
 * trade took up to a scheduled run to appear — and GitHub will not schedule
 * more often than every five minutes, nor promise even that. But recent trades
 * never needed an index: they are the first page of each contract's
 * transactions, the same read the order book already does.
 *
 * The indexed file still earns its place for deep history, where walking
 * hundreds of pages per request would not. This covers the shallow end, so the
 * page is current without waiting for anything.
 */
export async function recentTrades(fresh = false, perContract = 30): Promise<Trade[]> {
  const contracts = {
    sale: SALE_ADDRESS,
    offer: OFFER_ADDRESS,
    collectionOffer: COLLECTION_OFFER_ADDRESS,
  };

  const pages = await Promise.all(
    Object.values(contracts).map((address) =>
      api<{ items: RawTx[] }>(
        `/addresses/${address}/transactions?limit=${perContract}&offset=0`,
        fresh,
      ).catch(() => ({ items: [] as RawTx[] })),
    ),
  );

  const trades = pages.flatMap((page) =>
    (page.items ?? []).flatMap((tx) => extractTrades(tx, contracts)),
  );

  // One transaction can appear under two contracts — accepting a bid on a
  // listed piece spends a box at each — so the same trade would be counted
  // twice without this. Keyed by the box it settled, as everywhere else.
  const byBox = new Map(trades.map((t) => [t.boxId, t]));
  return [...byBox.values()].sort((a, b) => b.height - a.height);
}

/** Current chain height, for telling how far behind an index has fallen. */
export async function chainHeight(fresh = false): Promise<number | null> {
  try {
    const info = await api<{ height: number }>('/info', fresh);
    return typeof info.height === 'number' ? info.height : null;
  } catch {
    return null;
  }
}

/**
 * Who holds an NFT right now, or null if it sits in a contract rather than a
 * wallet. Ergo tokens are one-of-one here (emission 1), so the box holding the
 * token is the owner — there is no balance to sum.
 */
export async function holderOf(tokenId: string): Promise<string | null> {
  const page = await api<{ items: ExplorerBox[] }>(`/boxes/unspent/byTokenId/${tokenId}?limit=1`);
  if (!Array.isArray(page.items)) throw new Error('explorer returned an invalid holder page');
  const box = page.items[0];
  if (!box) return null;
  if (!hasValidBoxShape(box)) throw new Error('explorer returned an invalid holder box');

  const asset = box.assets.find((candidate) => candidate?.tokenId === tokenId);
  if (!asset) throw new Error('explorer holder box does not contain the requested NFT');

  let amount: bigint;
  try {
    amount = BigInt(asset.amount);
  } catch {
    throw new Error('explorer holder box has an invalid token amount');
  }
  if (amount !== 1n) {
    throw new Error('explorer holder box does not contain a one-of-one NFT');
  }

  return box.address;
}

export const toErg = (nano: bigint): string => {
  const negative = nano < 0n;
  const absolute = negative ? -nano : nano;
  const whole = absolute / NANO;
  const frac = (absolute % NANO).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${frac ? `${whole}.${frac}` : whole}`;
};

/**
 * Same value, rounded for a summary readout.
 *
 * `toErg` is exact by design: a price is a number someone has to match to the
 * nanoERG, and rounding one would advertise a listing nobody can buy at the
 * figure shown. A derived statistic is the opposite case — an average of six
 * trades is a quotient, and printing `1.216666666` claims a precision the
 * number does not have while being harder to read than the fact it conveys.
 *
 * Rounds half away from zero in integer arithmetic. Going through Number would
 * reintroduce exactly the binary-fraction error that `parseErg` exists to
 * avoid, on values that can exceed what a double represents exactly.
 */
export const toErgRounded = (nano: bigint, decimals = 2): string => {
  const negative = nano < 0n;
  const absolute = negative ? -nano : nano;
  const step = 10n ** BigInt(9 - decimals);
  const units = (absolute + step / 2n) / step;
  const whole = units / 10n ** BigInt(decimals);
  const frac = (units % 10n ** BigInt(decimals))
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  // A rounded-away value keeps its sign off: "-0" reads as a loss that is not
  // there, and this only ever renders totals and averages.
  const sign = negative && units > 0n ? '-' : '';
  return `${sign}${frac ? `${whole}.${frac}` : whole}`;
};

/**
 * "1.5" -> 1500000000n.
 *
 * Parsed by splitting on the decimal point rather than via Number, because
 * `Number("0.1") * 1e9` is 100000000.00000001 and a price that is off by a
 * nanoERG is a listing nobody can buy at the advertised figure. Returns null
 * for anything that is not a plain non-negative decimal.
 */
export function parseErg(input: string): bigint | null {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null;
  const [whole, frac = ''] = text.split('.');
  if (frac.length > 9) return null; // finer than a nanoERG
  return BigInt(whole || '0') * NANO + BigInt(frac.padEnd(9, '0') || '0');
}
