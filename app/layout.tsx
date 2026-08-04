import type { Metadata } from 'next';
import { VT323, Press_Start_2P } from 'next/font/google';
import './globals.css';
import { MarketProvider } from '@/components/MarketProvider';

const vt323 = VT323({ weight: '400', subsets: ['latin'], variable: '--font-vt323' });
const pressStart = Press_Start_2P({ weight: '400', subsets: ['latin'], variable: '--font-press-start' });

export const metadata: Metadata = {
  title: 'Champions Trading',
  description: 'Non-custodial marketplace for Ergo Champions, Ergo Mummy and Mage Champions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${vt323.variable} ${pressStart.variable}`}>
      {/* Browser extensions inject attributes into <body> before React mounts —
          ColorZilla's `cz-shortcut-listen`, password managers, and others. React
          then reports a hydration mismatch for markup neither we nor the server
          produced. Suppressed on this element only: it must never be used to
          hide a mismatch in our own rendering. */}
      <body className="font-pixel" suppressHydrationWarning>
        <MarketProvider>{children}</MarketProvider>
      </body>
    </html>
  );
}
