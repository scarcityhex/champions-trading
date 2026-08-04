// sale.es — the listing contract.
//
// A seller locks one NFT in a box guarded by this script. The box IS the
// listing: there is no database, no listing id, no server that has to stay up.
// Anything that can read the chain can enumerate what is for sale by asking
// for the unspent boxes at this contract's address.
//
// Registers:
//   R4: SigmaProp  — the seller (their public key)
//   R5: Long       — asking price, in nanoERG
//
// Two ways out, and no third:
//   CANCEL   the seller signs; the box is theirs to reclaim at any time
//   PURCHASE anyone spends it while paying the seller the asking price
//
// Custody never exists as a state. The NFT goes from the seller's box to the
// buyer's box in one transaction, or that transaction is invalid. The operator
// of the front end cannot move, freeze, or take a cut of anything here — the
// script has no branch that mentions them.

{
  val sellerPk = SELF.R4[SigmaProp].get
  val price    = SELF.R5[Long].get

  // An output that pays the seller for THIS listing.
  //
  // The `R4 == SELF.id` tag is load-bearing, not bookkeeping. Without it, a
  // buyer could spend two listings by the same seller in one transaction and
  // point both at a single payment box: each listing would look at the same
  // output, see enough value, and independently approve. The seller would ship
  // two NFTs for the price of one. Tagging the payment with the id of the box
  // it settles makes a payment satisfy exactly one listing.
  //
  // propBytes of a SigmaProp is the serialized ErgoTree, which for a P2PK is
  // exactly what a box paying that address carries in propositionBytes — so
  // this compares "paid to the seller" and nothing looser.
  val paid = OUTPUTS.exists { (out: Box) =>
    out.value >= price &&
    out.propositionBytes == sellerPk.propBytes &&
    out.R4[Coll[Byte]].isDefined &&
    out.R4[Coll[Byte]].get == SELF.id
  }

  sellerPk || sigmaProp(paid)
}

// ── Notes for anyone reviewing this ────────────────────────────────────────
//
// WHAT IS DELIBERATELY ABSENT
//
// No marketplace fee. No royalty output. These three collections are EIP-004,
// a standard with no royalty field at all (R4 name, R5 description, R6
// decimals, R7 asset type, R8 content hash, R9 url), and Ergo does not enforce
// royalties at the protocol level even under EIP-24 — a contract honours them
// or it does not. Paying the original artists is therefore a decision to be
// made openly and written in here as another required output, never something
// discovered on chain. Adding either later means a new contract address and a
// migration; existing listings are unaffected, because they are boxes under the
// old script and keep obeying the terms their sellers agreed to.
//
// WHAT THIS SCRIPT DOES NOT CHECK, ON PURPOSE
//
// It does not verify that the token inside is from one of the three
// collections. A contract cannot know what a "collection" is on Ergo — there is
// no policy id; a collection is a list of token ids kept off chain. Enforcing
// membership would mean baking ~3100 ids into the script. So the filter lives
// in the front end, which shows only listings whose token id is in the
// catalog. Someone can lock an unrelated token here; it simply will not be
// displayed. That costs nothing and keeps the on-chain rules small enough to
// read in one sitting.
//
// It does not check that the box holds exactly one token, or that the price is
// positive. A listing built wrong is built wrong by its own seller, who can
// always cancel. Neither case lets anyone take value from anyone else.
//
// MINIMUM BOX VALUE
//
// The listing box must hold at least the protocol minimum (currently 0.001
// ERG). That ERG belongs to the seller and comes back to them on cancel, or is
// swept by the buyer on purchase — the front end must account for it so the
// seller is quoted the true net, not the headline price.
