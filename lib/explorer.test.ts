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
import { EXPLORER_MIRRORS } from './explorer';

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
