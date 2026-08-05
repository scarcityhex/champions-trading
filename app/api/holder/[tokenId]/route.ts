// GET /api/holder/:tokenId — who holds this NFT right now.
//
// One explorer call, and the reason the detail page can show provenance without
// storing anything. The answer is the box currently holding the token: for a
// listed piece that is the sale contract, which is how the page can say
// "escrowed" without being told.

import { NextResponse } from 'next/server';
import { holderOf } from '@/lib/explorer';
import { SALE_ADDRESS } from '@/lib/contract';
import { BY_TOKEN_ID } from '@/lib/collections';
import { checkRateLimit } from '@/lib/rateLimit';

export const revalidate = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const rate = checkRateLimit(request, 'holder', 60, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'too many holder lookups' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rate.retryAfter),
          'Cache-Control': 'private, no-store',
        },
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

  try {
    const address = await holderOf(tokenId);
    return NextResponse.json({ address, listed: address === SALE_ADDRESS });
  } catch (e) {
    console.error('holder explorer read failed', e);
    return NextResponse.json(
      { address: null, error: 'explorer unavailable' },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
