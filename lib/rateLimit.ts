// Best-effort per-instance rate limiting for public read APIs.
//
// A serverless deployment can have several instances, so this is not an
// account-grade quota. It is still valuable here: one caller cannot turn one
// warm instance into an uncached proxy that hammers the public Ergo explorer.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;
let lastSweep = 0;

export type RateLimitResult =
  | { allowed: true; remaining: number; retryAfter: 0 }
  | { allowed: false; remaining: 0; retryAfter: number };

function clientId(request: Request): string {
  const forwarded =
    request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  const candidate = forwarded?.split(',')[0]?.trim() || 'unknown';
  // Bound each key; the map itself has a separate hard cap below.
  return candidate.slice(0, 64);
}

export function checkRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  if (now - lastSweep >= windowMs) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    lastSweep = now;
  }

  const key = `${scope}:${clientId(request)}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil(windowMs / 1000) };
    }

    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count, retryAfter: 0 };
}

/** Test-only reset; not used by route handlers. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
