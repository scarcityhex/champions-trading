import { afterEach, describe, expect, it, vi } from 'vitest';

const original = process.env.NEXT_PUBLIC_ERGO_NETWORK;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_ERGO_NETWORK;
  else process.env.NEXT_PUBLIC_ERGO_NETWORK = original;
  vi.resetModules();
});

describe('network selection', () => {
  it('accepts only an explicit supported network', async () => {
    process.env.NEXT_PUBLIC_ERGO_NETWORK = 'testnet';
    vi.resetModules();
    await expect(import('./contract')).resolves.toMatchObject({ NETWORK: 'testnet' });
  });

  it('does not turn a typo into a mainnet deployment', async () => {
    process.env.NEXT_PUBLIC_ERGO_NETWORK = 'maintnet';
    vi.resetModules();
    await expect(import('./contract')).rejects.toThrow(/explicitly set/);
  });

  it('preserves mainnet as the local default when unset', async () => {
    delete process.env.NEXT_PUBLIC_ERGO_NETWORK;
    vi.resetModules();
    await expect(import('./contract')).resolves.toMatchObject({ NETWORK: 'mainnet' });
  });

  it('decodes seller public keys with the selected network prefix', async () => {
    process.env.NEXT_PUBLIC_ERGO_NETWORK = 'testnet';
    vi.resetModules();
    const { sellerAddressFrom } = await import('./transactions');

    expect(
      sellerAddressFrom(
        '08cd02b55510f92d1f6ebe1572e6a7f745dd63c2aa3ae26c4f921f20df2f5f4215de84',
      ),
    ).toBe('3Wwz4zD5vwh8xtQoe6wVFYxwT3kYxTWvvEgFtxuxj3iBNT5oYt5D');
  });
});
