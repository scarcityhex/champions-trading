// Prints the Merkle root of each collection's surviving token ids, in the shape
// lib/contract.ts expects. Run after any change to data/ that adds or removes
// tokens — a burn does exactly that.
//
//   npx tsx scripts/print-roots.ts
import { COLLECTIONS } from '../lib/collections';
import { merkleRootHex } from '../lib/merkle';

for (const c of COLLECTIONS) {
  console.log(`  ${c.key}: '${merkleRootHex(c.live.map((t) => t.tokenId))}',`);
}
