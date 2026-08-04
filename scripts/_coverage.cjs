// Shared by preflight: which live tokens have a local image in each tier.
//
// Burned tokens are excluded on purpose — their images are pruned, so counting
// them would report a permanent, meaningless shortfall.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CATALOGUES = {
  ErgoChampions: 'ERGOCHAMPIONSmetadata.json',
  ErgoMummy: 'ERGOMUMMYmetadata.json',
  MageChampions: 'MAGECHAMPIONSmetadata.json',
};

const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

function COLLECTIONS() {
  const burned = new Set(Object.keys(read('supply.json').burned ?? {}));

  return Object.entries(CATALOGUES).map(([dir, file]) => {
    const seen = new Map();
    const liveStems = [];
    for (const t of read(file).tokens) {
      const n = (seen.get(t.id) ?? 0) + 1;
      seen.set(t.id, n);
      // Same suffix rule as lib/collections.ts; a mismatch here would report
      // a surviving twin as missing.
      if (!burned.has(t.metadata.tokenId)) liveStems.push(n > 1 ? `${t.id}-${n}` : t.id);
    }

    return {
      dir,
      live: liveStems.length,
      missing(tier) {
        const folder = path.join(ROOT, 'public', tier, dir);
        if (!fs.existsSync(folder)) return liveStems;
        const have = new Set(fs.readdirSync(folder).map((f) => f.replace(/\.[^.]+$/, '')));
        return liveStems.filter((s) => !have.has(s));
      },
    };
  });
}

module.exports = { COLLECTIONS };
