// GET /api/holder/:tokenId — who holds this NFT right now.
//
// One explorer call, and the reason the detail page can show provenance without
// storing anything. The answer is the box currently holding the token: for a
// listed piece that is the sale contract, which is how the page can say
// "escrowed" without being told.

import { NextResponse } from 'next/server';
import { holderOf } from '@/lib/explorer';
import { SALE_ADDRESS } from '@/lib/contract';

export const revalidate = 30;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId } = await params;

  // The path segment reaches the explorer URL, so it is validated rather than
  // trusted. A token id is 32 bytes of hex and nothing else.
  if (!/^[0-9a-f]{64}$/.test(tokenId)) {
    return NextResponse.json({ error: 'not a token id' }, { status: 400 });
  }

  try {
    const address = await holderOf(tokenId);
    return NextResponse.json({ address, listed: address === SALE_ADDRESS });
  } catch (e) {
    return NextResponse.json(
      { address: null, error: e instanceof Error ? e.message : 'explorer unavailable' },
      { status: 200 },
    );
  }
}
