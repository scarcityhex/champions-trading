// royalties.ts — EIP-24 royalties, read from the chain.
//
// This file used to hold a percentage per collection in a JSON config, and the
// front end added it as an extra output. That was wrong in a way worth
// recording: these three collections had ALREADY declared a royalty on chain,
// at mint time, and a config file would have been a second, competing answer to
// a question the blockchain already answers.
//
// The royalty lives in the ISSUER box — the box whose id became the token id,
// which is the first input of the minting transaction. Its R4 holds the rate.
// Because token id and issuer box id are the same value, a contract handed that
// box can prove it is the right one, which is why sale.es can enforce the split
// instead of trusting us to add an output.
//
// EIP-24 has two versions and they disagree about what R4 means:
//
//   V1  R4 = percentage × 1000 (so 50 is 5%), royalty paid to the issuer box's
//       own script. All three collections here are V1, as was SkyHarbor.
//   V2  R4 = the standard's version number, R5 lists recipients and shares.
//
// Reading a V2 version number as a V1 percentage is the one mistake that would
// silently overpay — "version 2" would become 0.2%, and a higher version worse.
// So anything that does not look like a V1 rate is refused rather than guessed
// at, here and in the contract.

import { SAFE_MIN_BOX_VALUE } from '@fleet-sdk/core';
import type { FleetBox } from './transactions';

/** What a token's issuer box says about paying its creator. */
export type Royalty = {
  /** Percentage × 1000, exactly as stored: 50 means 5%. */
  rate: number;
  /** Where the payment must go — the issuer box's own script. */
  propositionBytes: string;
  /** For display: 50 -> 5. */
  percent: number;
};

/** V1 rates only. 1000 would be the entire price; a real one is far below. */
const MAX_RATE = 1000;

/**
 * Below this, R4 cannot be told apart from a V2 version number.
 *
 * V1 stores percentage × 1000, so 10 is 1%. V2 stores the standard's version —
 * 1, 2, and upward — in the same register. A V2 box declaring version 2 is
 * indistinguishable from a V1 box declaring 0.2%, and reading it as the latter
 * would pay 0.2% to whatever V1 says instead of the recipients V2 lists in R5.
 *
 * The documentation used to claim this was validated when nothing checked it.
 * It is checked now, and the ambiguous range is REFUSED rather than assumed
 * either way: silently treating it as no royalty would short the creator, and
 * silently treating it as a rate would pay the wrong party.
 */
const MIN_UNAMBIGUOUS_RATE = 10;

/** Thrown for an issuer box this code cannot read safely. */
export class AmbiguousRoyaltyError extends Error {}

function registerValue(box: FleetBox, name: 'R4'): string | undefined {
  const raw = (box.additionalRegisters as Record<string, unknown> | undefined)?.[name];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'serializedValue' in raw) {
    const v = (raw as { serializedValue?: unknown }).serializedValue;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * The rate an issuer box declares, or null when it declares none.
 *
 * `04` is the SInt type tag and the rest is a zig-zag VLQ integer — decoded
 * here rather than trusting the explorer's `renderedValue`, for the same reason
 * listing prices are: rendered fields are the explorer's opinion, serialized
 * bytes are the chain's.
 */
export function royaltyOf(issuerBox: FleetBox | undefined): Royalty | null {
  if (!issuerBox) return null;
  const r4 = registerValue(issuerBox, 'R4');
  if (!r4 || !r4.startsWith('04')) return null;

  let value = 0n;
  let shift = 0n;
  for (let i = 2; i < r4.length; i += 2) {
    const byte = BigInt(parseInt(r4.slice(i, i + 2), 16));
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) break;
    shift += 7n;
  }
  // Zig-zag: the low bit is the sign.
  const rate = Number((value >> 1n) ^ -(value & 1n));

  if (!Number.isInteger(rate) || rate <= 0 || rate >= MAX_RATE) return null;

  if (rate < MIN_UNAMBIGUOUS_RATE) {
    throw new AmbiguousRoyaltyError(
      `This token's issuer box has R4 = ${rate}, which is either a ${rate / 10}% EIP-24 V1 ` +
        'royalty or a V2 version number. The two cannot be told apart, and guessing would ' +
        'either short the creator or pay the wrong one. It cannot be listed here.',
    );
  }
  return {
    rate,
    propositionBytes: issuerBox.ergoTree,
    percent: rate / 10,
  };
}

/**
 * The creator's share of a price, in nanoERG.
 *
 * Rounds down, matching the contract's integer division exactly. A mismatch in
 * either direction is fatal: pay less and the script rejects the transaction,
 * pay more and the seller is short.
 */
export const royaltyOn = (price: bigint, royalty: Royalty | null): bigint =>
  royalty ? (price * BigInt(royalty.rate)) / 1000n : 0n;

/** What the seller receives: the advertised price less the creator's share. */
export const sellerReceives = (price: bigint, royalty: Royalty | null): bigint =>
  price - royaltyOn(price, royalty);

/**
 * The smallest price that can actually be settled.
 *
 * A royalty output is a box, and a box cannot hold less than the protocol
 * minimum. At 5% that makes 0.02 ERG the floor — below it the contract's
 * royalty check can never be satisfied, so the listing would be created and
 * then be unbuyable by anyone. Refused at listing time instead.
 */
export function minimumPrice(royalty: Royalty | null): bigint {
  if (!royalty) return 1n;
  // Smallest price whose floor-divided royalty still funds a box.
  return (SAFE_MIN_BOX_VALUE * 1000n + BigInt(royalty.rate) - 1n) / BigInt(royalty.rate);
}

/**
 * `royaltyOf` for display code, which must not crash on an odd token.
 *
 * Returns null where the rate is unreadable. Only for showing figures — never
 * for building a transaction, where an ambiguous box has to stop the flow
 * rather than quietly become "no royalty".
 */
export function royaltyForDisplay(issuerBox: FleetBox | undefined): Royalty | null {
  try {
    return royaltyOf(issuerBox);
  } catch {
    return null;
  }
}
