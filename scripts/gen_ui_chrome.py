#!/usr/bin/env python3
"""Generates the three 9-slice chrome sprites in public/ui.

    python3 scripts/gen_ui_chrome.py

The game HUD's chrome is a desaturated purple. This project borrows the shapes
but not the palette — dark brown with an antique-gold bevel: it is a different
site with different stakes, and looking identical to the game would imply they
are one system. The geometry is kept byte-for-byte compatible so the CSS
border-image slices in components/ui do not change.

Palette lives here as data rather than in a PNG, so re-tinting the whole site is
an edit to one dict and a re-run.

Each sprite is an outline ring, a 1px bevel ring, and a face:

    raised (panel, button)        sunken (inset)
    #############                 #############
    #HHHHHHHHHHm#   H = light     #mmmmmmmmmmh#   m = shadow on top-left
    #Hfffffffffm#   m = shadow    #mFFFFFFFFFh#   h = light on bottom-right
    #mmmmmmmmmmm#                 #hhhhhhhhhhh#

Corners of the raised sprites are transparent, which reads as a rounded corner
at 2x without spending a pixel on antialiasing. The inset keeps square corners
so wells butt flush against each other in a list.
"""

from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "ui"

# Dark brown with an antique-gold bevel. Roles mirror the game's palette one for
# one, so the luminance ramp that makes the 9-slice read at 2x is preserved: the
# highlight is far lighter than the face, the shadow only slightly darker. The
# gold is deliberately muted — a bright one at this size vibrates against the
# dark face instead of reading as a lit edge.
OUTLINE = (13, 9, 5, 255)        # darkest; the 1px border
HL_RAISED = (166, 128, 66, 255)  # top-left of a raised surface
SHADOW = (46, 32, 16, 255)       # bottom-right of raised, top-left of sunken
HL_SUNKEN = (66, 47, 23, 255)    # bottom-right of sunken
FACE_PANEL = (31, 22, 12, 252)   # near-opaque: panels sit over the page
FACE_BUTTON = (79, 56, 27, 255)
FACE_INSET = (19, 13, 7, 252)

SPRITES = {
    # name:        (size, face,        raised, round_corners)
    "ui_panel9":   (24,   FACE_PANEL,  True,   True),
    "ui_btn9":     (12,   FACE_BUTTON, True,   True),
    "ui_inset9":   (12,   FACE_INSET,  False,  False),
}


def build(size: int, face, raised: bool, round_corners: bool) -> Image.Image:
    im = Image.new("RGBA", (size, size), face)
    px = im.load()
    last = size - 1

    top_left = HL_RAISED if raised else SHADOW
    bottom_right = SHADOW if raised else HL_SUNKEN

    for i in range(size):
        # Outline ring.
        px[i, 0] = px[i, last] = px[0, i] = px[last, i] = OUTLINE

    # Bevel ring, one pixel inside the outline. The two passes must stay
    # separate and in this order: where a light edge meets a dark one — the
    # top-right and bottom-left corners — the dark edge has to win, or the bevel
    # reads as a notch instead of a lip. Interleaving the writes in a single
    # loop lets the light edge overwrite those corners on a later iteration.
    for i in range(1, last):
        px[i, 1] = top_left
        px[1, i] = top_left
    for i in range(1, last):
        px[i, last - 1] = bottom_right
        px[last - 1, i] = bottom_right

    if round_corners:
        for x, y in ((0, 0), (last, 0), (0, last), (last, last)):
            px[x, y] = (0, 0, 0, 0)

    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (size, face, raised, round_corners) in SPRITES.items():
        img = build(size, face, raised, round_corners)
        path = OUT / f"{name}.png"
        img.save(path, optimize=True)
        print(f"{name}.png  {size}x{size}  {path.stat().st_size} B")


if __name__ == "__main__":
    main()
