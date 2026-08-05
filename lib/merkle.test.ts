import { describe, expect, it } from 'vitest';
import { COLLECTIONS } from './collections';
import { COLLECTION_ROOTS } from './contract';
import { merkleRootHex } from './merkle';

describe('pinned collection Merkle roots', () => {
  for (const collection of COLLECTIONS) {
    it(`${collection.key} still commits to the live catalogue`, () => {
      expect(COLLECTION_ROOTS[collection.key]).toBeDefined();
      expect(merkleRootHex(collection.live.map((token) => token.tokenId))).toBe(
        COLLECTION_ROOTS[collection.key],
      );
    });
  }

  it('has no stale roots for removed collections', () => {
    expect(Object.keys(COLLECTION_ROOTS).sort()).toEqual(COLLECTIONS.map((c) => c.key).sort());
  });
});
