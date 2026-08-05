// merkle.ts — proving a token belongs to a collection, on chain.
//
// Ergo has no policy id and no collection contract. A token id is derived from
// the first input box of its minting transaction and carries no mark of what it
// belongs to; membership is a list of ids kept off chain. That is why a
// collection-wide offer cannot simply check an address the way it would on
// Ethereum, or a policy id the way it would on Cardano.
//
// So the list is committed to a 32-byte Merkle root, pinned in lib/contract.ts.
// Whoever accepts an offer supplies the path from their token up to that root,
// and the contract recomputes it. Nobody can prove membership of a token that
// is not in the list, and the list itself never goes on chain.
//
// The hashing here must match contracts/collection-offer.es exactly. It is
// verified by a round trip in lib/merkle.test.ts — a proof built here is
// checked by the real compiled script against a mock chain, so a mismatch
// cannot pass unnoticed.

import { blake2b256, hex } from '@fleet-sdk/crypto';

/** One step up the tree: the sibling hash, and whether it sits on the left. */
export type ProofStep = { sibling: Uint8Array; siblingIsLeft: boolean };

const hashPair = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return blake2b256(joined);
};

/**
 * Levels of the tree, leaves first.
 *
 * Ids are sorted before hashing so the root depends only on the SET of tokens,
 * never on the order they happened to appear in a catalogue file. Reordering
 * the JSON must not move the root — otherwise the pinned constant would drift
 * for a reason that is not a real change.
 *
 * An odd node at the end of a level is promoted unchanged rather than paired
 * with itself. Duplicating it would make a tree where a single leaf can be
 * proven at two positions, which is a known way to forge membership.
 */
export function buildLevels(tokenIds: string[]): Uint8Array[][] {
  if (tokenIds.length === 0) throw new Error('a collection needs at least one token');

  const leaves = [...tokenIds].sort().map((id) => blake2b256(hex.decode(id)));
  const levels: Uint8Array[][] = [leaves];

  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < below.length; i += 2) {
      next.push(i + 1 < below.length ? hashPair(below[i], below[i + 1]) : below[i]);
    }
    levels.push(next);
  }

  return levels;
}

export const merkleRoot = (tokenIds: string[]): Uint8Array => {
  const levels = buildLevels(tokenIds);
  return levels[levels.length - 1][0];
};

/** Root as hex — what goes into a register and into lib/contract.ts. */
export const merkleRootHex = (tokenIds: string[]): string => hex.encode(merkleRoot(tokenIds));

/**
 * The path from one token up to the root.
 *
 * Returns null when the token is not in the set — the caller must treat that as
 * "cannot be offered on", not as an empty proof. An empty path is a valid proof
 * for a single-leaf tree, so conflating the two would be a real hole.
 */
export function merkleProof(tokenIds: string[], tokenId: string): ProofStep[] | null {
  const levels = buildLevels(tokenIds);
  const leaf = blake2b256(hex.decode(tokenId));

  let index = levels[0].findIndex((h) => hex.encode(h) === hex.encode(leaf));
  if (index < 0) return null;

  const path: ProofStep[] = [];
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;

    // No sibling means this node was promoted; nothing to hash at this level.
    if (siblingIndex < nodes.length) {
      path.push({ sibling: nodes[siblingIndex], siblingIsLeft: isRight });
    }
    index = Math.floor(index / 2);
  }

  return path;
}

/** The same computation the contract performs — used to check ourselves. */
export function foldProof(tokenId: string, path: ProofStep[]): Uint8Array {
  let acc = blake2b256(hex.decode(tokenId));
  for (const step of path) {
    acc = step.siblingIsLeft ? hashPair(step.sibling, acc) : hashPair(acc, step.sibling);
  }
  return acc;
}
