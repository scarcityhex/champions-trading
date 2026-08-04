// PixelPanel — 9-slice chrome for surfaces. `panel` is a raised surface,
// `inset` a sunken well for lists and readouts.

import React from 'react';
import { nineSlice, type Variant } from './nineSlice';

export default function PixelPanel({
  variant = 'panel',
  className = '',
  style,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { variant?: Extract<Variant, 'panel' | 'inset'> }) {
  return (
    <div className={className} style={{ ...nineSlice(variant), ...style }} {...rest}>
      {children}
    </div>
  );
}
