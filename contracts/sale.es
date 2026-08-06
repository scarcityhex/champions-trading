// sale.es — the listing contract, with EIP-24 royalties.
//
// A seller locks one NFT in a box guarded by this script. The box IS the
// listing: there is no database, no listing id, no server that has to stay up.
// Anything that can read the chain can enumerate what is for sale by asking
// for the unspent boxes at this contract's address.
//
// Registers:
//   R4: SigmaProp  — the seller (their public key)
//   R5: Long       — asking price, in nanoERG
//   R6: Box        — the token's ISSUER box, carrying the royalty
//
// Two ways out, and no third:
//   CANCEL   the seller signs; the box is theirs to reclaim at any time
//   PURCHASE anyone spends it while paying the seller AND the creator
//
// Custody never exists as a state. The NFT goes from the seller's box to the
// buyer's box in one transaction, or that transaction is invalid. The operator
// of the front end cannot move, freeze, or take a cut of anything here — the
// script has no branch that mentions them, and takes no service fee.
//
// ── WHY THE ISSUER BOX IS IN A REGISTER ────────────────────────────────────
//
// A royalty is only trustworthy if the contract can tell a real one from a
// number someone typed. On Ergo the two are distinguishable for a reason that
// is almost an accident of the protocol: a token's id IS the id of the first
// input box of its minting transaction. So the issuer box can be handed to the
// contract as data, and `issuer.id == SELF.tokens(0)._1` proves it is the right
// one — a forged box would have to hash to the token id.
//
// That is why the rate is read here rather than configured. A config file says
// what we believe; this says what the collection committed to at mint time, and
// nobody — including us — can change it after the fact.
//
// EIP-24 has two versions. In V1 the percentage is R4 × 1000 and the royalty is
// paid to the issuer box's own script; in V2 R4 is a version number and R5 lists
// recipients. All three collections here are V1 (R4 = 50, i.e. 5%), which is
// also what the SkyHarbor contract implemented, so V1 is what this honours. A
// V2 issuer box would present a version in R4 and is deliberately NOT handled:
// misreading a version number as a percentage is the one failure that would
// silently overpay, so the front end must refuse to list such a token.

{
  val sellerPk = SELF.R4[SigmaProp].get
  val price    = SELF.R5[Long].get

  // Guarded rather than unwrapped, and the guard is load-bearing.
  //
  // On the cancel branch the seller may be reclaiming a box that was built
  // without R6 — by an older client, or by hand. Calling .get on the absent
  // option aborts the whole script, which would take the cancel branch down
  // with it and lock the NFT forever. `if` is lazy; the access only happens
  // once the register is known to be there.
  val settled =
    if (SELF.R6[Box].isDefined && SELF.tokens.size > 0) {
      val issuer = SELF.R6[Box].get

      // The whole basis of trust: a box whose id is the token id can only be
      // that token's issuer box.
      val authentic = issuer.id == SELF.tokens(0)._1

      // Absent R4 means the collection declared no royalty. Zero, not an error.
      val rate = if (issuer.R4[Int].isDefined) issuer.R4[Int].get else 0

      // Bounded before use. A rate at or above 1000 would compute a royalty of
      // the entire price or more, leaving the seller nothing or making the
      // arithmetic hostile; a negative one would pay the buyer. Neither is a
      // real EIP-24 value, and refusing is safer than clamping.
      val sane = rate >= 0 && rate < 1000

      val royalty = if (sane) price * rate / 1000 else 0L

      // When the seller IS the creator, one output must carry the whole price.
      //
      // Without this the two checks below could be satisfied by the SAME
      // output: `exists` asks each question independently, and a single box
      // paying the seller's 95% also satisfies "at least the 5% royalty, to
      // that same script". A buyer then pays 95% of the price and keeps the
      // rest. It is not a corner case — Mage Champions pays its royalty to a
      // plain P2PK, so the creator listing their own piece would hit it every
      // time. Found in review; the test is named for it.
      val samePayee = sellerPk.propBytes == issuer.propositionBytes
      val sellerGets = if (samePayee) price else price - royalty

      // Both payments carry this box's id in R4.
      //
      // The tag is what stops one payment from settling several listings at
      // once: without it, a buyer could spend two listings by the same seller
      // in one transaction and point both at a single payment box, and each
      // listing would independently see enough value. The seller would ship two
      // NFTs for the price of one. The royalty output needs the same tag for
      // the same reason — two pieces from one collection share a payout
      // address, so one output would otherwise satisfy both.
      val paidSeller = OUTPUTS.exists { (out: Box) =>
        out.value >= sellerGets &&
        out.propositionBytes == sellerPk.propBytes &&
        out.R4[Coll[Byte]].isDefined &&
        out.R4[Coll[Byte]].get == SELF.id
      }

      val paidCreator = royalty <= 0L || samePayee || OUTPUTS.exists { (out: Box) =>
        out.value >= royalty &&
        out.propositionBytes == issuer.propositionBytes &&
        out.R4[Coll[Byte]].isDefined &&
        out.R4[Coll[Byte]].get == SELF.id
      }

      authentic && sane && paidSeller && paidCreator
    } else {
      false
    }

  sellerPk || sigmaProp(settled)
}

// ── Notes for anyone reviewing this ────────────────────────────────────────
//
// WHO BEARS THE ROYALTY
//
// The seller. The buyer pays the advertised price and the contract splits it:
// at 5% on a 10 ERG listing the creator receives 0.5 and the seller 9.5. This
// is the EIP-24 arrangement and what SkyHarbor did, and it is why the price on
// a card is the price someone pays — no total that grows at checkout.
//
// An earlier version of this marketplace added a fee on top of the price
// instead, because the contract then required the seller to receive `price` in
// full and there was no other way. That constraint is gone: the split is now
// computed inside the contract, so the price register can mean the whole trade.
//
// NO SERVICE FEE
//
// SkyHarbor's contract took 2% for itself alongside the royalty. That is not
// copied here. This venue takes nothing, which is a claim the script backs up:
// there is no address in it but the seller's and the creator's.
//
// WHAT THIS SCRIPT DOES NOT CHECK, ON PURPOSE
//
// It does not verify that the token inside is from one of the three
// collections. A contract cannot know what a "collection" is on Ergo — there is
// no policy id; a collection is a list of token ids kept off chain. Enforcing
// membership would mean baking ~3100 ids into the script. So the filter lives
// in the front end, which shows only listings whose token id is in the
// catalog. Someone can lock an unrelated token here; it simply will not be
// displayed.
//
// It does not check that the price is positive. A listing built wrong is built
// wrong by its own seller, who can always cancel.
//
// MINIMUM BOX VALUE
//
// The listing box must hold at least the protocol minimum (currently 0.001
// ERG). That ERG belongs to the seller and comes back to them on cancel, or is
// swept by the buyer on purchase — the front end must account for it so the
// seller is quoted the true net, not the headline price.
//
// THE ROYALTY OUTPUT MUST CLEAR THE MINIMUM BOX VALUE TOO
//
// A 5% royalty on a trade below 0.02 ERG is smaller than a box can hold, so
// such a listing cannot be settled at all. The front end refuses those prices
// rather than letting someone create a listing nobody can buy.
