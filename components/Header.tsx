'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PixelButton from './ui/PixelButton';
import PixelPanel from './ui/PixelPanel';
import { shortAddress, isWrongNetwork } from '@/lib/nautilus';
import { EXPLORER_UI, NETWORK } from '@/lib/contract';
import { useEffect, useState } from 'react';
import { useMarketContext } from './MarketProvider';

export default function Header() {
  const { wallet, data, actions, requestView } = useMarketContext();
  const router = useRouter();

  return (
    <>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link href="/" className="font-pixel-display text-base text-amber-300 md:text-lg">
            CHAMPIONS TRADING
          </Link>
          <Link href="/activity" className="font-pixel text-xl text-gray-400 hover:text-amber-300">
            Activity
          </Link>

          {/* Explicit, because the alternative reads as the site being wrong.
              The order book refreshes after your own transactions and when the
              tab regains focus, but a listing someone else made while you sat
              on the page will not appear until something asks. */}
          <button
            onClick={data.refresh}
            disabled={data.loading}
            title={
              data.fetchedAt
                ? `Order book read ${new Date(data.fetchedAt).toLocaleTimeString()} — click to re-read`
                : 'Re-read the order book'
            }
            aria-label="Refresh the order book"
            className="font-pixel text-xl text-gray-500 hover:text-amber-300 disabled:text-gray-700"
          >
            {data.loading ? '…' : '↻'}
          </button>
        </div>

        {wallet.address ? (
          <div className="flex items-center gap-2">
            {/* The address is the natural handle for "show me my things", and
                a user who clicks it expects their wallet, not a profile page.
                Routes to the gallery first so it also works from a token page. */}
            <button
              onClick={() => {
                requestView('wallet');
                router.push('/');
              }}
              title={`${wallet.address} — click to see everything in this wallet`}
              className="font-pixel text-xl text-amber-300 underline decoration-dotted underline-offset-4 hover:brightness-125"
            >
              {shortAddress(wallet.address)}
            </button>
            <PixelButton size="sm" onClick={wallet.disconnect}>Disconnect</PixelButton>
          </div>
        ) : (
          <PixelButton onClick={wallet.connect} disabled={wallet.connecting}>
            {/* The mark stays put while connecting. PixelButton's rule is that
                geometry never changes with state, and dropping the icon for the
                busy label would shift the button under the cursor mid-click. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/ui/nautilus.png"
              alt=""
              aria-hidden="true"
              width={18}
              height={18}
              className="h-[18px] w-[18px] shrink-0"
            />
            {wallet.connecting ? 'Connecting…' : 'Connect Nautilus'}
          </PixelButton>
        )}
      </header>

      {/* A testnet build must announce itself: the UI is otherwise identical,
          and someone could believe a practice trade was real, or the reverse. */}
      {NETWORK === 'testnet' && (
        <Notice tone="warn" text="TESTNET — coins and NFTs here are worthless test assets." />
      )}

      {isWrongNetwork(wallet) && (
        <Notice
          tone="error"
          text={`Wallet is on ${wallet.walletNetwork}; this site talks to ${NETWORK}. Trading is disabled until they match.`}
        />
      )}

      {wallet.error && <Notice tone="error" text={wallet.error} />}
      {actions.error && <Notice tone="error" text={actions.error} onClose={actions.clear} />}
      {actions.lastTxId && (
        <Notice
          tone="ok"
          // A transaction id is the only receipt that exists; nothing here
          // records the trade, so linking out to the explorer is the receipt.
          //
          // The average is stated because two minutes is a mean, not a
          // deadline: block intervals are a Poisson process and eight minutes
          // is unremarkable. Someone told only "a couple of minutes" concludes
          // something is broken at minute three.
          text="Submitted. Ergo blocks are mined about every 2 minutes on average, so it may take a few — sometimes longer."
          elapsedSince={actions.lastTxAt}
          link={{
            href: `${EXPLORER_UI}/transactions/${actions.lastTxId}`,
            label: 'View on explorer',
          }}
          onClose={actions.clear}
        />
      )}
    </>
  );
}

/**
 * Seconds since a transaction was submitted, ticking.
 *
 * A number that visibly moves is the difference between "the site is working
 * and I am waiting" and "the site is stuck". Nothing here can tell which of
 * those is true — the explorer has no working mempool endpoint — so the honest
 * thing to show is how long it has been, not a prediction.
 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const label =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;

  return (
    <span
      // Amber past four minutes: still normal, but long enough that a user
      // deserves a nudge to check the explorer rather than keep waiting.
      className={`ml-2 shrink-0 font-pixel text-xl ${
        seconds > 240 ? 'text-amber-300' : 'text-gray-500'
      }`}
      title="Time since the transaction was submitted"
    >
      {label}
    </span>
  );
}

function Notice({
  tone,
  text,
  link,
  elapsedSince,
  onClose,
}: {
  tone: 'error' | 'ok' | 'warn';
  text: string;
  link?: { href: string; label: string };
  /** When set, a live counter renders beside the message. */
  elapsedSince?: number | null;
  onClose?: () => void;
}) {
  return (
    <PixelPanel variant="inset" className="mb-4 flex items-center justify-between gap-3 p-3">
      <p
        className={
          'font-pixel text-xl ' +
          (tone === 'error' ? 'text-red-400' : tone === 'warn' ? 'text-amber-300' : 'text-emerald-400')
        }
      >
        {text}{' '}
        {link && (
          <a href={link.href} target="_blank" rel="noreferrer" className="underline">
            {link.label}
          </a>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {typeof elapsedSince === 'number' && <Elapsed since={elapsedSince} />}
        {onClose && <PixelButton size="sm" onClick={onClose}>✕</PixelButton>}
      </div>
    </PixelPanel>
  );
}
