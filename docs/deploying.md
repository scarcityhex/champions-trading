# Deploying, and the first real transaction

Two separate things, and the order matters. Putting the site online is routine.
Trusting it with a real NFT is not, and no amount of green tests substitutes for
the step below.

---

## What the tests do and do not prove

The 70 tests compile the real ErgoScript and run it against a mock chain that
enforces consensus rules. They prove:

- the contracts do not let anyone take value that is not theirs
- the builders produce transactions those contracts accept

They cannot prove:

- that Nautilus's `get_utxos()` returns boxes shaped the way fleet expects
- that `sign_tx` accepts the EIP-12 object we hand it
- that a **real node** accepts the result — its size and cost limits are not the
  mock chain's
- that the explorer indexes a listing box such that `fetchListings` finds it

Those four are the gap, and they are exactly the class of bug the mock chain
cannot see. One of that class was already found here — fleet's `from()` is a
candidate pool rather than a list of inputs, so the offer box was being dropped
from accept transactions and the token handed over for free. It was caught by an
end-to-end test. The wallet layer has no equivalent, and cannot: only a real
wallet and a real node can exercise it.

**So: run testnet first.** It costs an afternoon and removes the entire class.

---

## 1. Testnet

```bash
echo 'NEXT_PUBLIC_ERGO_NETWORK=testnet' > .env.local
npm run dev
```

The header turns into a standing TESTNET warning, the contract addresses switch
to their testnet forms, and the explorer switches with them. Switch Nautilus to
testnet and get coins from a faucet.

There is nothing to mint: the catalogue is mainnet token ids, so the gallery
will show them but nothing will be listed and your wallet will hold none of
them. To exercise the flows, mint any test token in Nautilus and use the token
page directly at `/token/<its id>` — it will render the unknown-token screen,
which is correct, but the contracts do not care what token they hold.

Walk all six: **list, cancel, list, buy, offer, withdraw, offer, accept.** After
each one, confirm on the testnet explorer that the box moved the way the page
said it did.

## 2. Mainnet, with a real but expendable piece

```bash
rm .env.local          # mainnet is the default
npm run preflight
```

Then, deliberately:

1. List **one** NFT you would not mind losing, at a price like `0.01` ERG.
2. Check the gallery picks it up (up to 30s — that is the API cache).
3. **Cancel it.** Confirm the NFT and its 0.001 ERG come back.
4. List it again and buy it from a second wallet.
5. Make a small offer from the second wallet and accept it from the first.

Only after that has worked end to end is the site trustworthy with real value.

The worst case if a builder is broken is not loss: both contracts have an
unconditional owner-signature branch, so a stuck listing or offer is always
recoverable by its owner — through a fixed builder, or a hand-made transaction.
The thing that could cause permanent loss is a bug in the *contracts*, and those
are the most heavily tested part.

---

## 3. Putting it online

Vercel, or any host that runs Next.js. Nothing needs a server-side secret,
because there is none in the design.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_ERGO_NETWORK` | `mainnet` (or unset) |
| `NEXT_PUBLIC_HOST_ORIGINALS` | `false`, unless you also upload `public/art` |

What ships in the repo:

| Path | Size | Why |
|---|---|---|
| `public/thumbs/` | 37 MB | the gallery; without it every tile hits IPFS |
| `public/detail/` | 150 MB | token pages; without it each one waits on a gateway |
| `data/*.json` | 4.5 MB | the catalogue and the burn audit |

Neither tier contains burned tokens. They are never rendered — the gallery
filters them and their page explains the burn instead of showing artwork — so
1,068 files and 58 MB came out. `gen_thumbs.py --prune` removes any that a
later audit reclassifies.

The full-size originals (~2 GB) are not committed. Token pages fall back to
IPFS for the 176 Mage Champions that were never downloaded, which is the
correct behaviour — IPFS is the canonical source, and the on-chain R8 hash is
what proves any copy we serve is the real file.

**Enable the `index sales` workflow** in the repository's Actions tab once
there is anything to index. It appends settled trades to `data/history.json`
four times a day and commits the diff.

---

## 4. Keeping it honest

| When | Command |
|---|---|
| before every deploy | `npm run preflight` |
| after editing `data/` | `npm run verify:catalog` (full sweep) |
| every month or so | `npm run audit:supply` — tokens keep getting burned |
| after editing a `.es` file | `npm test` — the address pin will fail, and it should |

That last one is the important one. Changing a contract by one character
changes its address, which means every existing listing stays under the old
script and becomes invisible to the app. The test failing is the system telling
you that you are performing a migration, not fixing a typo.

---

## Running your own instance

Nothing here is specific to one operator: the contract addresses are derived
from the scripts, so any instance reads and writes the same order book. That is
the point — this marketplace exists because SkyHarbor closed and took its
listings with it, and no single host should be able to do that again.

Two things do not come with the code. The artwork is the collection owners' and
needs their permission to serve; without it, point the image tiers at IPFS,
which is where the pieces canonically live and which every token's R9 register
names. And the sales history in `data/history.json` is this instance's index —
yours starts empty and fills as `npm run index:sales` runs.
