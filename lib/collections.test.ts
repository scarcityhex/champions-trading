// collections.test.ts — integrity of the static catalog.
//
// The catalog is the only thing standing between a buyer and a forgery. Ergo
// does not reserve token names, so "Ergo Champions #1" can be minted by anyone,
// today, for a few cents. What makes a token genuine is being in this list — so
// if the list is wrong, the marketplace endorses a fake.
//
// These tests are offline and cheap. The online counterpart, which asks the
// chain whether every id was really issued by the collection's issuer, is
// scripts/verify-catalog.ts — slower, and the one to run before deploying.

import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  VISIBLE_COLLECTIONS,
  BY_TOKEN_ID,
  thumbUrl,
  imageSources,
  detailSources,
  traitCounts,
} from './collections';

const HEX64 = /^[0-9a-f]{64}$/;

describe('catalog', () => {
  it('has all three collections, none empty', () => {
    expect(COLLECTIONS.map((c) => c.key)).toEqual(['ERGOCHAMPIONS', 'ERGOMUMMY', 'MAGECHAMPIONS']);
    for (const c of COLLECTIONS) expect(c.tokens.length).toBeGreaterThan(0);
  });

  it('records an issuer address for every collection', () => {
    // Without this the "who minted it" claim on the detail page is unbacked.
    for (const c of COLLECTIONS) {
      expect(c.issuer, c.key).toMatch(/^9[a-zA-Z0-9]{50}$/);
    }
  });

  it('gives every token a well-formed token id', () => {
    for (const c of COLLECTIONS) {
      for (const t of c.tokens) {
        expect(t.tokenId, `${c.key} ${t.id}`).toMatch(HEX64);
      }
    }
  });

  // The one that would actually let a forgery through: if two entries shared a
  // token id, one would shadow the other in BY_TOKEN_ID and a listing could
  // resolve to the wrong artwork and the wrong provenance.
  it('has globally unique token ids', () => {
    const all = COLLECTIONS.flatMap((c) => c.tokens.map((t) => t.tokenId));
    expect(BY_TOKEN_ID.size).toBe(all.length);
  });

  it('never lets two collections claim the same token', () => {
    const owner = new Map<string, string>();
    for (const c of COLLECTIONS) {
      for (const t of c.tokens) {
        expect(owner.has(t.tokenId), `${t.tokenId} in two collections`).toBe(false);
        owner.set(t.tokenId, c.key);
      }
    }
  });

  // Documented in docs/architecture.md §3 and README. This test exists so the
  // duplicates are a known, asserted property rather than a surprise — code
  // that assumes `id` is unique will break on exactly these.
  it('still contains the known duplicate editions', () => {
    const dupes = COLLECTIONS.flatMap((c) => {
      const seen = new Set<string>();
      return c.tokens.filter((t) => (seen.has(t.id) ? true : (seen.add(t.id), false)));
    });
    expect(dupes.length).toBeGreaterThan(0);
    // Duplicated `id`, but each is still its own distinct token on chain.
    const ids = new Set(dupes.map((d) => d.tokenId));
    expect(ids.size).toBe(dupes.length);
  });

  it('points every token at artwork', () => {
    for (const c of COLLECTIONS) {
      const missing = c.tokens.filter((t) => !t.imageUrl);
      expect(missing.length, `${c.key}: ${missing.length} without imageUrl`).toBe(0);
    }
  });

  // The `visible` flag exists so a collection can be pulled from browsing
  // without being forgotten. Asserting the mechanism rather than which
  // collections happen to be on today: the second changes with a product
  // decision, the first must never break.
  it('offers exactly the collections marked visible', () => {
    expect(VISIBLE_COLLECTIONS).toEqual(COLLECTIONS.filter((c) => c.visible));
    expect(VISIBLE_COLLECTIONS.length).toBeGreaterThan(0);
  });

  it('keeps a hidden collection fully identifiable', () => {
    // A listing for a hidden collection's token must still resolve to the right
    // name and artwork — hiding is a browsing decision, not an erasure. Holds
    // trivially when nothing is hidden, and catches the regression when
    // something is.
    for (const c of COLLECTIONS.filter((x) => !x.visible)) {
      for (const t of c.tokens) {
        expect(BY_TOKEN_ID.get(t.tokenId)?.name).toBe(t.name);
      }
    }
  });

  // Repeated editions share an `id`, so their files carry a `-N` suffix. If
  // dupIndex were dropped, every twin would point at the first one's picture.
  it('gives repeated editions distinct image paths', () => {
    for (const c of COLLECTIONS) {
      const byId = new Map<string, string[]>();
      for (const t of c.tokens) {
        if (!byId.has(t.id)) byId.set(t.id, []);
        byId.get(t.id)!.push(thumbUrl(t, c.dir));
      }
      for (const [id, urls] of byId) {
        expect(new Set(urls).size, `${c.key} ${id} shares a thumbnail path`).toBe(urls.length);
      }
    }
  });

  it('offers thumbnail, detail tier, then IPFS, in that order', () => {
    const nft = COLLECTIONS[0].tokens[0];
    const [thumb, detail, remote] = imageSources(nft, COLLECTIONS[0].dir);
    expect(thumb).toMatch(/^\/thumbs\/.+\.webp$/);
    expect(detail).toMatch(/^\/detail\/.+\.webp$/);
    // IPFS is the canonical source and therefore always the last resort, never
    // the first request.
    expect(remote).toMatch(/^https:\/\//);
  });

  it('does not offer the originals unless this deployment hosts them', () => {
    // public/art is ~2 GB and not committed. Requesting it on a deploy that
    // lacks it spends a guaranteed 404 on every single image before falling
    // through, which is the cost this gate exists to avoid.
    const nft = COLLECTIONS[0].tokens[0];
    const hosting = process.env.NEXT_PUBLIC_HOST_ORIGINALS === 'true';
    const hasArt = imageSources(nft, COLLECTIONS[0].dir).some((u) => u.startsWith('/art/'));
    expect(hasArt).toBe(hosting);
  });

  it('starts a detail view below the thumbnail', () => {
    // A token page showing the 320px tile would look worse than the gallery it
    // came from.
    const nft = COLLECTIONS[0].tokens[0];
    const chain = detailSources(nft, COLLECTIONS[0].dir);
    expect(chain[0]).toMatch(/^\/detail\//);
    expect(chain.some((u) => u.startsWith('/thumbs/'))).toBe(false);
  });

  // A burned token cannot be listed, bought or delivered by anyone. Showing one
  // in the gallery invites a user to fund a bid that can never be settled.
  it('keeps burned tokens out of the tradable set', () => {
    for (const c of COLLECTIONS) {
      expect(c.live.every((t) => !t.burned)).toBe(true);
      expect(c.live.length + c.tokens.filter((t) => t.burned).length).toBe(c.tokens.length);
    }
  });

  it('still resolves a burned token by id', () => {
    // The detail page has to tell a visitor "this was destroyed", which it can
    // only do if the catalog still knows the token. Dropping burned tokens
    // outright would route them to the forgery warning instead — a false
    // accusation about a piece that was genuine.
    const burned = COLLECTIONS.flatMap((c) => c.tokens).filter((t) => t.burned);
    expect(burned.length).toBeGreaterThan(0);
    for (const t of burned.slice(0, 25)) {
      expect(BY_TOKEN_ID.get(t.tokenId)?.name).toBe(t.name);
    }
  });

  it('counts rarity against surviving supply, not the original mint', () => {
    const c = COLLECTIONS.find((x) => x.tokens.length > x.live.length)!;
    const counts = traitCounts(c);
    for (const values of counts.values()) {
      const total = [...values.values()].reduce((a, b) => a + b, 0);
      // Every surviving token carries at most one value per trait, so no trait
      // can be held by more tokens than exist.
      expect(total).toBeLessThanOrEqual(c.live.length);
    }
  });

  it('carries a content hash so a served copy can be proven authentic', () => {
    // R8 is the SHA-256 of the artwork. Serving images from our own domain is
    // only defensible because this lets anyone check we served the real file.
    for (const c of COLLECTIONS) {
      const missing = c.tokens.filter((t) => !t.contentHash);
      expect(missing.length, `${c.key}: ${missing.length} without contentHash`).toBe(0);
    }
  });
});
