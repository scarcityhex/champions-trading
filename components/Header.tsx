'use client';

import Link from 'next/link';
import PixelButton from './ui/PixelButton';
import PixelPanel from './ui/PixelPanel';
import { shortAddress, isWrongNetwork } from '@/lib/nautilus';
import { EXPLORER_UI, NETWORK } from '@/lib/contract';
import { useMarketContext } from './MarketProvider';

export default function Header() {
  const { wallet, data, actions } = useMarketContext();

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
            <span className="font-pixel text-xl text-amber-300" title={wallet.address}>
              {shortAddress(wallet.address)}
            </span>
            <PixelButton size="sm" onClick={wallet.disconnect}>Disconnect</PixelButton>
          </div>
        ) : (
          <PixelButton onClick={wallet.connect} disabled={wallet.connecting}>
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
          text={`Submitted. It takes a couple of minutes to confirm.`}
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

function Notice({
  tone,
  text,
  link,
  onClose,
}: {
  tone: 'error' | 'ok' | 'warn';
  text: string;
  link?: { href: string; label: string };
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
      {onClose && <PixelButton size="sm" onClick={onClose}>✕</PixelButton>}
    </PixelPanel>
  );
}
