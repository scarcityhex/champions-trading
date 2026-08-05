// explorer.ts — everything the marketplace knows about live state, read from
// the chain. This file is the reason there is no database (docs/architecture.md
// §1): the two questions a marketplace has to answer are two endpoints.

import {
  collectionRootFrom,
  offerTokenIdFrom,
  sellerAddressFrom,
  type FleetBox,
} from './transactions';
import { extractTrades, type RawTx, type Trade } from './history';
import {
  COLLECTION_OFFER_ADDRESS,
  EXPLORERS,
  NETWORK,
  OFFER_ADDRESS,
  SALE_ADDRESS,
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
        // everyone. `fresh` bypasses it for the read that follows a
        // transaction: the user has just changed the chain and must not be
        // shown a snapshot taken before their own action.
        const res = await fetch(
          `${EXPLORER_MIRRORS[index]}${pathname}`,
          fresh ? { cache: 'no-store' } : { next: { revalidate: 30 } },
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
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await api<{ items: ExplorerBox[]; total: number }>(
      `/boxes/unspent/byAddress/${address}?limit=${limit}&offset=${offset}`,
      fresh,
    );
    out.push(...page.items);
    if (out.length >= page.total || page.items.length === 0) return out;
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
    const price = box.additionalRegisters?.R5?.renderedValue;
    const asset = box.assets?.[0];
    const seller = sellerAddressFrom(box.additionalRegisters?.R4?.serializedValue ?? '');
    // A listing missing any of these cannot be bought or cancelled by anyone,
    // so showing it would only offer the user a button that always fails.
    if (!price || !asset || !seller) continue;
    try {
      listings.push({
        boxId: box.boxId,
        tokenId: asset.tokenId,
        price: BigInt(price),
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
    const tokenId = offerTokenIdFrom(box.additionalRegisters?.R5?.serializedValue ?? '');
    const bidder = sellerAddressFrom(box.additionalRegisters?.R4?.serializedValue ?? '');
    if (!tokenId || !bidder) continue;
    try {
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
    const root = collectionRootFrom(box.additionalRegisters?.R5?.serializedValue ?? '');
    const bidder = sellerAddressFrom(box.additionalRegisters?.R4?.serializedValue ?? '');
    if (!root || !bidder) continue;
    try {
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
  return page.items[0]?.address ?? null;
}

export const toErg = (nano: bigint): string => {
  const whole = nano / NANO;
  const frac = (nano % NANO).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
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
