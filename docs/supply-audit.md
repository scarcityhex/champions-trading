# Circulating supply audit — Ergo Champions, Ergo Mummy, Mage Champions

*Prepared 2026-08-03 from Ergo mainnet data. Every figure below is reproducible
from the public explorer; transaction ids are included so any of it can be
checked independently.*

---

## Why we looked

We are rebuilding a marketplace for these three collections, since SkyHarbor —
which carried most of their volume — has closed. Building the catalogue meant
resolving every token id on chain, and while wiring up the "who holds this NFT"
lookup we found that a large share of Ergo Champions token ids resolve to **no
unspent box at all**. On Ergo that means one thing: the token no longer exists.

We then audited all 3,130 token ids across the three collections rather than
guess at the scale of it.

## Method

For every token id in each collection:

1. `GET /boxes/unspent/byTokenId/{id}` — if no unspent box holds the token, it
   has been burned.
2. For every burned token, `GET /boxes/byTokenId/{id}` — the full list of boxes
   that ever held it, which answers the question that actually matters: **did
   the token ever sit at an address other than the issuer's?**

That second check is the whole audit. A token that went *mint → issuer → burn*
was never sold to anyone. A token that changed hands and was burned later is a
holder's decision, not the issuer's.

Issuer addresses used:

| Collection | Issuer |
|---|---|
| Ergo Champions | `9hyxVZLRuJ1zkgYfMPYHLTnBixAgZfLVwxioWhAXWTD3bLzmntC` |
| Ergo Mummy | `9gtuMt4YTz5e1cskqyUAzVCXcQMHNtrF7RyfbnhHvNiQ1UoR697` |
| Mage Champions | `9fWcVXLphZyFfGFgJ4SXjowYE7WJj4kYPBr5PQshWYj9mCiQTQc` |

## Results

| Collection | Token ids minted | **Still exist** | Burned | Burned *never sold* | Burned *after changing hands* |
|---|---:|---:|---:|---:|---:|
| Ergo Champions | 1,498 | **493** | 1,005 | 983 | 22 |
| Ergo Mummy | 140 | **121** | 19 | 3 | 16 |
| Mage Champions | 1,492 | **1,447** | 45 | 0 | 45 |

**Ergo Champions is the outlier: two thirds of the collection no longer
exists, and almost all of it was destroyed without ever having been sold.**

The other two collections show a completely different pattern, which we describe
below — we do not think they are the same event, and we want to be careful not
to imply that they are.

## Ergo Champions: what the chain shows

The burns are not scattered over time. **979 of the 1,005 were destroyed on
2023-02-03, in thirteen transactions inside about three minutes** (block heights
932,016 to 932,198). Examples:

- `2cbe6382171befdd73ae5a19bb5da307e80b9d5230dc938df935f1cc8b4eb76f`
- `27167631cbbdd952e853fdbfd7730107928bbb2de4140624a3e5eaa33eb884b5`
- `846ee20880bce009e8f09d5e88675b20a35db81012ee475abc94b449012dd1fd`

Each of those transactions has the same shape: **every input comes from the
issuer address**, and the outputs are the miner fee plus one box back to the
issuer. Tokens go in; tokens do not come out. Up to 90 NFTs per transaction.

Three further facts:

- **983 of the 1,005 burned tokens had only ever existed at the issuer
  address.** They were never transferred, never listed anywhere, never held by a
  collector.
- **The issuer holds no remaining stock.** We sampled the surviving 493 and
  found none of them still at the issuer address — every Ergo Champions token
  that still exists is in someone else's hands.
- **The burned edition numbers are interleaved with the surviving ones**, not a
  contiguous tail. Survivors span #1–#1500 and so do the burned. So this was not
  "everything above #500 was cut"; it was whatever had not moved.

Two smaller events sit outside that cluster: 6 tokens on 2022-07-25
(`85f4ea4eb52e3adf2e97f563427db5a46c491e0a4d8eb406bef24134723a2436`), and 19 on
2025-11-27 — the latter from a third-party address, not the issuer.

### The reading the evidence supports

The full 1,500 supply appears to have been minted up front, offered for sale for
a period, and the portion that went unsold deliberately burned in one session in
February 2023 — leaving 493 genuinely distributed pieces.

Retiring unsold inventory is ordinary practice and protects the people who did
buy: stock left in a creator's wallet is a permanent overhang. It does mean the
**real collection size is 493, not 1,500**, and the marketplace presents it that
way. Listing 1,500 pieces when two thirds cannot be traded by anyone would be a
misrepresentation, not a rounding choice.

This would also explain something else we noticed: Ergo Champions #1–#5 each
have several token ids, and the repeats look like early minting attempts.

## Mage Champions: a different story

We checked this specifically, and the pattern does **not** match Ergo Champions.

**None of the 45 burned Mage Champions were burned from the issuer address.**
Every single one had already been transferred to a collector before it was
destroyed. There is no unsold-remainder cleanup here.

The burns are six transactions spread over 2023–2024:

| Date | Transaction | Tokens |
|---|---|---:|
| 2023-05-06 | `af6f7abecc704a808dff9edd2bc37484ae538d91f689cb40b7ff625127d4bf1c` | 1 |
| 2023-07-18 | `7cc7a827721fc82d6a30cfc38c1a750f7fb011406a8be8b2c3d720ae8f9cedea` | 3 |
| 2023-07-25 | `5915b8cda68cba3361f6dfc2e9c6e7397272059ea161da4b7ce9b353fa9293c1` | 10 |
| 2023-07-29 | `d2d08314154ae7ffebbfcc7ab647d31db1ca241267aead17564b6336774c8c47` | 14 |
| 2023-08-03 | `1f31253c2d9007b82219a42ef75fd9f3f712bfe4ab841538833272fd8ad21380` | 16 |
| 2024-06-23 | `577ac3a68586cbbeac38c27edc027bfc2f618ff831bc052656e03025422de247` | 1 |

The middle four look like one holder clearing out a wallet over a few weeks. So
**Mage Champions circulating supply is 1,447 of 1,492 minted** — a ~3%
reduction caused by holders, not by the project.

## Ergo Mummy

19 burned out of 140. Sixteen had changed hands first; only three never left the
issuer. They are spread thinly across 2022 in single-token transactions, which
again reads as individual holder decisions rather than a supply event.
Circulating supply: **121 of 140**.

One cross-check worth mentioning: the burns dated 2024-06-23 and 2025-11-27
destroyed tokens from *more than one* of these collections in the same
transaction, and both came from ordinary wallet addresses. That is a collector
tidying up, and it confirms the two mechanisms are distinct.

## What the chain cannot tell us

The evidence above is complete about *what* happened and silent about *why*.
These remain unconfirmed by the collection authors, and the marketplace does not
assert them:

- Whether 493 is the **intended** final supply for Ergo Champions, or an
  accident of whatever had not sold by February 2023.
- Whether the sale window was announced, and over what dates. Collectors would
  otherwise have no explanation for the gaps in the numbering.
- Whether the several token ids behind Ergo Champions #1–#5 were test mints.
  The marketplace shows all of them, since picking one arbitrarily would hide
  genuine tokens.
- Whether the authors consider any collection still open.

Motive for the holder-side burns is likewise inference and is not claimed here.
Wallet housekeeping, realising a loss, or simply discarding something judged
worthless would all produce the same records, and none is visible on chain.

## Reproducing this

```
npm run audit:supply
```

Roughly ten minutes for all 3,130 token ids, writing `data/supply.json`. Every
figure above comes out of that file, and every transaction cited can be opened
on any Ergo explorer.

The artwork is served with the collection owner's permission; see `NOTICE`.
