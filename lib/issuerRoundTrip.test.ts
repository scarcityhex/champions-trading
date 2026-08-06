// issuerRoundTrip.test.ts — the issuer box surviving the trip to the browser.
//
// This exists because of a bug that every other test was blind to. The API
// route returned an already-converted FleetBox and the client converted it
// again; toFleetBox reads `reg.serializedValue`, which a FleetBox does not
// have, so every register was silently dropped — including the R4 holding the
// royalty. The box then no longer hashed to the token id, and a listing built
// from it could be created, funded, and never settled by anyone.
//
// 170 tests were green throughout, because all of them handed the builders a
// box constructed in memory. The trip through JSON is the part that broke, so
// the trip through JSON is what this asserts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeBox } from '@fleet-sdk/serializer';
import { blake2b256, hex } from '@fleet-sdk/crypto';
import { toFleetBox, type ExplorerBox } from './explorer';
import { royaltyOf } from './royalties';

/** An Ergo Mummy issuer box, exactly as the explorer serves it. */
// `as ExplorerBox` because the explorer also sends sigmaType, which our
// narrower type does not model and nothing here reads.
const AS_THE_EXPLORER_SENDS_IT = {
  "boxId": "28048a181868f66dc9898d00a9c747a38e56369f83307e4660010bfc530bd3b6",
  "transactionId": "4b988f59e235f23e92df8a3eb62ffa15ea266c90bb654386612a3ae3905cd17d",
  "index": 0,
  "value": "2000000",
  "address": "2eR9oDmG9onJa8DfTAoSMZUXWQFD3iMhsXPV2NstjA3VKp3WGhTF8gJJRgiwcNeTDTyDv5LuAmNFDzYxV368iv837jkdWbkyUoSWBSNcH8gnTGvJccnMXqPyTBuV91LViRvGz9LDHCvDpWADeYXcmNSaQdcK9GBfpi4942sPfdVnqPKLVanymRXsyfAxZ59bNcVcmZ7cmv8R4VJthmHsL6B724R5VBtACMpAiLCatm5ACW7jwiVP63oSRdtD6RWdyZDojiUtQmBSNxJAMEnXByATM43zt2sxNwbHoWZbv3N4LyKpVmnYp1eQkBAqRYcb94Go28KvJSPPKRzzxCx7orxx33n2cQsNDGoxF4oKM7ti13gR5VeVxG1GaudiTtqWyKwVY",
  "ergoTree": "100e0400040004000500040405020580897a0e240008cd0338fccd45a1f737d81cb90d0fc9876a278049615c2a75b803a4da2c6d7f5f17640e0201010e2091b0cf3793c6fd8e379e28c528b1fcbf541ff896cbbec86fa3378e36b0988b4005000580a4e8030e240008cd0338fccd45a1f737d81cb90d0fc9876a278049615c2a75b803a4da2c6d7f5f176405bcdeddc58260d804d601b2a5730000d602c17201d603c5b2a4730100d604b2db63087201730201860272037303d1eded93b1a57304ecededededed9372038c720401938c7204027305937202730693c27201730793e4c67201070e730893e4c67201080e7309ed92720299b0a4730ad9010541639a8c720501c18c720502730b93c27201730c8f7ea305730d",
  "creationHeight": 725325,
  "assets": [],
  "additionalRegisters": {
    "R4": {
      "serializedValue": "0464",
      "sigmaType": "SInt",
      "renderedValue": "50"
    },
    "R5": {
      "serializedValue": "0e240008cd0338fccd45a1f737d81cb90d0fc9876a278049615c2a75b803a4da2c6d7f5f1764",
      "sigmaType": "Coll[SByte]",
      "renderedValue": "0008cd0338fccd45a1f737d81cb90d0fc9876a278049615c2a75b803a4da2c6d7f5f1764"
    }
  }
} as unknown as ExplorerBox;

/** What the browser receives: the same object, after JSON. */
const overTheWire = () => JSON.parse(JSON.stringify(AS_THE_EXPLORER_SENDS_IT)) as ExplorerBox;

describe('the issuer box reaching the browser', () => {
  it('still hashes to the token id after one conversion', () => {
    const box = toFleetBox(overTheWire());
    const id = hex.encode(blake2b256(serializeBox(box as never).toBytes()));

    // The identity the contract checks. If this drifts, every listing and bid
    // built in a browser is unsettleable.
    expect(id).toBe(AS_THE_EXPLORER_SENDS_IT.boxId);
  });

  it('still carries the royalty after one conversion', () => {
    const royalty = royaltyOf(toFleetBox(overTheWire()));
    expect(royalty?.rate).toBe(50);
    expect(royalty?.percent).toBe(5);
  });

  // The bug itself, kept as a test so the shape cannot come back.
  it('loses everything if converted twice — which is why the route sends raw', () => {
    const once = toFleetBox(overTheWire());
    const twice = toFleetBox(once as unknown as ExplorerBox);

    expect(Object.keys(twice.additionalRegisters ?? {})).toHaveLength(0);
    expect(royaltyOf(twice)).toBeNull();
    expect(hex.encode(blake2b256(serializeBox(twice as never).toBytes()))).not.toBe(
      AS_THE_EXPLORER_SENDS_IT.boxId,
    );
  });
});

// ── The route itself, not a stand-in ─────────────────────────────────────────
//
// The tests above prove that ONE conversion preserves the box. They do not
// prove the route performs zero. If someone makes it return a FleetBox again,
// every assertion above still passes and the bug is back — so this drives the
// real handler with a stubbed explorer and runs the client's path on whatever
// comes out.
describe('GET /api/issuer/:tokenId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function call(tokenId: string) {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(AS_THE_EXPLORER_SENDS_IT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const { GET } = await import('@/app/api/issuer/[tokenId]/route');
    return GET(new Request(`https://example.test/api/issuer/${tokenId}`), {
      params: Promise.resolve({ tokenId }),
    });
  }

  it('sends a box the client can convert once and still settle with', async () => {
    const id = AS_THE_EXPLORER_SENDS_IT.boxId;
    const res = await call(id);
    expect(res.status).toBe(200);

    // Exactly what a browser does: parse, convert once, hand to the builder.
    const { box } = (await res.json()) as { box: ExplorerBox };
    const fleet = toFleetBox(box);

    expect(royaltyOf(fleet)?.percent).toBe(5);
    expect(hex.encode(blake2b256(serializeBox(fleet as never).toBytes()))).toBe(id);
  });

  it('refuses a token id that is not this marketplace’s', async () => {
    const res = await call('ff'.repeat(32));
    expect(res.status).toBe(404);
  });
});
