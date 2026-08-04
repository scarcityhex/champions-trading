// collections.ts — the static half of the catalog: names, traits, art.
//
// This never changes (the collections are minted out), so it ships as files and
// is indexed once at module load. It is the other half of the no-database
// design: the chain supplies what is volatile, this supplies what is fixed, and
// a listing is the join of the two on tokenId.

import ergoChampions from '@/data/ERGOCHAMPIONSmetadata.json';
import ergoMummy from '@/data/ERGOMUMMYmetadata.json';
import mageChampions from '@/data/MAGECHAMPIONSmetadata.json';
import supply from '@/data/supply.json';

export type Attribute = { trait_type: string; value: string };

export type Nft = {
  /** Human id like "ERGOMU1". NOT unique — see below. */
  id: string;
  name: string;
  edition: number;
  tokenId: string;
  collection: string;
  attributes: Attribute[];
  imageUrl?: string;
  /** SHA-256 of the artwork, from the issuer box's R8. */
  contentHash?: string;
  /**
   * 1 for the first token carrying this `id`, 2 for the second, and so on.
   *
   * Some editions were minted more than once, so `id` is not unique. Files on
   * disk disambiguate with a `-N` suffix (set by the downloader and by
   * gen_thumbs.py); this is the N. Computed once here so no caller has to
   * re-derive it and get it subtly wrong.
   */
  dupIndex: number;
  /**
   * The token no longer exists: no unspent box holds it.
   *
   * Not a curatorial choice — a burned token cannot be listed, bought or
   * delivered by anyone, ever. Two thirds of Ergo Champions is in this state
   * (see docs/supply-audit.md), which is why it is worth carrying as a field
   * rather than discovering per page load.
   */
  burned: boolean;
  /** True when the issuer destroyed it without it ever having been sold. */
  neverSold?: boolean;
};

export type Collection = {
  key: string;
  name: string;
  issuer: string;
  /** Local art directory under /public/art. */
  dir: string;
  /** Every token id ever minted, burned ones included. */
  tokens: Nft[];
  /**
   * The tokens that still exist and can therefore be traded.
   *
   * This is what every user-facing surface should iterate. `tokens` is the
   * historical record; `live` is the collection as it exists today.
   */
  live: Nft[];
  /**
   * Whether the collection is offered in the UI.
   *
   * A hidden collection stays fully wired: its tokens remain in BY_TOKEN_ID, so
   * a listing for one still resolves to the right name, traits and artwork
   * rather than rendering as an unknown token. Only the browsing surface drops
   * it. Removing a collection from the catalog instead would make its listings
   * unidentifiable, which is worse than showing them.
   */
  visible: boolean;
};

type RawDoc = {
  collection?: { name?: string; ownership?: { issuerAddress?: string } };
  tokens: Array<{ id: string; metadata: Omit<Nft, 'id' | 'dupIndex' | 'burned' | 'neverSold'> }>;
};

/** tokenId -> burn record, from scripts/audit-supply.mjs. */
const BURNED = (supply as { burned?: Record<string, { neverLeftIssuer?: boolean }> }).burned ?? {};

function build(key: string, dir: string, raw: unknown, visible = true): Collection {
  const doc = raw as RawDoc;
  const seen = new Map<string, number>();
  const tokens: Nft[] = doc.tokens.map((t) => {
    const dupIndex = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, dupIndex);
    const burn = BURNED[t.metadata.tokenId];
    return {
      id: t.id,
      dupIndex,
      ...t.metadata,
      burned: Boolean(burn),
      neverSold: burn?.neverLeftIssuer,
    };
  });

  return {
    key,
    dir,
    visible,
    name: doc.collection?.name ?? key,
    issuer: doc.collection?.ownership?.issuerAddress ?? '',
    tokens,
    live: tokens.filter((t) => !t.burned),
  };
}

/** Every collection the app knows how to identify. */
export const COLLECTIONS: Collection[] = [
  build('ERGOCHAMPIONS', 'ErgoChampions', ergoChampions),
  build('ERGOMUMMY', 'ErgoMummy', ergoMummy),
  build('MAGECHAMPIONS', 'MageChampions', mageChampions),
];

/** The collections offered for browsing. Use this for anything user-facing. */
export const VISIBLE_COLLECTIONS: Collection[] = COLLECTIONS.filter((c) => c.visible);

/**
 * tokenId -> NFT. The only lookup that is safe.
 *
 * Two things make the human-readable `id` unusable as a key, and both are real
 * in these collections rather than theoretical:
 *
 *   1. The same edition was minted more than once (Ergo Champions #1-#5, Mage
 *      Champions #199, twelve numbers in Ergo Mummy — seven of those carrying
 *      different artwork under the same number). So `id` collides.
 *   2. Ergo does not reserve token names. Anyone can mint a token called
 *      "Ergo Champions #1" today. Names prove nothing.
 *
 * A token id, by contrast, is derived from the first input box of the minting
 * transaction and cannot be reissued. Membership in a collection means being in
 * this map — never a name match, never an edition number.
 */
export const BY_TOKEN_ID: Map<string, Nft> = new Map(
  COLLECTIONS.flatMap((c) => c.tokens.map((t) => [t.tokenId, t] as const)),
);

export const collectionOf = (tokenId: string): Collection | undefined =>
  COLLECTIONS.find((c) => c.tokens.some((t) => t.tokenId === tokenId));

/**
 * How many surviving tokens in a collection carry each trait value.
 *
 * Rarity is the main thing a buyer wants and the main thing a marketplace can
 * get wrong, so it is counted from the catalog rather than taken from any
 * "rarity rank" the collection shipped with — those are somebody else's
 * arithmetic over a token list we cannot check.
 *
 * Counted over `live`, not `tokens`. Ergo Champions minted 1,498 and burned
 * 1,005 of them: a trait held by 161 of the original mint might be held by 40
 * of what remains, and the second number is the one a buyer is competing over.
 * Quoting rarity against a supply that no longer exists is a real
 * misrepresentation, not a rounding choice.
 *
 * Computed once per collection and cached.
 */
const traitCache = new Map<string, Map<string, Map<string, number>>>();

export function traitCounts(collection: Collection): Map<string, Map<string, number>> {
  const cached = traitCache.get(collection.key);
  if (cached) return cached;

  const counts = new Map<string, Map<string, number>>();
  for (const token of collection.live) {
    for (const attr of token.attributes ?? []) {
      if (!counts.has(attr.trait_type)) counts.set(attr.trait_type, new Map());
      const values = counts.get(attr.trait_type)!;
      values.set(attr.value, (values.get(attr.value) ?? 0) + 1);
    }
  }
  traitCache.set(collection.key, counts);
  return counts;
}

/**
 * Rarity percentile per token: 0.2 means the rarest piece in the collection.
 *
 * Score is the standard sum of inverse frequencies — for each trait,
 * `surviving / how many share this value` — then every token is ranked and the
 * rank expressed as a percentage. A raw score means nothing to a collector;
 * "top 3%" places the piece immediately.
 *
 * That formula has one well-known flaw: it rewards tokens that simply carry
 * more traits. It does not apply here, and that was checked rather than
 * assumed — within each collection every token has exactly the same number of
 * traits (9, 10 and 6). If a collection ever breaks that, this needs revisiting.
 *
 * Traits with a single value across the collection are excluded. Ergo Champions
 * is all "skeleton" and Mage Champions all "base": a trait everyone shares
 * distinguishes nobody, and including it only adds the same constant to every
 * score.
 *
 * Computed over `live`, and at runtime rather than baked into the JSON. Rarity
 * is a function of surviving supply, so a precomputed file would go quietly
 * wrong the next time a token burns, with nothing to catch it. The whole pass
 * costs ~4 ms for the largest collection and is cached per collection, so it is
 * paid once.
 */
const rarityCache = new Map<string, Map<string, number>>();

export function rarityPercentiles(collection: Collection): Map<string, number> {
  const cached = rarityCache.get(collection.key);
  if (cached) return cached;

  const counts = traitCounts(collection);
  const total = collection.live.length;

  const scored = collection.live.map((token) => {
    let score = 0;
    for (const attr of token.attributes ?? []) {
      const values = counts.get(attr.trait_type);
      if (!values || values.size <= 1) continue;
      const n = values.get(attr.value);
      if (n) score += total / n;
    }
    return { tokenId: token.tokenId, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const out = new Map<string, number>();
  scored.forEach((entry, i) => {
    // Rank 1 of 493 reads as 0.2%, not 0%: nothing is in the top nothing.
    out.set(entry.tokenId, ((i + 1) / total) * 100);
  });

  rarityCache.set(collection.key, out);
  return out;
}

/**
 * Does this token answer a search for `#<number>`?
 *
 * Exact on the edition number rather than a substring: typing 4 should not bury
 * #4 under #40 through #499. Several tokens can legitimately share a number —
 * the repeated editions — and every one of them matches, which is the honest
 * answer rather than picking one arbitrarily.
 */
export function matchesEdition(nft: Nft, query: string): boolean {
  const wanted = query.trim().replace(/^#/, '');
  if (!wanted) return true;
  const n = Number(wanted);
  return Number.isInteger(n) && nft.edition === n;
}

/** `top 2.4%` — the label a card shows. */
export function rarityLabel(percentile: number | undefined): string | null {
  if (percentile === undefined) return null;
  return `top ${percentile < 10 ? percentile.toFixed(1) : Math.round(percentile)}%`;
}

/** Filename stem on disk, disambiguating repeated editions. */
const fileStem = (nft: Nft): string => (nft.dupIndex > 1 ? `${nft.id}-${nft.dupIndex}` : nft.id);

/**
 * The gallery derivative: ~320px WebP, built by scripts/gen_thumbs.py.
 *
 * This is what cards should load. The originals are 1000px and 2048px, and a
 * screen of them is hundreds of megabytes to render tiles a fifth that wide.
 */
export const thumbUrl = (nft: Nft, dir: string): string => `/thumbs/${dir}/${fileStem(nft)}.webp`;

/**
 * The detail derivative: ~768px WebP, also built by scripts/gen_thumbs.py.
 *
 * What a token page should load. The originals are 1000px and 2048px and up to
 * 1.5 MB each; on a page where someone is deciding whether to spend money,
 * waiting on an IPFS gateway for that is the wrong trade.
 */
export const detailUrl = (nft: Nft, dir: string): string =>
  `/detail/${dir}/${fileStem(nft)}.webp`;

/**
 * The full-size original, if a copy has been placed in public/art.
 *
 * Not committed — the three collections are about 2 GB. This exists so a
 * deployment that does host them can serve them, and is simply skipped when the
 * folder is absent.
 */
export function artUrl(nft: Nft, dir: string): string {
  const ext = nft.imageUrl?.split('?')[0].match(/\.([a-z0-9]{3,4})$/i)?.[1]?.toLowerCase() ?? 'png';
  return `/art/${dir}/${fileStem(nft)}.${ext}`;
}

/** The canonical source: whatever the issuer box's R9 points at. */
export const ipfsUrl = (nft: Nft): string | undefined =>
  nft.imageUrl?.startsWith('ipfs://')
    ? `https://ipfs.io/ipfs/${nft.imageUrl.slice('ipfs://'.length)}`
    : nft.imageUrl;

/** True when this deployment also serves the full-size originals. */
const HOSTS_ORIGINALS = process.env.NEXT_PUBLIC_HOST_ORIGINALS === 'true';

/**
 * Cheapest-first list of places to find an NFT's picture.
 *
 * Thumbnail, detail derivative, then IPFS, which is the canonical source and
 * always last. A view walks this on error, so a gap at any level degrades to a
 * slower source instead of a blank tile — and the local levels are genuinely
 * incomplete: 176 Mage Champions were never downloaded.
 *
 * The full-size original is only offered when the deployment actually hosts it.
 * Including it unconditionally would spend a guaranteed 404 per image on every
 * deploy that does not.
 */
export const imageSources = (nft: Nft, dir: string): string[] =>
  [
    thumbUrl(nft, dir),
    detailUrl(nft, dir),
    ...(HOSTS_ORIGINALS ? [artUrl(nft, dir)] : []),
    ipfsUrl(nft),
  ].filter((u): u is string => Boolean(u));

/** Same chain, but starting at the detail tier — for a full-bleed view. */
export const detailSources = (nft: Nft, dir: string): string[] =>
  imageSources(nft, dir).filter((u) => !u.startsWith('/thumbs/'));
