// collection-offer.es — a standing bid on ANY piece from one collection.
//
// The third contract, and the only one that needs to know what a "collection"
// is. Ergo does not: a token id is derived from the first input box of its
// minting transaction and carries no mark of what it belongs to, so there is no
// address to compare and no policy id to match. Membership is a list kept off
// chain.
//
// The list is therefore committed to a 32-byte Merkle root in R5. Whoever
// accepts supplies the path from their token up to that root, and this script
// recomputes it. A token outside the list has no path that lands on the root,
// so it cannot be delivered — and the list itself never goes on chain.
//
// Registers:
//   R4: SigmaProp   — the bidder
//   R5: Coll[Byte]  — Merkle root over the collection's token ids
//
// Context variables, supplied by whoever accepts:
//   0: Coll[Byte]                     — the token id being delivered
//   1: Coll[(Coll[Byte], Boolean)]    — sibling hashes, and which side each sits
//
// Two ways out, as with the other two contracts:
//   CANCEL  the bidder signs and takes their ERG back
//   ACCEPT  a holder delivers a member token to the bidder and takes the ERG

{
  val bidderPk = SELF.R4[SigmaProp].get
  val root = SELF.R5[Coll[Byte]].get

  val tokenIdOpt = getVar[Coll[Byte]](0)
  val pathOpt = getVar[Coll[(Coll[Byte], Boolean)]](1)

  // Guarded rather than unwrapped directly. On the cancel branch the bidder
  // supplies no context variables at all, and calling .get on the absent option
  // would abort the whole script — taking the cancel branch down with it and
  // stranding the bidder's ERG. `if` is lazy here; the option access only
  // happens once both are known to be present.
  val delivered =
    if (tokenIdOpt.isDefined && pathOpt.isDefined) {
      val tokenId = tokenIdOpt.get
      val path = pathOpt.get

      // Recompute the root from the leaf upward. `_2` says the sibling is on
      // the left, which decides the concatenation order — get it backwards and
      // every honest proof fails.
      val computed = path.fold(blake2b256(tokenId), {
        (acc: Coll[Byte], step: (Coll[Byte], Boolean)) =>
          if (step._2) blake2b256(step._1 ++ acc) else blake2b256(acc ++ step._1)
      })

      val isMember = computed == root

      // The delivery, tagged with this box's id. Same rule as the other two
      // contracts: without the tag one delivery could settle several offers at
      // once, and a bidder running three bids would pay all three for one NFT.
      val paid = OUTPUTS.exists { (out: Box) =>
        out.propositionBytes == bidderPk.propBytes &&
        out.tokens.exists { (t: (Coll[Byte], Long)) => t._1 == tokenId && t._2 >= 1L } &&
        out.R4[Coll[Byte]].isDefined &&
        out.R4[Coll[Byte]].get == SELF.id
      }

      isMember && paid
    } else {
      false
    }

  bidderPk || sigmaProp(delivered)
}

// ── Notes for anyone reviewing this ────────────────────────────────────────
//
// THE BID IS THE BOX'S ERG
//
// As with offer.es, there is no price register: whatever the box holds is what
// an acceptor receives. A bid that exists is a bid that is funded. Several
// independent bids are several boxes — three at 1 ERG and one at 2 ERG are four
// boxes, settled independently, and a holder takes whichever they like.
//
// WHO CHOOSES WHICH PIECE
//
// The holder does. A collection bid is an offer for the collection's floor, not
// its average, and in practice the piece delivered will be the one the holder
// values least. That is true of collection bids everywhere and is not a defect,
// but a front end that presents it as "an offer on your NFT" is misleading its
// user. It should say the bid is for any piece.
//
// A narrower scope needs no change here — only a different root. A tree built
// over the rarest tenth of a collection produces a bid that only those pieces
// can settle, and the script never learns what the scope meant.
//
// WHAT THE ROOT DOES NOT PROVE
//
// That the ids in the tree are genuinely that collection's. The root commits to
// whatever list it was built from; if that list is wrong, the bid is wrong in
// the same way. The catalogue is checked against the chain separately, by
// scripts/verify-catalog.mjs, and the root is pinned alongside the contract
// addresses so a change to either fails a test rather than passing quietly.
//
// Burned tokens are simply left out of the tree. Nobody can prove membership of
// something that no longer exists, which is the correct outcome and costs
// nothing to arrange.
