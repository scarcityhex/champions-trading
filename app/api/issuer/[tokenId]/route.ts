// GET /api/issuer/:tokenId — the box whose id IS this token id.
//
// This route exists because of the Content-Security-Policy in next.config.ts:
// `connect-src 'self'` means the browser cannot call the explorer directly, and
// listing or buying needs the issuer box to read the creator's royalty out of.
// Without this the whole royalty path works in tests and fails silently in a
// real browser — found in review, before it shipped.
//
// The answer is immutable: an issuer box was spent in the transaction that
// minted its token and can never change, so it is cached hard rather than for
// thirty seconds like the order book.

import { NextResponse } from 'next/server';
import { api, type ExplorerBox } from '@/lib/explorer';
import { BY_TOKEN_ID } from '@/lib/collections';
import { checkRateLimit } from '@/lib/rateLimit';

export const revalidate = 3600;

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const rate = checkRateLimit(request, 'issuer', 120, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'too many issuer lookups' },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter), 'Cache-Control': 'private, no-store' },
      },
    );
  }

  const { tokenId } = await params;

  // The path segment reaches the explorer URL, so it is validated rather than
  // trusted. A token id is 32 bytes of hex and nothing else.
  if (!/^[0-9a-f]{64}$/.test(tokenId)) {
    return NextResponse.json({ error: 'not a token id' }, { status: 400 });
  }
  if (!BY_TOKEN_ID.has(tokenId)) {
    return NextResponse.json({ error: 'token is not in the marketplace catalog' }, { status: 404 });
  }

  // The RAW explorer shape, deliberately.
  //
  // An earlier version returned a converted FleetBox, and the client converted
  // it a second time. toFleetBox reads `reg.serializedValue`, which a FleetBox
  // does not have — so every register was silently dropped, including the R4
  // holding the royalty. The box then no longer hashed to the token id, and any
  // listing or bid built from it could be created and never settled.
  //
  // One conversion, in one place. The client calls toFleetBox; this does not.
  let box: ExplorerBox | null = null;
  try {
    const fetched = (await api(`/boxes/${tokenId}`)) as ExplorerBox;
    if (fetched?.boxId === tokenId) box = fetched;
  } catch {
    box = null;
  }
  if (!box) {
    return NextResponse.json(
      { error: 'issuer box unavailable' },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  // Returned whole. The client hands it to the transaction builder, which puts
  // it in R6 — so anything dropped here would produce a box that no longer
  // hashes to the token id and a listing nobody can buy.
  return NextResponse.json({ box });
}
