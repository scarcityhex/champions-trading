// index-sales — appends settled trades to data/history.json.
//
//   npm run index:sales
//   npm run index:sales -- --full     (re-scan from the beginning)
//
// The one piece of state this project keeps, and it is deliberately the
// weakest kind: a file, in the repo, rebuildable from the chain at any time by
// deleting it and re-running. See docs/history-and-storage.md for why it is not
// a database.
//
// Every append is a commit, so the history is auditable by anyone who cares to
// diff it against the chain — which is worth more to a venue asking strangers
// for trust than the speed a database would add.
//
// Resumable and idempotent: it records the height it reached, and re-indexing
// an overlapping range merges by the box each trade settled. A box can only be
// spent once, so replaying cannot double-count.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The classifier is TypeScript and shared with the app, so it is imported
// rather than duplicated here. One definition of "what counts as a sale" — a
// second copy would drift and nobody would notice until the numbers disagreed.
// Run through tsx (see the npm script) so these resolve.
import { extractTrades, mergeTrades } from '../lib/history.ts';
import { SALE_ADDRESS, OFFER_ADDRESS, COLLECTION_OFFER_ADDRESS } from '../lib/contract.ts';
// Shared with the app, so the mirror fallback and the outage-vs-answer rule
// have one definition. A cron that quietly dies because one explorer is down
// is the failure this avoids.
import { api, chainHeight } from '../lib/explorer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = join(HERE, '..', 'data', 'history.json');
const PAGE = 50;

const CONTRACTS = {
  sale: SALE_ADDRESS,
  offer: OFFER_ADDRESS,
  collectionOffer: COLLECTION_OFFER_ADDRESS,
};

function load() {
  try {
    return JSON.parse(readFileSync(HISTORY, 'utf8'));
  } catch {
    return { lastHeight: 0, updatedAt: null, trades: [] };
  }
}

/**
 * Walk an address's transactions newest-first, stopping once we are past the
 * height we already indexed.
 *
 * Newest-first with an early stop is what keeps the routine run cheap: a cron
 * every six hours reads one page and stops, rather than the whole history.
 */
async function scan(address, sinceHeight) {
  const found = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await api(`/addresses/${address}/transactions?limit=${PAGE}&offset=${offset}`);
    const items = page.items ?? [];
    if (items.length === 0) return found;

    for (const tx of items) {
      // A one-block overlap rather than a strict `<`: transactions inside the
      // boundary block would otherwise be skipped depending on which side of it
      // the previous run stopped. Re-reading a block is free; missing a sale is
      // permanent.
      if (tx.inclusionHeight < sinceHeight - 1) return found;
      found.push(...extractTrades(tx, CONTRACTS));
    }

    if (found.length === 0 && offset + PAGE >= (page.total ?? 0)) return found;
    if (offset + PAGE >= (page.total ?? 0)) return found;
  }
}

const full = process.argv.includes('--full');
const state = full ? { lastHeight: 0, trades: [] } : load();
const since = full ? 0 : state.lastHeight;

console.log(`scanning from height ${since}${full ? ' (full rescan)' : ''}`);

const fresh = [];
for (const [name, address] of Object.entries(CONTRACTS)) {
  const trades = await scan(address, since);
  console.log(`  ${name}: ${trades.length} trade(s)`);
  fresh.push(...trades);
}

const trades = mergeTrades(state.trades ?? [], fresh);
const lastHeight = trades.reduce((max, t) => Math.max(max, t.height), since);

// Recorded separately from lastHeight, which is the height of the newest TRADE.
// The two drift apart the moment nobody trades for a while, and using the trade
// height to describe the index's freshness told users the page was eight hours
// behind when it had just run — it was the market that was quiet, not the
// indexer that was late.
const scannedHeight = (await chainHeight(true)) ?? lastHeight;

mkdirSync(dirname(HISTORY), { recursive: true });
writeFileSync(
  HISTORY,
  JSON.stringify(
    { lastHeight, scannedHeight, updatedAt: new Date().toISOString(), trades },
    null,
    1,
  ),
);

console.log(`${trades.length} trade(s) total; newest at ${lastHeight}, scanned to ${scannedHeight}`);
console.log(`-> ${HISTORY}`);
