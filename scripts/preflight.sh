#!/usr/bin/env bash
# preflight — everything that must pass before a deploy.
#
#   npm run preflight
#
# Ordered cheapest-first so a failure surfaces fast. The last two hit the
# network and are the ones that catch a stale repo rather than broken code:
# a catalogue that no longer matches the chain looks perfectly healthy offline.
set -euo pipefail

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "types"
npx tsc --noEmit

step "tests"
npx vitest run

step "build"
npx next build

step "catalogue is real (sample)"
# Full sweep is ~3,100 tokens; a spaced sample catches a poisoned or edited
# catalogue without a ten-minute wait. Run `npm run verify:catalog` for all.
npm run verify:catalog --silent -- --sample 20

step "image coverage"
# Counting files would prove nothing now that burned tokens are pruned: what
# matters is whether every token the site can actually show has a picture.
# Anything missing falls back to IPFS, which works but is slow, so this reports
# rather than fails.
node -e "
const { COLLECTIONS } = require('./scripts/_coverage.cjs');
let anyMissing = false;
for (const c of COLLECTIONS()) {
  for (const tier of ['thumbs', 'detail']) {
    const missing = c.missing(tier);
    if (missing.length) anyMissing = true;
    console.log(\`  \${c.dir}/\${tier}: \${c.live - missing.length}/\${c.live} live tokens\` +
      (missing.length ? \` — \${missing.length} fall back to IPFS\` : ''));
  }
}
if (anyMissing) console.warn('  (to fill the gaps: re-run the downloader, then scripts/gen_thumbs.py)');
"

step "burn audit present"
node -e "
const s=require('./data/supply.json');
if (!s.auditedAt) { console.error('  supply.json has never been audited'); process.exit(1); }
const days=(Date.now()-Date.parse(s.auditedAt))/864e5;
for (const [k,v] of Object.entries(s.collections)) {
  console.log(\`  \${k}: \${v.alive} alive, \${v.burned} burned\`);
}
console.log(\`  audited \${days.toFixed(0)} day(s) ago\`);
if (days > 30) console.warn('  stale — consider: npm run audit:supply');
"

printf '\n\033[1mAll checks passed.\033[0m\n'
