// PixelButton — fixed-geometry button with 9-slice chrome.
//
// The rule carried over from the game HUD: geometry NEVER changes with state.
// Hover, press and disabled only re-tint (CSS filter) — no scale, no translate,
// no border swap — so the hitbox never moves under the cursor. `active` renders
// the sunken sprite instead of the raised one; same box, different pixels.
//
// It matters more here than it did in the game. A control that shifts on hover
// is a mis-click, and in this app a mis-click signs a transaction.

import React from 'react';
import { nineSlice } from './nineSlice';

export default function PixelButton({
  active = false,
  size = 'md',
  className = '',
  style,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  size?: 'sm' | 'md';
}) {
  const pad = size === 'sm' ? 'px-2' : 'px-3';
  const minH = size === 'sm' ? 'min-h-[28px]' : 'min-h-[32px]';
  return (
    <button
      className={
        `${pad} ${minH} inline-flex items-center justify-center gap-1 select-none ` +
        'font-pixel text-lg leading-none ' +
        (active ? 'text-yellow-300 ' : 'text-gray-200 ') +
        'enabled:hover:brightness-125 enabled:active:brightness-75 ' +
        'disabled:grayscale disabled:opacity-50 disabled:cursor-not-allowed ' +
        className
      }
      style={{ ...nineSlice(active ? 'inset' : 'button'), ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
