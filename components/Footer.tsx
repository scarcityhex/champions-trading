// Footer — what this venue is, stated where a visitor can actually read it.
//
// Until now the only mention of any of this lived in <meta description>, which
// nobody sees. Three separate claims are made here, and they are deliberately
// not equal in strength: one is verifiable by anyone, one is true of the code
// but not of the pictures, and one is about other people's decisions. Each is
// worded to be exactly as strong as it is true — an overstated claim on the
// third would be contradicted by the very people it names.

import Link from 'next/link';
import PixelPanel from './ui/PixelPanel';
import { EXPLORER_UI, SALE_ADDRESS, OFFER_ADDRESS, COLLECTION_OFFER_ADDRESS } from '@/lib/contract';

const REPO = 'https://github.com/scarcityhex/champions-trading';

const CONTRACTS = [
  { name: 'Sale', address: SALE_ADDRESS },
  { name: 'Offer', address: OFFER_ADDRESS },
  { name: 'Collection offer', address: COLLECTION_OFFER_ADDRESS },
];

export default function Footer() {
  return (
    <footer className="mx-auto mt-12 max-w-6xl px-4 pb-8 md:px-8">
      <PixelPanel variant="inset" className="p-5">
        <div className="grid gap-6 md:grid-cols-3">
          <section>
            <h2 className="font-pixel-display text-[10px] text-amber-300">NON-CUSTODIAL</h2>
            <p className="mt-2 font-pixel text-lg leading-snug text-gray-400">
              Your keys never leave your wallet. This site builds a transaction and Nautilus signs
              it — no seed, key or signature reaches this page or any server. While a piece is
              listed or a bid is open, the funds sit in the contracts below, which only you can
              reclaim. We are never able to move them.
            </p>
          </section>

          <section>
            <h2 className="font-pixel-display text-[10px] text-amber-300">OPEN SOURCE</h2>
            <p className="mt-2 font-pixel text-lg leading-snug text-gray-400">
              Every line that runs here is public: the app under AGPL-3.0, the contracts under
              Apache-2.0. You can read the escrow rules before trusting them with anything, and run
              the whole venue yourself.
            </p>
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block font-pixel text-lg text-amber-300 hover:underline"
            >
              github.com/scarcityhex/champions-trading ↗
            </a>
          </section>

          <section>
            <h2 className="font-pixel-display text-[10px] text-amber-300">ARTWORK</h2>
            <p className="mt-2 font-pixel text-lg leading-snug text-gray-400">
              Shown with the permission of the collection owners. The artwork stays theirs — it is
              not covered by the licences above and is not published with the source. This is an
              independent venue for these three collections, not an official one.
            </p>
          </section>
        </div>

        {/* The contracts are the part that holds value, so their addresses belong
            in reach rather than in a document. Anyone can confirm that what the
            site says it locked is what is actually locked. */}
        <div className="mt-6 border-t border-black/40 pt-4">
          <p className="font-pixel text-base text-gray-500">
            Escrow contracts —{' '}
            {CONTRACTS.map((c, i) => (
              <span key={c.address}>
                {i > 0 && <span className="text-gray-700"> · </span>}
                <a
                  href={`${EXPLORER_UI}/addresses/${c.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-400 hover:text-amber-300"
                >
                  {c.name}
                </a>
              </span>
            ))}
          </p>
          <p className="mt-2 font-pixel text-base leading-snug text-gray-500">
            The contracts have not been independently audited. They are short and readable on
            purpose — if you are trading something you would mind losing, read them first.{' '}
            <Link href="/activity" className="text-gray-400 hover:text-amber-300">
              Every trade ever settled here is on Activity.
            </Link>
          </p>
        </div>
      </PixelPanel>
    </footer>
  );
}
