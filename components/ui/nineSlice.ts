// nineSlice — the game HUD's pixel chrome, as plain CSS.
//
// In the game these frames live inside the mega atlas and have to be cropped
// out at runtime into dataURLs, because CSS border-image cannot address a
// region of a spritesheet. Here they are standalone PNGs in /public/ui (429
// bytes for all three), so border-image can point straight at them and the
// whole async crop-and-cache layer disappears. Same pixels, no machinery.
//
// Slices render at 2x, integer, with pixelated smoothing — a fractional scale
// makes pixel art shimmer along the borders.

import type { CSSProperties } from 'react';

export type Variant = 'panel' | 'inset' | 'button';

const NINE: Record<Variant, { file: string; slice: number }> = {
  panel: { file: 'ui_panel9', slice: 8 },
  inset: { file: 'ui_inset9', slice: 4 },
  button: { file: 'ui_btn9', slice: 4 },
};

const SCALE = 2;

export function nineSlice(variant: Variant): CSSProperties {
  const { file, slice } = NINE[variant];
  const borderWidth = slice * SCALE;
  return {
    borderStyle: 'solid',
    borderWidth,
    borderImage: `url(/ui/${file}.png) ${slice} fill / ${borderWidth}px stretch`,
    imageRendering: 'pixelated',
  };
}
