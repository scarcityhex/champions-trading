# Sales history: the one thing that wants storage

Everything else in this marketplace reads from the chain (see
`architecture.md` §1). History is the exception — not because it is missing from
the chain, but because reconstructing it means walking blocks, and no one will
wait for that on page load.

So the question is not "do we need a database" but **"what is the smallest thing
that answers 'what did this sell for last time'"**.

---

## The shape of the data

History is unusually friendly to store:

- **Append-only.** A settled sale never changes. No updates, no deletes, no
  migrations of existing rows.
- **Derived.** Every row is recomputable from the chain. If the store is lost,
  corrupted, or deliberately thrown away, it rebuilds. It is a cache with a long
  memory, never a source of truth.
- **Small.** Three collections, and SkyHarbor — the venue that carried most of
  their volume — is already closed. Lifetime sales are plausibly in the low
  thousands. At ~120 bytes a row, ten thousand sales is about 1 MB.

Nothing about that needs Postgres. It needs a file, until it doesn't.

---

## Tier 0 — a JSON file and a scheduled job (start here)

An indexer runs on a cron, asks the explorer for transactions spending boxes at
the sale contract since the last height it recorded, appends the settled ones,
and commits the file back to the repo.

```
data/history.json     { lastHeight, sales: [{ boxId, tokenId, price, seller, buyer, height, timestamp }] }
scripts/index-sales.mjs
.github/workflows/index-sales.yml   (cron: every 6h)
```

What this buys, beyond costing nothing:

- **No secret reaches the app.** The site is static; it imports a file. There is
  no connection string, no anon key, no service role, nothing to leak. The
  security surface of the history feature is zero.
- **The history is publicly auditable.** Every append is a commit. Anyone can
  diff it against the chain and catch a lie. For a venue asking strangers to
  trust it, that is worth more than the convenience a database would add.
- **It cannot go down.** No project to pause, no free tier to exhaust.

**Move off it when** the file passes a few MB, the page starts shipping history
it does not display, or you want server-side filtering and pagination rather
than loading everything and filtering in the browser. Those are the real
triggers. Traffic alone is not one — a static file behind a CDN outscales any
database you would provision for this.

---

## Tier 1 — a Postgres table, when Tier 0 runs out

One table, and it stays one table:

```sql
create table sales (
  box_id      text primary key,          -- the spent listing box; naturally idempotent
  token_id    text not null,
  price       bigint not null,           -- nanoERG
  seller      text not null,
  buyer       text not null,
  height      integer not null,
  sold_at     timestamptz not null
);
create index on sales (token_id, height desc);
```

`box_id` as the primary key is what makes the indexer safe to re-run: a box can
only be spent once, so replaying an overlapping range upserts over itself
instead of double-counting. An indexer that cannot be safely re-run will
eventually be re-run anyway, at the worst moment.

Two rules, and they are not optional:

- **The web app only ever reads.** RLS: `select` for `anon`, nothing else. No
  user input reaches this table — not a favourite, not a view count, not a
  comment. The moment users can write, the whole injection-and-abuse surface
  this design avoids comes back, along with a moderation duty.
- **The service-role key lives only in the indexer**, as a CI secret. It must
  never appear in the Next.js app, in `NEXT_PUBLIC_*`, or in the repo — which is
  public.

---

## Should this reuse the game's Supabase project?

**No. A separate project, on the same account.**

It costs nothing — the free tier covers this several times over — and sharing
buys you only one dashboard to look at. Against that:

- **Blast radius.** The game's project holds a service-role key and real user
  data (`user_wallets`, players, matches). A mistake in a public marketplace
  repo — a key pasted into a client component, an RLS policy written too wide —
  becomes a game-data incident. Two projects means a marketplace mistake can
  only damage marketplace data, all of which is a rebuildable mirror of public
  chain records.
- **RLS mistakes travel.** Mixing an anon-readable `sales` table into the same
  project as tables that must stay locked down makes a wrong policy far easier
  to write and far harder to notice.
- **It is the link that undoes the separation.** The reason this lives in its
  own repo is to keep the game and a trading venue as separate systems. A shared
  database is the single most concrete fact anyone could point at to argue they
  are one system. Do not create it to save a click.

The one thing worth sharing is the **account**, so billing and access stay in one
place.

*Operational note:* a free Supabase project pauses after about a week of
inactivity. A cron indexer keeps it awake — but if the indexer is what wakes it,
a paused project also means a silently stale history. Alert on
`lastHeight` falling too far behind the chain tip, not on the job exiting zero.

---

## The bureaucratic side

**Mirroring settled trades is not the same as running an order book.** This is
the distinction that matters more than any other on this page.

- Storing sales that **already settled on chain** makes this a mirror of public
  records. It adds no intermediation: the trade happened without us and would
  have happened identically if this site did not exist.
- Storing **unsettled intent** — bids, offers, an off-chain book that the site
  matches — is a different activity. That is arranging trades *por conta de
  terceiros*, which is the language BCB Resoluções 519/520/521 use for the
  intermediation modality. The schema itself is what moves you across that line,
  not the traffic and not the revenue.

So: keep the table to settled facts. The moment someone proposes storing an
offer the site will later match, that is a business decision with a regulatory
consequence, not a feature.

**On LGPD.** Wallet addresses are pseudonymous, and pseudonymous data is still
personal data when it can be linked to a person. Storing them is defensible —
they are already public, and art. 7º IX legitimate interest fits a public-record
mirror — but it is only defensible if you keep it thin:

- Never store IPs, user agents, sessions, or anything that joins an address to
  an identity. That join is what turns pseudonymous into identified.
- Never store analytics alongside it. If you want traffic numbers, use something
  that does not touch this table.
- Publish a short notice saying what is mirrored, from where, and why. One
  paragraph. It exists so the answer is on record before anyone asks.
- Because every row is rebuildable from public data, a deletion request is
  cheap to honour and cheap to explain.

**On the artwork.** Unchanged by any of this, and still the largest exposure:
hosting the images needs written permission from the collection owners. No
storage decision affects that.
