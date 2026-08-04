# champions-trading — architecture

A small, non-custodial marketplace for three Ergo NFT collections: **Ergo
Champions**, **Ergo Mummy** and **Mage Champions**.

Ergo already has general marketplaces — Mew Finance and Auction House — and this
is not an attempt to replace them. It is a narrower thing: a venue that knows
these three collections specifically, and that keeps its order book on chain so
no operator, including this one, can take it away.

Deliberately **not** part of the game. The collections are not exclusive to it,
and tying the two together would drag a trading venue into the game's codebase
and its legal posture.

---

## 1. Does this need a database?

**No — and that is a design decision, not an omission.**

The order book is already on chain. A listing is a box locked by the sale
contract; the set of live listings is the set of unspent boxes at that
contract's address. Both questions the marketplace has to answer are single
explorer calls:

| question | endpoint |
|---|---|
| what is for sale right now? | `GET /boxes/unspent/byAddress/{contract}` |
| who holds this NFT? | `GET /boxes/unspent/byTokenId/{tokenId}` |

A box carries everything a listing needs: `assets` (which NFT), `value` (price
in nanoERG) and `additionalRegisters` (seller address, so a cancel can pay it
back). Nothing about a listing lives off chain.

The other half — names, traits, images — is **static** and already extracted
(see §3). It ships with the app.

### What a database would buy, and why we skip it

- **Speed.** Scanning contract boxes per request is slower than a query. Solved
  by caching the explorer response at the edge, not by owning data.
- **Trait filters.** Needs listings joined with metadata; the metadata is a
  static file we can index in memory at build time.
- **Sales history / price charts.** This is the one real gap. It is derivable
  from chain history but expensive to reconstruct per request. If we ever want
  it, it should be a **rebuildable cache**, never a source of truth.
- **Accounts, favourites, notifications.** Would need one. Not in scope.

### Why "no database" matters beyond engineering

A wallet address plus an IP is personal data. Storing it makes the project a
data controller under the LGPD — privacy policy, retention rules, breach duty,
a subject to be sued. Storing nothing removes that surface entirely rather than
managing it.

It also keeps the operator posture clean: we hold no keys, no funds, and no user
records. The app builds an unsigned transaction; the user's wallet signs it. See
§2.

---

## 2. Trust model

Everything the marketplace does is a transaction the **user** signs in Nautilus
(EIP-12 dApp connector). The app never holds a private key and never takes
custody of an NFT or of ERG.

A sale is atomic by construction of the eUTXO model: the buyer's transaction
spends the listing box and, in the same transaction, creates an output paying
the seller. Either both happen or the transaction is invalid. There is no state
where anyone has to trust us.

**Royalties.** These three collections are EIP-004. That standard has no royalty
field — R4 is the name, R5 the description, R6 decimals, R7 the asset type, R8
the content hash, R9 the URL. Royalties only exist from EIP-24 onward, and even
there Ergo does not enforce them at the protocol level: a marketplace contract
chooses to honour them. So any payment to the original artists is a term we
build into the sale contract by agreement, never something read off chain.

---

## 3. Collection data

Extracted from chain and shipped static. Ergo has no policy id and no contract
address, so a collection is **a list of token ids** plus the issuer that
authorises it.

| collection | issuer | tokens |
|---|---|---|
| Ergo Champions | `9hyxVZLRuJ1zkgYfMPYHLTnBixAgZfLVwxioWhAXWTD3bLzmntC` | 1498 |
| Ergo Mummy | `9gtuMt4YTz5e1cskqyUAzVCXcQMHNtrF7RyfbnhHvNiQ1UoR697` | 140 |
| Mage Champions | `9fWcVXLphZyFfGFgJ4SXjowYE7WJj4kYPBr5PQshWYj9mCiQTQc` | 1492 |

Two facts that must not be lost:

- **Token names are not unique on Ergo.** Anyone can mint "Ergo Champions #1".
  Membership is decided by token id against the list, never by name.
- **The same edition was minted more than once** in every collection (Ergo
  Champions #1–#5, Mage Champions #199, and twelve numbers in Ergo Mummy —
  where seven of them carry *different artwork under the same number*). So the
  edition number does not identify a piece. **Key everything by `tokenId`.**

---

## 4. Images

Served from this project's own `public/`, with the on-chain `ipfs://` from R9 as
the canonical source and fallback. The chain also gives us R8, the SHA-256 of the
file, so a served copy can be proven byte-identical to what the NFT points at.

Originals are large (Mage Champions PNGs are ~1.5 MB; ~2.6 GB across the three).
Galleries must serve downscaled derivatives; the original belongs on the detail
view only.

**Hosting the artwork requires written permission from the collection owners.**
Holding an NFT does not grant the right to reproduce the work. This is a
prerequisite for launch, not a detail — and it is the one exposure that no
architectural or jurisdictional choice removes.

---

## 5. UI

Reuses the game HUD's visual language: 9-slice pixel chrome (`public/ui/*.png`,
extracted from the game's atlas — 429 bytes total, rather than shipping a 4096²
sheet), VT323 for dense text and Press Start 2P for titles.

The rule the HUD follows and this should too: **geometry never changes with
state.** Hover and pressed re-tint; they do not move or resize. A control that
shifts under the cursor is a mis-click, and here a mis-click spends money.

---

## 6. Open source

The **contract** is the part that must be open and auditable — it is what holds
strangers' NFTs. Publishing it with tests and a written statement of its
invariants delivers most of the trust benefit on its own.

A public repository is not open source without a `LICENSE`; by default it is all
rights reserved. AGPL-3.0 is the candidate if the goal is that anyone can host an
instance and forks stay open, since it extends copyleft to network use.

Never commit: the image originals (not ours, and 2.6 GB), or anything needing a
Supabase service-role key. There is no server-side secret in this design — if one
appears, that is a signal the trust model drifted.
