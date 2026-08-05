// explorer.test.ts — the mirror fallback.
//
// Tested with a stubbed fetch rather than the network: the cases that matter
// are outages, and an outage is not something you can ask a live explorer for.
//
// The distinction under test is between "this mirror is unwell" (rotate) and
// "this mirror answered, and the answer is no" (do not rotate). Getting it
// backwards is expensive in both directions: rotating on a 404 doubles every
// miss, and not rotating on a 503 makes the fallback decorative.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLong } from '@fleet-sdk/core';
import { EXPLORER_MIRRORS, toErg, toErgRounded, type ExplorerBox } from './explorer';
import { SALE_ADDRESS, SALE_ERGO_TREE } from './contract';

const [PRIMARY, SECONDARY] = EXPLORER_MIRRORS;

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('', { status: code });

/** Fresh module per test — the preferred-mirror pointer is module state. */
async function freshApi() {
  vi.resetModules();
  return (await import('./explorer')).api;
}

describe('explorer mirror fallback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the primary when it is healthy', async () => {
    fetchMock.mockResolvedValue(ok({ total: 1 }));
    const api = await freshApi();

    await expect(api('/tokens/x')).resolves.toEqual({ total: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${PRIMARY}/tokens/x`);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls through to the secondary when the primary is down', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith(PRIMARY) ? status(503) : ok({ ok: true })),
    );
    const api = await freshApi();

    await expect(api('/tokens/x')).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${PRIMARY}/tokens/x`,
      `${SECONDARY}/tokens/x`,
    ]);
  });

  it('rotates on a rate limit, which is an outage and not an answer', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith(PRIMARY) ? status(429) : ok({ ok: true })),
    );
    const api = await freshApi();
    await expect(api('/tokens/x')).resolves.toEqual({ ok: true });
  });

  it('rotates when the primary cannot be reached at all', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith(PRIMARY) ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(ok({ ok: true })),
    );
    const api = await freshApi();
    await expect(api('/tokens/x')).resolves.toEqual({ ok: true });
  });

  // The other half of the rule: every mirror will say 404 to the same query, so
  // asking again is a wasted round trip on a path the detail page hits often.
  it('does not rotate on a 404 — every mirror would answer the same', async () => {
    fetchMock.mockResolvedValue(status(404));
    const api = await freshApi();

    await expect(api('/tokens/nope')).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sticks to the working mirror instead of re-timing-out on every call', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith(PRIMARY) ? status(503) : ok({ ok: true })),
    );
    const api = await freshApi();

    await api('/a');
    fetchMock.mockClear();
    await api('/b');

    // Second call goes straight to the mirror that worked; the dead primary is
    // not retried until the cooldown lapses.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SECONDARY}/b`);
  });

  it('gives up with a clear message when every mirror is down', async () => {
    fetchMock.mockResolvedValue(status(502));
    const api = await freshApi();

    await expect(api('/tokens/x')).rejects.toThrow(/all explorer mirrors failed/);
    // Two rounds over both mirrors: a blip on one is often not a blip on both.
    expect(fetchMock).toHaveBeenCalledTimes(EXPLORER_MIRRORS.length * 2);
  });
});

const SELLER_PK = '02b55510f92d1f6ebe1572e6a7f745dd63c2aa3ae26c4f921f20df2f5f4215de84';
const NFT = '5836c62731c4f5f0d0e4a5f0b3f9a4d0c2e8b1a7f6d3c9e2b8a4f1d7c3e9b2a8';

function listingBox(overrides: Partial<ExplorerBox> = {}): ExplorerBox {
  return {
    boxId: 'aa'.repeat(32),
    transactionId: 'bb'.repeat(32),
    index: 0,
    value: '1000000',
    address: SALE_ADDRESS,
    ergoTree: SALE_ERGO_TREE,
    creationHeight: 1_500_000,
    assets: [{ tokenId: NFT, amount: '1' }],
    additionalRegisters: {
      R4: { serializedValue: `08cd${SELLER_PK}` },
      // Deliberately lie in renderedValue: only serialized bytes are trusted.
      R5: { serializedValue: SLong(5n).toHex(), renderedValue: '999999999999' },
    },
    ...overrides,
  };
}

describe('explorer response validation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes listing price from serialized register bytes, never rendered text', async () => {
    fetchMock.mockResolvedValue(ok({ items: [listingBox()], total: 1 }));
    vi.resetModules();
    const { fetchListings } = await import('./explorer');

    const listings = await fetchListings();

    expect(listings).toHaveLength(1);
    expect(listings[0].price).toBe(5n);
  });

  it('ignores a box whose address response carries the wrong ErgoTree', async () => {
    fetchMock.mockResolvedValue(ok({ items: [listingBox({ ergoTree: '00' })], total: 1 }));
    vi.resetModules();
    const { fetchListings } = await import('./explorer');

    await expect(fetchListings()).resolves.toEqual([]);
  });

  it('rejects malformed pagination metadata instead of looping on it', async () => {
    fetchMock.mockResolvedValue(ok({ items: [listingBox()], total: 'many' }));
    vi.resetModules();
    const { unspentAt } = await import('./explorer');

    await expect(unspentAt(SALE_ADDRESS)).rejects.toThrow(/invalid unspent-box page/);
  });

  it('returns a holder only from a coherent box that contains the requested NFT', async () => {
    fetchMock.mockResolvedValue(ok({ items: [listingBox()] }));
    vi.resetModules();
    const { holderOf } = await import('./explorer');

    await expect(holderOf(NFT)).resolves.toBe(SALE_ADDRESS);
  });

  it('rejects a holder box that does not contain a one-of-one NFT', async () => {
    fetchMock.mockResolvedValue(
      ok({ items: [listingBox({ assets: [{ tokenId: NFT, amount: '2' }] })] }),
    );
    vi.resetModules();
    const { holderOf } = await import('./explorer');

    await expect(holderOf(NFT)).rejects.toThrow(/one-of-one/);
  });
});

describe('ERG formatting', () => {
  it('formats negative net proceeds without a negative fractional remainder', () => {
    expect(toErg(-1_100_000n)).toBe('-0.0011');
  });
});

describe('rounded ERG, for summary readouts only', () => {
  // The case that prompted it: 7.3 ERG over six trades.
  it('cuts a repeating average down to something readable', () => {
    expect(toErgRounded(1_216_666_666n)).toBe('1.22');
  });

  it('keeps exact values short instead of padding them out', () => {
    expect(toErgRounded(7_300_000_000n)).toBe('7.3');
    expect(toErgRounded(1_000_000_000n)).toBe('1');
    expect(toErgRounded(0n)).toBe('0');
  });

  it('rounds half away from zero', () => {
    expect(toErgRounded(1_005_000_000n)).toBe('1.01');
    expect(toErgRounded(1_004_999_999n)).toBe('1');
  });

  // Anything under half a cent rounds to nothing; showing "-0" would read as a
  // loss that is not there.
  it('never prints a negative zero', () => {
    expect(toErgRounded(-1_000_000n)).toBe('0');
    expect(toErgRounded(-1_216_666_666n)).toBe('-1.22');
  });

  it('stays exact on values a double could not represent', () => {
    expect(toErgRounded(9_007_199_254_740_993_000_000_000n)).toBe('9007199254740993');
  });

  it('honours a wider precision when asked', () => {
    expect(toErgRounded(1_216_666_666n, 4)).toBe('1.2167');
  });

  // The whole reason it is a separate function: prices must not be rounded.
  it('leaves toErg exact, so a price still matches to the nanoERG', () => {
    expect(toErg(1_216_666_666n)).toBe('1.216666666');
  });
});
