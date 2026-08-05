# champions-trading

A small, non-custodial marketplace on Ergo for three collections — **Ergo
Champions**, **Ergo Mummy** and **Mage Champions**.

Ergo is not short of places to trade NFTs. Mew Finance and Auction House both
work and are maintained, and anyone wanting a general marketplace should use
them. I just never got on with either as a user, and what I wanted for these
three collections was something smaller: one page that knows them, ranks their
rarity against the supply that still exists rather than the one that was minted,
and otherwise gets out of the way.

```bash
npm install
npm run dev          # mainnet by default — every transaction is real
```

**Run testnet first.** The tests validate the contracts; they cannot validate
Nautilus, or a real node, or the explorer's indexing. `docs/deploying.md` has the
procedure and the reasoning.

```bash
echo 'NEXT_PUBLIC_ERGO_NETWORK=testnet' > .env.local
```

## No database

The order book is on chain. A listing is a box locked by `contracts/sale.es`,
so "what is for sale" is the set of unspent boxes at that contract's address,
and "who owns this NFT" is the box holding that token. Both are one explorer
call (`lib/explorer.ts`). Names, traits and images never change and ship as
files (`data/`, indexed in `lib/collections.ts`).

Nothing else needs storing. There are no accounts — a wallet connection is a
signature, not a session — and no server-side secret anywhere in the design; if
one shows up, the trust model has drifted.

That is also a legal position, not only an engineering one: a stored wallet
address plus an IP is personal data, and holding it would make this project a
data controller under the LGPD. Holding nothing removes the obligation instead
of managing it.

The one thing that genuinely wants storage is **sales history** — "last sold
for". It is derivable from the chain but too slow to rebuild per request, so it
lives in `data/history.json`, appended by a cron and committed. That is the
weakest kind of state on purpose: delete the file, re-run `npm run index:sales`,
and it comes back. It is a cache with a long memory, never a source of truth,
and every append is a commit anyone can diff against the chain.

## Custody

None. The app builds an unsigned transaction; Nautilus signs it; the chain
settles it. A sale is atomic because the buyer's transaction spends the listing
box and pays the seller in the same transaction — both happen or neither does.
The operator cannot move, freeze, or skim anything; `sale.es` has no branch that
mentions them.

## Layout

| path | what |
|---|---|
| `contracts/sale.es` | listing contract — a seller locks a token, waits for ERG |
| `contracts/offer.es` | offer contract — a bidder locks ERG, waits for a token |
| `lib/contract.ts` | the compiled addresses per network, pinned (Ergo has no deploy step) |
| `lib/transactions.ts` | list / buy / cancel / offer / accept / withdraw, unsigned |
| `lib/explorer.ts` | live state, read from chain |
| `lib/history.ts` | reads settled trades out of raw transactions |
| `scripts/audit-supply.mjs` | finds which tokens were burned and no longer exist |
| `lib/collections.ts` | static catalog, keyed by `tokenId` |
| `lib/nautilus.ts` | EIP-12 wallet connector |
| `components/ui/` | 9-slice pixel chrome carried over from the game HUD |
| `data/` | collection metadata, the burn audit, and the indexed trade history |
| `scripts/index-sales.mjs` | the cron that appends settled trades |
| `scripts/gen_thumbs.py` | the two image tiers; skips burned tokens |
| `docs/architecture.md` | the reasoning behind all of the above |
| `docs/history-and-storage.md` | the only feature that wants storage, and how little it needs |
| `docs/supply-audit.md` | why two thirds of Ergo Champions is not for sale |
| `docs/deploying.md` | going live, and the first real transaction |

## What a user can do

Six actions, each one a transaction their wallet signs. Nothing is held in
escrow by anyone: every one settles atomically or not at all.

| action | what happens on chain |
|---|---|
| **List** | the token moves into a box at the sale contract, seller in R4, price in R5 |
| **Buy** | that box is spent and the seller paid, in one transaction |
| **Cancel** | the seller signs and takes the box back |
| **Offer** | ERG moves into a box at the offer contract, bidder in R4, wanted token in R5 |
| **Accept** | the holder delivers the token to the bidder and takes the ERG |
| **Withdraw** | the bidder signs and takes their ERG back |

Offers work on any token, listed or not — that is the point of them. They are
funded bids sitting on chain, not intentions we record and later match, which
is also what keeps this a venue rather than an order book (see
`docs/history-and-storage.md` on why that distinction matters).

## Security tests

```bash
npm test                 # 70 tests: contracts, builders, catalog, history, explorer, network
npm run verify:catalog   # asks the chain whether the catalog is real (slow)
npm run index:sales      # append settled trades to data/history.json
npm run audit:supply     # re-check which tokens still exist (slow)
npm run preflight        # everything above, in order, before a deploy
```

`contracts/sale.test.ts` and `contracts/offer.test.ts` compile the real
ErgoScript and run it against a mock chain enforcing consensus rules. Each test
is named after the attack it tries: underpaying by one nanoERG, paying the wrong
address, cancelling someone else's listing, delivering the wrong token to claim
a bid, and — the one both contracts' odd-looking R4 tag exists for — settling
two of them with a single payment or delivery. A failure here is not a style
problem; it means a contract would let someone take value that is not theirs.

`lib/transactions.test.ts` drives the builders end to end through those
contracts, which is a different failure mode and the likelier one: a correct
contract fronted by a builder that forgets a register produces a marketplace
where nothing works, or where a listing cannot be cancelled. It caught a real
one — fleet's `from()` is a candidate pool, not a list of inputs, so the offer
box was being dropped from accept transactions and the token handed over for
free.

`lib/collections.test.ts` guards the catalog, which is the only thing standing
between a buyer and a forgery: Ergo does not reserve token names, so anyone can
mint "Ergo Champions #1" for pennies, and being in the catalog is what makes a
token genuine.

`npm run verify:catalog` is the part the offline tests cannot do — it asks the
chain whether each token id was really issued by the collection's issuer
address. Run it after any edit to `data/` and before every deploy. Use
`--sample 25` for a fast spot check; the full sweep is ~3100 tokens.

## Three facts that break naive code

**Key by `tokenId`, never by name or edition.** Ergo does not reserve token
names — anyone can mint "Ergo Champions #1" tomorrow — and these collections
each minted some editions more than once (in Ergo Mummy, seven repeated numbers
carry *different artwork*). Membership is a token id in the catalog. Nothing
else.

**Most of Ergo Champions no longer exists.** 1,005 of its 1,498 token ids were
burned — 983 of them by the issuer, without ever having been sold. The gallery
shows the 493 that survive, and rarity is counted against those, not against a
mint that is gone. `data/supply.json` records the audit; `docs/supply-audit.md`
explains it. On Ergo a burned token is genuinely destroyed, not sent to a dead
address, so there is nothing for anyone to trade.

**Royalties do not exist here.** These are EIP-004 tokens, a standard with no
royalty field, and Ergo does not enforce royalties at the protocol level even
under EIP-24. Any payment to the artists has to be written into the contract by
agreement — it cannot be read off chain.

## Licence

| | |
|---|---|
| `contracts/` | Apache-2.0 — a reusable escrow pattern, free to copy |
| everything else | AGPL-3.0 — run your own instance; publish what you change |

**The artwork is not covered by either.** It belongs to the collection owners
and is hosted with their written permission. The image tiers are deliberately
kept out of git for that reason — `vercel deploy` uploads them straight from the
local folder, so the permission stays revocable instead of being published into
a history that cannot be undone. See `NOTICE`.

An instance without that permission should serve images from IPFS, which is
where they canonically live: every token's R9 register holds the address and R8
holds the SHA-256, so an IPFS-only deployment is complete and verifiable.

Why the whole application and not just the contracts: a correct contract fronted
by a bad interface still loses your NFT. The `ensureInclusion` bug in this
repository's own history handed a token over for free while the contract behaved
perfectly. Anyone deciding whether to trust the site has to be able to read the
part that builds the transaction they sign.

## Deploying

`vercel deploy` from this directory — the CLI uploads the local folder, so the
image tiers reach the CDN without being in git. `.vercelignore` must exist for
that to work: without it the CLI falls back to `.gitignore` and would ship a
site with no images and no error.

Run every flow against testnet before trusting an instance with real value.
`docs/deploying.md` explains why the test suite cannot substitute for that: it
validates the contracts, not the wallet, the node, or the explorer's indexing.
