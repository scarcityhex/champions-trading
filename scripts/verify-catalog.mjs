// verify-catalog — asks the chain whether the catalog is telling the truth.
//
//   npm run verify:catalog                 (all three, slow)
//   npm run verify:catalog ERGOMUMMY       (one)
//   npm run verify:catalog ERGOMUMMY --sample 25
//
// The offline tests (lib/collections.test.ts) prove the catalog is internally
// consistent. They cannot prove it is REAL. This can: for every token id it
// fetches the issuer box and checks the minting address against the issuer the
// collection claims.
//
// That check is the whole anti-forgery story. Ergo has no policy id and does
// not reserve token names, so "Ergo Champions #1" can be minted by anyone for
// pennies. The only thing separating a genuine piece from a convincing fake is
// that its token id was issued by the real artist's address — which is what
// this asserts, one token at a time.
//
// Run it before every deploy, and after any edit to data/. A single swapped id
// is enough to have the marketplace endorse a forgery.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with the app: same mirrors, same fallback. A verification run that
// fails because one explorer is busy would look like a poisoned catalog.
import { api } from '../lib/explorer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = 8;

const FILES = {
  ERGOCHAMPIONS: 'ERGOCHAMPIONSmetadata.json',
  ERGOMUMMY: 'ERGOMUMMYmetadata.json',
  MAGECHAMPIONS: 'MAGECHAMPIONSmetadata.json',
};


/**
 * The address that minted a token.
 *
 * Deliberately the issuer BOX address, not the minting transaction's input
 * address. The input is a 389-char P2S whose tail changes per mint, so
 * comparing it rejects entire genuine collections; the issuer box is a stable
 * 51-char P2PK. Getting this wrong looks like a catalog full of forgeries.
 */
async function issuerOf(tokenId) {
  const token = await api(`/tokens/${tokenId}`);
  const box = await api(`/boxes/${token.boxId}`);
  return box.address ?? null;
}

async function pool(items, limit, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

async function verify(key, sample) {
  const doc = JSON.parse(readFileSync(join(HERE, '..', 'data', FILES[key]), 'utf8'));
  const expected = doc.collection?.ownership?.issuerAddress;
  if (!expected) throw new Error(`${key}: no issuerAddress in the catalog header`);

  let tokens = doc.tokens;
  if (sample && sample < tokens.length) {
    // Evenly spaced rather than the first N: a poisoned catalog is likelier to
    // be edited somewhere in the middle than at the top.
    const step = tokens.length / sample;
    tokens = Array.from({ length: sample }, (_, i) => tokens[Math.floor(i * step)]);
  }

  console.log(`\n=== ${doc.collection?.name ?? key} — checking ${tokens.length} of ${doc.tokens.length} ===`);
  console.log(`expected issuer: ${expected}`);

  const bad = [];
  let done = 0;
  await pool(tokens, CONCURRENCY, async (t) => {
    try {
      const got = await issuerOf(t.metadata.tokenId);
      if (got !== expected) bad.push({ id: t.id, tokenId: t.metadata.tokenId, got });
    } catch (e) {
      bad.push({ id: t.id, tokenId: t.metadata.tokenId, got: `ERROR ${e.message}` });
    }
    if (++done % 50 === 0) console.log(`  ${done}/${tokens.length}`);
  });

  if (bad.length === 0) {
    console.log(`OK — every token id was issued by the expected address.`);
    return true;
  }
  console.error(`\nFAILED — ${bad.length} token(s) not issued by ${expected}:`);
  for (const b of bad.slice(0, 20)) console.error(`  ${b.id} ${b.tokenId.slice(0, 16)}… -> ${b.got}`);
  if (bad.length > 20) console.error(`  …and ${bad.length - 20} more`);
  return false;
}

const args = process.argv.slice(2);
const sampleAt = args.indexOf('--sample');
const sample = sampleAt >= 0 ? Number(args[sampleAt + 1]) : 0;
const keys = args.filter((a) => FILES[a]);

let ok = true;
for (const key of keys.length ? keys : Object.keys(FILES)) {
  ok = (await verify(key, sample)) && ok;
}
console.log(ok ? '\nCatalog verified.' : '\nCatalog NOT verified.');
process.exit(ok ? 0 : 1);
