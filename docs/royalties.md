# Creator royalties (EIP-24)

Every trade through this venue pays the collection's creator a share, and the
contract requires it. The rate is not configured here — it is read from the
chain, where each collection published it at mint time.

All three collections declare **5%**.

## Where the rate comes from

A token's id on Ergo is the id of the **first input box of its minting
transaction**. That box is the *issuer box*, and under EIP-24 its R4 holds the
royalty rate.

That identity is what makes the rate enforceable rather than advisory. The
issuer box can be handed to a contract as data, and

```
issuer.id == SELF.tokens(0)._1
```

proves it is the right one: a forged box would have to hash to the token id.
`contracts/sale.es` stores the issuer box in the listing's R6 and checks exactly
this before computing anything.

### The mistake worth not repeating

There are two boxes here and only one carries the royalty:

| query | what it returns | has the royalty? |
|---|---|---|
| `/tokens/{id}` → `.boxId` | the minting **output** — EIP-004 name, image, hash | no |
| `/boxes/{tokenId}` | the **issuer box** | **yes**, in R4 |

This project originally read the first one, found the ordinary EIP-004
registers, and concluded no royalty had been declared. That was wrong, and it
was wrong in the direction that would have short-paid three creators. If you
are ever checking whether a token has a royalty, `lib/explorer.ts`'s
`issuerBoxOf` is the only correct route.

### V1 and V2 disagree about R4

| | R4 | paid to |
|---|---|---|
| **V1** | percentage × 1000 — `50` is 5% | the issuer box's own script |
| **V2** | the standard's version number | recipients listed in R5 |

These collections are V1 (`R4 = 50`), which is also what the SkyHarbor contract
implemented.

The two are not always distinguishable. `R4 = 2` is either a V1 rate of 0.2% or
a V2 box declaring version 2, and nothing in R4 says which. `lib/royalties.ts`
therefore **refuses** any rate below 1% rather than picking a reading: treating
it as no royalty would short the creator, and treating it as a rate would pay
whoever V1 names instead of the recipients V2 lists in R5. Such a token cannot
be listed here at all.

Above 1% the ambiguity is gone — no version number reaches 10 — and the rate is
used as V1 intends.

## Who pays

The seller, out of the advertised price. A 10 ERG listing means the buyer pays
10, the creator receives 0.5, and the seller 9.5. The price on a card is the
price someone pays; nothing grows at checkout.

An earlier version of this marketplace added a fee *on top* of the price,
because the contract then required the seller to receive `price` in full and
there was no other way to arrange it. That constraint is gone: the split now
happens inside the contract, so the price register can mean the whole trade.

## Every trade, not just sales

All three contracts enforce it.

`sale.es` takes the share out of the advertised price. `offer.es` and
`collection-offer.es` take it out of the bid: the bidder pays exactly what they
bid, and the holder nets less — the same arrangement a sale makes, where the
side receiving ERG bears the royalty.

The two offer contracts authenticate the issuer box the same way, but get it
from different places. A specific offer names its token when the bid is made, so
the box travels in the bid's R6. A collection offer does not know which piece
will settle it, so the acceptor supplies the box in context variable 2 and the
script proves it by `issuer.id == tokenId` — the token they are actually
handing over.

They also separate the royalty output from the delivery differently. `sale.es`
compares payees, because both its outputs are plain ERG. The offer contracts
require the royalty output to **carry no token**, which is stricter and cheaper:
the delivery is the only output obliged to hold the NFT, so one output can never
satisfy both checks.

**No service fee.** SkyHarbor's contract took 2% for itself alongside the
royalty. That is not copied. This venue takes nothing, and the scripts back the
claim: they contain no address but the counterparties' and the creator's.

## Practical limits

Fees round **down**, matching the contract's integer division exactly. A
mismatch either way is fatal — pay a nanoERG less and the script rejects the
transaction, pay more and it comes out of the seller.

A royalty output is a box, and a box cannot hold less than the protocol
minimum. At 5% that puts the floor at **0.02 ERG**: below it the royalty check
can never be satisfied, so `buildListTx` refuses the price rather than creating
a listing nobody could buy.

## Verifying a collection's rate yourself

```bash
curl -s https://api.ergoplatform.com/api/v1/boxes/<tokenId> | jq '.additionalRegisters.R4, .address'
```

`R4.renderedValue` of `50` is 5%. `address` is where the contract will send it.
For Ergo Champions that address holds over 1,500 boxes of royalty history, most
already swept by the owner — which is how we confirmed the payout script is live
rather than a hole to drop money into.
