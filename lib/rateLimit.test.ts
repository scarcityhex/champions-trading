import { beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimits } from './rateLimit';

const requestFrom = (ip: string) =>
  new Request('https://market.example/api/market', {
    headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` },
  });

describe('public API rate limiting', () => {
  beforeEach(resetRateLimits);

  it('blocks an IP after its quota and returns a usable retry delay', () => {
    const request = requestFrom('203.0.113.10');

    expect(checkRateLimit(request, 'market', 2, 60_000, 1_000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit(request, 'market', 2, 60_000, 1_001)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(checkRateLimit(request, 'market', 2, 60_000, 1_002)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfter: 60,
    });
  });

  it('keeps independent IPs and route scopes independent', () => {
    const first = requestFrom('203.0.113.10');
    const second = requestFrom('203.0.113.11');

    checkRateLimit(first, 'market', 1, 60_000, 1_000);

    expect(checkRateLimit(first, 'market', 1, 60_000, 1_001).allowed).toBe(false);
    expect(checkRateLimit(second, 'market', 1, 60_000, 1_001).allowed).toBe(true);
    expect(checkRateLimit(first, 'holder', 1, 60_000, 1_001).allowed).toBe(true);
  });

  it('opens a fresh bucket after the window expires', () => {
    const request = requestFrom('203.0.113.10');
    checkRateLimit(request, 'market', 1, 1_000, 1_000);

    expect(checkRateLimit(request, 'market', 1, 1_000, 1_999).allowed).toBe(false);
    expect(checkRateLimit(request, 'market', 1, 1_000, 2_000)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfter: 0,
    });
  });
});
