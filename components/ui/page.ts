// The one page container width.
//
// Header and Footer render on every route, so a per-page difference here moves
// them sideways the moment someone navigates — which is exactly what happened:
// the gallery was max-w-6xl and Activity max-w-5xl, 128px apart, and clicking
// between them made the whole layout jump.
//
// Kept in one place so a new page cannot reintroduce the drift by picking its
// own number. Content that wants to be narrower constrains itself INSIDE this,
// rather than shrinking the container the header sits in.
export const PAGE_WIDTH = 'mx-auto max-w-6xl';
