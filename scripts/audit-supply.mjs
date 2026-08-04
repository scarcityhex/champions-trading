// audit-supply — finds which tokens no longer exist, and writes data/supply.json.
//
//   npm run audit:supply
//   npm run audit:supply -- ERGOMUMMY        (one collection)
//   npm run audit:supply -- --full           (ignore previous results)
//
// Two thirds of Ergo Champions was burned. Listing tokens that cannot be
// traded by anyone is worse than not listing them: a buyer clicks Offer, funds
// a bid, and waits forever for a delivery that is physically impossible until
// they withdraw it.
//
// Derived data, like data/history.json — delete it, re-run, and it comes back.
// Never edited by hand.
//
// Method, per token id:
//   1. no unspent box holds it -> the token was burned
//   2. for burned ones, walk every box that ever held it. If it never sat at an
//      address other than the issuer's, it was never sold — it was minted and
//      later destroyed by the issuer. That distinction is the whole point: an
//      unsold remainder retired by the project is a different fact from a
//      collector burning something they bought.
//
// Resumable: state is written after every chunk, so an interrupted run resumes
// instead of restarting ~3,100 lookups.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from '../lib/explorer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const OUT = join(DATA, 'supply.json');

const FILES = {
  ERGOCHAMPIONS: 'ERGOCHAMPIONSmetadata.json',
  ERGOMUMMY: 'ERGOMUMMYmetadata.json',
  MAGECHAMPIONS: 'MAGECHAMPIONSmetadata.json',
};

const ALIVE_CONCURRENCY = 10;
const CHUNK = 200;

async function pool(items, limit, worker) {
  let i = 0;
  const out = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx]);
      }
    }),
  );
  return out;
}

/** Is any unspent box holding this token? */
async function isAlive(tokenId) {
  try {
    const d = await api(`/boxes/unspent/byTokenId/${tokenId}?limit=1`);
    return (d.total ?? 0) > 0;
  } catch {
    return null; // unknown — left out rather than guessed at
  }
}

/** Every address that ever held it, and the transaction that destroyed it. */
async function trace(tokenId, issuer) {
  try {
    const d = await api(`/boxes/byTokenId/${tokenId}?limit=100`);
    const items = d.items ?? [];
    const addresses = items.map((b) => b.address);
    const last = items[items.length - 1];
    return {
      burnTx: last?.spentTransactionId ?? null,
      // The load-bearing field. False means the issuer minted it and later
      // destroyed it without anyone ever having owned it.
      neverLeftIssuer: addresses.every((a) => a === issuer),
      boxCount: d.total ?? items.length,
    };
  } catch {
    return null;
  }
}

function load() {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    return { auditedAt: null, collections: {}, burned: {} };
  }
}

const args = process.argv.slice(2);
const full = args.includes('--full');
const picked = args.filter((a) => FILES[a]);
const keys = picked.length ? picked : Object.keys(FILES);

const state = full ? { auditedAt: null, collections: {}, burned: {} } : load();
state.burned ??= {};
state.collections ??= {};

for (const key of keys) {
  const doc = JSON.parse(readFileSync(join(DATA, FILES[key]), 'utf8'));
  const issuer = doc.collection?.ownership?.issuerAddress;
  if (!issuer) throw new Error(`${key}: no issuerAddress in the catalog header`);

  const ids = [...new Set(doc.tokens.map((t) => t.metadata.tokenId))];
  console.log(`\n=== ${doc.collection?.name ?? key} — ${ids.length} token ids`);

  // Phase 1 — alive or burned.
  const unknown = ids.filter((id) => !(id in state.burned) && !state.collections[key]?.alive?.includes?.(id));
  const seen = new Set(state.collections[key]?.checked ?? []);
  const todo = full ? ids : ids.filter((id) => !seen.has(id));
  console.log(`  checking ${todo.length}`);

  const burnedIds = [];
  const checked = new Set(seen);
  let done = 0;

  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const results = await pool(chunk, ALIVE_CONCURRENCY, isAlive);
    chunk.forEach((id, n) => {
      if (results[n] === null) return; // lookup failed; retry on the next run
      checked.add(id);
      if (results[n] === false) burnedIds.push(id);
      else delete state.burned[id];
    });
    done += chunk.length;
    state.collections[key] = { ...state.collections[key], checked: [...checked] };
    writeFileSync(OUT, JSON.stringify(state, null, 1));
    process.stdout.write(`  ${done}/${todo.length}\r`);
  }

  // Phase 2 — trace only what is burned.
  const needTrace = burnedIds.filter((id) => !state.burned[id]?.burnTx);
  console.log(`\n  ${burnedIds.length} burned; tracing ${needTrace.length}`);

  for (let i = 0; i < needTrace.length; i += 100) {
    const chunk = needTrace.slice(i, i + 100);
    const results = await pool(chunk, ALIVE_CONCURRENCY, (id) => trace(id, issuer));
    chunk.forEach((id, n) => {
      if (results[n]) state.burned[id] = results[n];
    });
    writeFileSync(OUT, JSON.stringify(state, null, 1));
  }

  const burned = ids.filter((id) => state.burned[id]);
  const neverSold = burned.filter((id) => state.burned[id].neverLeftIssuer).length;
  state.collections[key] = {
    total: ids.length,
    alive: ids.length - burned.length,
    burned: burned.length,
    burnedNeverSold: neverSold,
    checked: [...checked],
  };
  console.log(
    `  alive ${ids.length - burned.length} · burned ${burned.length} (${neverSold} never sold)`,
  );
}

state.auditedAt = new Date().toISOString();

// `checked` is only bookkeeping for resuming; it would triple the file size.
for (const k of Object.keys(state.collections)) delete state.collections[k].checked;

mkdirSync(DATA, { recursive: true });
writeFileSync(OUT, JSON.stringify(state, null, 1));
console.log(`\n-> ${OUT}`);
