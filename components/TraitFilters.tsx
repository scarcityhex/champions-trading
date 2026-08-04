'use client';

// TraitFilters — one dropdown per trait, multi-select inside each.
//
// Semantics match what collectors expect from a marketplace, and the two halves
// are deliberately different:
//   - within a trait, values are OR   ("red or blue background")
//   - across traits, they are AND     ("blue background AND emerald helmet")
// Anything else makes the result count move in directions people cannot predict.
//
// Counts come from the surviving supply, not the original mint. On Ergo
// Champions that is 493 rather than 1,498, and a rarity figure quoted against
// a mint that no longer exists is simply wrong.

import { useEffect, useRef, useState } from 'react';
import PixelPanel from './ui/PixelPanel';
import PixelButton from './ui/PixelButton';
import { traitCounts, type Collection } from '@/lib/collections';

export type TraitSelection = Record<string, string[]>;

/** Does a token satisfy every active trait filter? */
export function matchesTraits(
  attributes: Array<{ trait_type: string; value: string }> | undefined,
  selection: TraitSelection,
): boolean {
  const entries = Object.entries(selection).filter(([, v]) => v.length > 0);
  if (entries.length === 0) return true;

  for (const [trait, wanted] of entries) {
    const held = attributes?.find((a) => a.trait_type === trait)?.value;
    if (!held || !wanted.includes(held)) return false;
  }
  return true;
}

export const activeCount = (s: TraitSelection): number =>
  Object.values(s).reduce((n, v) => n + v.length, 0);

export default function TraitFilters({
  collection,
  selection,
  onChange,
}: {
  collection: Collection;
  selection: TraitSelection;
  onChange: (next: TraitSelection) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const counts = traitCounts(collection);
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape closes, matching the rest of the project's panels. Click-outside is
  // handled on the same listener pair so the two can never disagree about
  // whether a menu is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // A trait every surviving token shares cannot narrow anything — Ergo
  // Champions is all "skeleton", Mage Champions all "base". Offering them as
  // filters is a control that does nothing.
  const traits = [...counts.entries()]
    .filter(([, values]) => values.size > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const toggle = (trait: string, value: string) => {
    const current = selection[trait] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...selection, [trait]: next });
  };

  const total = activeCount(selection);

  return (
    <div ref={rootRef} className="mb-4 flex flex-wrap items-start gap-2">
      {traits.map(([trait, values]) => {
        const picked = selection[trait] ?? [];
        // Rarest first: the ordering a collector is actually scanning for. The
        // count beside each value makes the sort self-explanatory.
        const sorted = [...values.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

        return (
          <div key={trait} className="relative">
            <PixelButton
              size="sm"
              active={picked.length > 0}
              onClick={() => setOpen(open === trait ? null : trait)}
            >
              {trait}
              {picked.length > 0 && ` (${picked.length})`}
              <span className="ml-1 text-gray-500">{open === trait ? '▴' : '▾'}</span>
            </PixelButton>

            {open === trait && (
              <PixelPanel
                className="absolute left-0 top-full z-40 mt-1 max-h-72 w-60 overflow-y-auto p-2"
              >
                {picked.length > 0 && (
                  <PixelButton
                    size="sm"
                    className="mb-1 w-full"
                    onClick={() => onChange({ ...selection, [trait]: [] })}
                  >
                    Clear {trait}
                  </PixelButton>
                )}
                <ul>
                  {sorted.map(([value, n]) => {
                    const on = picked.includes(value);
                    return (
                      <li key={value}>
                        <button
                          onClick={() => toggle(trait, value)}
                          className={
                            'flex w-full items-center justify-between gap-2 px-1 py-0.5 text-left ' +
                            'font-pixel text-lg hover:brightness-125 ' +
                            (on ? 'text-yellow-300' : 'text-gray-300')
                          }
                        >
                          <span className="truncate" title={value}>
                            {on ? '☑' : '☐'} {value}
                          </span>
                          <span className="shrink-0 font-pixel text-base text-gray-500">{n}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </PixelPanel>
            )}
          </div>
        );
      })}

      {total > 0 && (
        <PixelButton size="sm" onClick={() => onChange({})}>
          Clear all ({total})
        </PixelButton>
      )}
    </div>
  );
}
