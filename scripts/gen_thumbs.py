#!/usr/bin/env python3
"""Builds the served image tiers in public/.

    python3 scripts/gen_thumbs.py                 # both tiers, all collections
    python3 scripts/gen_thumbs.py --tier detail   # just the detail tier
    python3 scripts/gen_thumbs.py ErgoMummy       # one collection
    python3 scripts/gen_thumbs.py --src /path/to/Erg

The originals are 1000x1000 and 2048x2048 PNG/JPEG, and Mage Champions alone is
1.5 GB. A grid of them is minutes of transfer to show tiles two hundred pixels
wide. These derivatives are what the cards actually load; the original is only
reached on the detail view, or as a fallback when a thumbnail is missing.

WebP because it holds flat pixel-art colour far better than JPEG at this size —
JPEG puts ringing around the hard edges these collections are made of.

Resumable: an existing thumbnail is skipped, so a re-run after an interruption
costs only what is missing.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# Two tiers, because the two views want different things. A gallery renders 24
# tiles at ~200px; a detail view is where someone decides to spend money and
# should not wait on an IPFS gateway for a 1.5 MB original.
TIERS = {
    "thumbs": {"size": 320, "quality": 78},
    "detail": {"size": 768, "quality": 82},
}

# Where the full-size downloads live. They are not in this repo — they are ~2 GB
# and not ours to redistribute (docs/architecture.md §4).
DEFAULT_SRC = ROOT.parent / "bcw-islands-1D" / "client" / "public" / "Erg"

COLLECTIONS = ("ErgoChampions", "ErgoMummy", "MageChampions")

# Art directory -> catalogue file, so burned tokens can be resolved to filenames.
CATALOGUES = {
    "ErgoChampions": "ERGOCHAMPIONSmetadata.json",
    "ErgoMummy": "ERGOMUMMYmetadata.json",
    "MageChampions": "MAGECHAMPIONSmetadata.json",
}


def burned_stems(collection: str) -> set[str]:
    """Filename stems of tokens that no longer exist.

    A burned token is never rendered anywhere — the gallery filters it out and
    its page shows an explanation rather than the artwork — so its images are
    pure weight in the repository. Ergo Champions alone burned 1,005 of 1,498.

    Stems must follow the same rule as lib/collections.ts: repeated editions
    share an `id`, so the second and later ones carry a `-N` suffix. Getting
    this wrong would delete a surviving twin's picture.
    """
    supply = json.loads((ROOT / "data" / "supply.json").read_text())
    burned = set(supply.get("burned", {}))
    if not burned:
        return set()

    doc = json.loads((ROOT / "data" / CATALOGUES[collection]).read_text())
    seen: Counter[str] = Counter()
    stems = set()
    for token in doc["tokens"]:
        seen[token["id"]] += 1
        n = seen[token["id"]]
        stem = token["id"] if n == 1 else f"{token['id']}-{n}"
        if token["metadata"]["tokenId"] in burned:
            stems.add(stem)
    return stems


def build(
    src_dir: Path, out_dir: Path, size: int, quality: int, skip: set[str]
) -> tuple[int, int, int, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    made = skipped = failed = burned = 0

    for src in sorted(src_dir.iterdir()):
        if not src.is_file():
            continue
        if src.stem in skip:
            burned += 1
            continue
        dest = out_dir / f"{src.stem}.webp"
        if dest.exists() and dest.stat().st_size > 0:
            skipped += 1
            continue
        try:
            with Image.open(src) as im:
                # Flatten onto black: these are RGBA, and WebP would otherwise
                # carry an alpha channel the cards never use.
                if im.mode in ("RGBA", "LA", "P"):
                    im = im.convert("RGBA")
                    flat = Image.new("RGB", im.size, (0, 0, 0))
                    flat.paste(im, mask=im.split()[-1])
                    im = flat
                else:
                    im = im.convert("RGB")
                im.thumbnail((size, size), Image.Resampling.LANCZOS)
                im.save(dest, "WEBP", quality=quality, method=6)
            made += 1
        except Exception as exc:  # a corrupt download must not stop the batch
            print(f"  ! {src.name}: {exc}", file=sys.stderr)
            failed += 1

    return made, skipped, failed, burned


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("collections", nargs="*", default=None)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--tier", choices=[*TIERS, "all"], default="all")
    ap.add_argument(
        "--prune",
        action="store_true",
        help="also delete already-generated images of burned tokens",
    )
    args = ap.parse_args()

    picked = [c for c in (args.collections or COLLECTIONS) if c in COLLECTIONS]
    if not picked:
        sys.exit(f"nothing to do; known collections: {', '.join(COLLECTIONS)}")

    if not args.src.is_dir():
        sys.exit(f"source not found: {args.src}\nPass --src with the folder holding the full-size art.")

    tiers = list(TIERS) if args.tier == "all" else [args.tier]

    for tier in tiers:
        cfg = TIERS[tier]
        out_root = ROOT / "public" / tier
        total_bytes = 0
        print(f"\n### {tier} ({cfg['size']}px)")
        for name in picked:
            skip = burned_stems(name)
            out_dir = out_root / name

            removed = 0
            if args.prune and out_dir.is_dir():
                for f in out_dir.iterdir():
                    if f.is_file() and f.stem in skip:
                        f.unlink()
                        removed += 1

            src_dir = args.src / name
            if not src_dir.is_dir():
                if removed:
                    print(f"  {name}: pruned {removed} (no source folder to build from)")
                else:
                    print(f"  {name}: no source folder, skipped")
                continue

            made, skipped, failed, burned_n = build(
                src_dir, out_dir, cfg["size"], cfg["quality"], skip
            )
            size = sum(f.stat().st_size for f in out_dir.iterdir() if f.is_file())
            total_bytes += size
            pruned = f" · {removed} pruned" if removed else ""
            print(
                f"  {name}: {made} made · {skipped} skipped · {burned_n} burned"
                f"{pruned} · {failed} failed · {size / 1e6:.1f} MB"
            )
        print(f"  -> {total_bytes / 1e6:.1f} MB in {out_root}")


if __name__ == "__main__":
    main()
