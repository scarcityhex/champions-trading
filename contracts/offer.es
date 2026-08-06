// offer.es — a standing bid on a token that is not for sale.
//
// The mirror image of sale.es. There, a seller locks a token and waits for ERG;
// here a bidder locks ERG and waits for a token. Same shape, same guarantees:
// the box IS the offer, no database holds it, and no one takes custody of
// anything.
//
// This is what makes offers possible at all without becoming an order book. The
// bid is not an intention we record and later match — it is funded, on chain,
// and anyone holding the token can settle it unilaterally. Nothing about it
// passes through us.
//
// Registers:
//   R4: SigmaProp   — the bidder
//   R5: Coll[Byte]  — the token id being bid on
//   R6: Box         — that token's ISSUER box, carrying the creator's royalty
//
// Two ways out:
//   CANCEL  the bidder signs and takes their ERG back
//   ACCEPT  whoever holds the token delivers it to the bidder and takes the ERG

{
  val bidderPk = SELF.R4[SigmaProp].get
  val tokenId = SELF.R5[Coll[Byte]].get

  // An output that delivers the wanted token to the bidder, settling THIS offer.
  //
  // The `R4 == SELF.id` tag plays the same role it does in sale.es: without it,
  // two offers by the same bidder for the same token could both be spent
  // against a single delivery, and the bidder would pay twice for one NFT.
  //
  // `>= 1L` rather than `== 1L` because a delivery carrying more than the one
  // token wanted only ever favours the bidder. Being strict here would reject
  // an honest transaction that happened to batch.
  val delivered = OUTPUTS.exists { (out: Box) =>
    out.propositionBytes == bidderPk.propBytes &&
    out.tokens.exists { (t: (Coll[Byte], Long)) => t._1 == tokenId && t._2 >= 1L } &&
    out.R4[Coll[Byte]].isDefined &&
    out.R4[Coll[Byte]].get == SELF.id
  }

  // The creator's share, on the same terms as a sale.
  //
  // Guarded so the cancel branch never touches R6: a bid made by an older
  // client has no issuer box, and calling .get on the absent option would abort
  // the script and strand the bidder's ERG.
  val settled =
    if (SELF.R6[Box].isDefined) {
      val issuer = SELF.R6[Box].get

      // Same proof as sale.es: a box whose id is the token id can only be that
      // token's issuer box.
      val authentic = issuer.id == tokenId

      val rate = if (issuer.R4[Int].isDefined) issuer.R4[Int].get else 0
      val sane = rate >= 0 && rate < 1000

      // The bid IS the box's ERG, so that is what the share is taken from. The
      // holder nets less; the bidder pays exactly what they bid, which is the
      // arrangement a sale makes too.
      val royalty = if (sane) SELF.value * rate / 1000 else 0L

      val paidCreator = royalty <= 0L || OUTPUTS.exists { (out: Box) =>
        out.value >= royalty &&
        out.propositionBytes == issuer.propositionBytes &&
        // No tokens, so this can never be the delivery box counted twice. In
        // sale.es the same collision is handled by comparing payees; here the
        // delivery is the only output that must carry a token, which makes
        // "carries none" the cheaper and stricter separator.
        out.tokens.size == 0 &&
        out.R4[Coll[Byte]].isDefined &&
        out.R4[Coll[Byte]].get == SELF.id
      }

      authentic && sane && delivered && paidCreator
    } else {
      false
    }

  bidderPk || sigmaProp(settled)
}

// ── Notes for anyone reviewing this ────────────────────────────────────────
//
// THE BID IS THE BOX'S ERG
//
// There is no price register. Whatever ERG the box holds is what the acceptor
// receives, so the offer cannot promise more than it has funded — a bid that
// exists is a bid that can be paid. The app must show the box value as the
// offer amount and nothing else.
//
// WHAT THIS DOES NOT CHECK
//
// It does not verify the token belongs to one of the three collections, for the
// same reason sale.es does not: there is no policy id on Ergo, and a collection
// is a list of token ids kept off chain. The front end filters; the script stays
// small enough to read.
//
// It does not require the bidder to be anyone in particular, or the token to be
// unlisted. An offer on a token that is also listed is legal and harmless — the
// holder can take whichever is better, and the loser can be cancelled.
//
// ACCEPTING COSTS THE ACCEPTOR A FEE
//
// The acceptor pays the network fee out of their own inputs, and funds the min
// box value of the delivery output. Both come back to them out of the offer
// box's ERG in change, but the app must quote the net, not the headline bid,
// or it overstates what the holder walks away with.
