// TraitFilters.test.ts — the filter predicate.
//
// Pure logic, and the one place where a wrong boolean quietly shows a collector
// the wrong set of tokens. The asymmetry is the point: OR within a trait, AND
// across traits. Get it backwards and selecting two backgrounds returns nothing
// instead of both.

import { describe, expect, it } from 'vitest';
import { matchesTraits, activeCount } from './TraitFilters';
import { COLLECTIONS } from '@/lib/collections';

const attrs = [
  { trait_type: 'background', value: 'claret' },
  { trait_type: 'helmet', value: 'emerald helmet' },
  { trait_type: 'weapons', value: 'axe' },
];

describe('matchesTraits', () => {
  it('matches everything when nothing is selected', () => {
    expect(matchesTraits(attrs, {})).toBe(true);
    // An emptied trait is the same as no filter, not an impossible one.
    expect(matchesTraits(attrs, { background: [] })).toBe(true);
  });

  it('ORs values within one trait', () => {
    expect(matchesTraits(attrs, { background: ['claret'] })).toBe(true);
    expect(matchesTraits(attrs, { background: ['brass'] })).toBe(false);
    expect(matchesTraits(attrs, { background: ['brass', 'claret'] })).toBe(true);
  });

  it('ANDs across traits', () => {
    expect(matchesTraits(attrs, { background: ['claret'], weapons: ['axe'] })).toBe(true);
    // One miss is enough to exclude, even with the other satisfied.
    expect(matchesTraits(attrs, { background: ['claret'], weapons: ['bent spear'] })).toBe(false);
  });

  it('excludes a token that lacks the trait entirely', () => {
    // Not every token carries every trait, and a missing trait must not be
    // treated as a wildcard match.
    expect(matchesTraits(attrs, { cape: ['Galaxy Cape'] })).toBe(false);
    expect(matchesTraits(undefined, { background: ['claret'] })).toBe(false);
  });

  it('counts selections across traits', () => {
    expect(activeCount({})).toBe(0);
    expect(activeCount({ background: [], helmet: [] })).toBe(0);
    expect(activeCount({ background: ['a', 'b'], helmet: ['c'] })).toBe(3);
  });
});

describe('against the real catalog', () => {
  const ec = COLLECTIONS.find((c) => c.key === 'ERGOCHAMPIONS')!;

  it('narrows to the count the dropdown advertises', () => {
    // The number beside a value in the dropdown has to be the number of cards
    // the user gets after clicking it, or the rarity figures are decoration.
    const counts = new Map<string, number>();
    for (const t of ec.live) {
      const v = t.attributes?.find((a) => a.trait_type === 'background')?.value;
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const [value, expected] = [...counts.entries()].sort((a, b) => a[1] - b[1])[0];

    const matched = ec.live.filter((t) => matchesTraits(t.attributes, { background: [value] }));
    expect(matched.length).toBe(expected);
  });

  it('never matches a burned token, since filtering runs over live only', () => {
    const burned = ec.tokens.filter((t) => t.burned);
    expect(burned.length).toBeGreaterThan(0);
    expect(ec.live.some((t) => t.burned)).toBe(false);
  });
});
