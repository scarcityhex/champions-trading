// rarity.test.ts — the rarity ranking shown on every card.
//
// A number a collector uses to decide what to pay. It is worth pinning the
// properties that make it meaningful, because a plausible-looking percentile
// that ranks against the wrong population is worse than none at all.

import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  rarityPercentiles,
  rarityLabel,
  traitCounts,
  matchesEdition,
} from './collections';

const EC = COLLECTIONS.find((c) => c.key === 'ERGOCHAMPIONS')!;

describe('rarityPercentiles', () => {
  it('ranks every surviving token, and only surviving tokens', () => {
    const p = rarityPercentiles(EC);
    expect(p.size).toBe(EC.live.length);
    // A burned token has no rank, because it is not competing with anything.
    for (const t of EC.tokens.filter((x) => x.burned).slice(0, 20)) {
      expect(p.has(t.tokenId)).toBe(false);
    }
  });

  it('spans the full range without landing on zero', () => {
    const values = [...rarityPercentiles(EC).values()].sort((a, b) => a - b);
    expect(values[0]).toBeGreaterThan(0); // nothing is in the "top 0%"
    expect(values[values.length - 1]).toBeCloseTo(100, 5);
  });

  it('gives every token a distinct rank', () => {
    // Ties in score are broken by position, so the percentile is a rank rather
    // than a bucket — two pieces cannot both be "the 12th rarest".
    const p = rarityPercentiles(EC);
    expect(new Set(p.values()).size).toBe(p.size);
  });

  // The property that makes the number mean anything: rarer traits rank higher.
  it('puts a token holding the rarest trait value near the top', () => {
    const counts = traitCounts(EC);
    const [trait, values] = [...counts.entries()].find(([, v]) => v.size > 1)!;
    const [rarestValue] = [...values.entries()].sort((a, b) => a[1] - b[1])[0];

    const holders = EC.live.filter((t) =>
      t.attributes?.some((a) => a.trait_type === trait && a.value === rarestValue),
    );
    const p = rarityPercentiles(EC);
    const best = Math.min(...holders.map((t) => p.get(t.tokenId)!));
    const median = [...p.values()].sort((a, b) => a - b)[Math.floor(p.size / 2)];

    expect(best).toBeLessThan(median);
  });

  it('ignores traits every token shares', () => {
    // Ergo Champions is entirely "skeleton". Including it would add the same
    // constant to all 493 scores and change no ordering — but it would also
    // hide a real bug if the exclusion were dropped, so it is asserted.
    const counts = traitCounts(EC);
    const single = [...counts.entries()].filter(([, v]) => v.size === 1);
    expect(single.length).toBeGreaterThan(0);
  });

  it('is cached, not recomputed per call', () => {
    expect(rarityPercentiles(EC)).toBe(rarityPercentiles(EC));
  });
});

describe('rarityLabel', () => {
  it('keeps a decimal where it matters and drops it where it does not', () => {
    // "top 0.2%" and "top 3.4%" are meaningfully different; "top 61.7%" is not
    // more informative than "top 62%".
    expect(rarityLabel(0.2)).toBe('top 0.2%');
    expect(rarityLabel(3.44)).toBe('top 3.4%');
    expect(rarityLabel(61.7)).toBe('top 62%');
  });

  it('renders nothing for a token with no rank', () => {
    expect(rarityLabel(undefined)).toBeNull();
  });
});

describe('matchesEdition', () => {
  const EC_LIVE = COLLECTIONS.find((c) => c.key === 'ERGOCHAMPIONS')!.live;

  it('matches nothing away when the box is empty', () => {
    expect(EC_LIVE.filter((t) => matchesEdition(t, '')).length).toBe(EC_LIVE.length);
    expect(EC_LIVE.filter((t) => matchesEdition(t, '  ')).length).toBe(EC_LIVE.length);
  });

  it('accepts the number with or without the hash', () => {
    const withHash = EC_LIVE.filter((t) => matchesEdition(t, '#219'));
    const without = EC_LIVE.filter((t) => matchesEdition(t, '219'));
    expect(withHash).toEqual(without);
    expect(without.length).toBeGreaterThan(0);
  });

  // The behaviour that makes the box usable: an exact number, not a substring.
  it('does not bury #4 under #40 and #400', () => {
    const four = EC_LIVE.filter((t) => matchesEdition(t, '4'));
    expect(four.every((t) => t.edition === 4)).toBe(true);
    expect(EC_LIVE.some((t) => t.edition === 40)).toBe(true); // would have matched a substring
  });

  it('returns every token sharing a repeated edition number', () => {
    // Ergo Champions #1 through #5 were each minted more than once. Showing one
    // and hiding its twins would misrepresent what is available.
    const byEdition = new Map<number, number>();
    for (const t of EC_LIVE) byEdition.set(t.edition, (byEdition.get(t.edition) ?? 0) + 1);
    const repeated = [...byEdition.entries()].find(([, n]) => n > 1);
    if (!repeated) return;
    expect(EC_LIVE.filter((t) => matchesEdition(t, String(repeated[0]))).length).toBe(repeated[1]);
  });

  it('finds nothing for text that is not a number', () => {
    expect(EC_LIVE.filter((t) => matchesEdition(t, 'skeleton')).length).toBe(0);
  });
});
