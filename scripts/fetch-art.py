#!/usr/bin/env python3
"""Downloads the full-size originals that are missing from the art folder.

    python3 scripts/fetch-art.py                    # every collection
    python3 scripts/fetch-art.py MageChampions      # one
    python3 scripts/fetch-art.py --dest /path/to/Erg
    python3 scripts/fetch-art.py --dry-run          # list what is missing

Only ALIVE tokens are fetched. A burned token's picture is never rendered
anywhere, so downloading one would put back exactly what gen_thumbs.py and the
prune pass exist to remove.

EVERY FILE IS VERIFIED BEFORE IT IS KEPT

The catalogue carries `contentHash` for each token, which is the SHA-256 in the
issuance box's R8 — a commitment made on chain at mint time. A download that
does not hash to it is discarded rather than written.

That check is not ceremony. These come from public IPFS gateways: any of them
can be slow, wrong, or serve an error page with a 200 status, and a truncated
PNG looks like a file until someone opens it. Verifying against the chain's own
commitment is the difference between "we have 1447 images" and "we have 1447
files". Nothing else in this project could tell the two apart.

Resumable: a token whose file already exists is skipped, so an interrupted run
costs only what is missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DEST = ROOT.parent / "bcw-islands-1D" / "client" / "public" / "Erg"

COLLECTIONS = ("ErgoChampions", "ErgoMummy", "MageChampions")
CATALOGUES = {
    "ErgoChampions": "ERGOCHAMPIONSmetadata.json",
    "ErgoMummy": "ERGOMUMMYmetadata.json",
    "MageChampions": "MAGECHAMPIONSmetadata.json",
}

# One gateway, deliberately.
#
# The first version listed four and fell through them in order, on the theory
# that a spare is free. Measured, three of the four were worse than useless:
# cloudflare-ipfs.com is discontinued and fails instantly, dweb.link, w3s.link
# and 4everland.io answer 301 to a subdomain URL that then hangs, and
# gateway.pinata.cloud accepts the connection and never replies. So every file
# ipfs.io declined cost 45 seconds of waiting on corpses before failing anyway,
# and with eight workers the whole run stalled.
#
# ipfs.io answers in under a second. It rate-limits under load, which is a
# reason to ask more slowly — not a reason to ask someone else.
GATEWAYS = ("https://ipfs.io/ipfs/",)

TIMEOUT = 30
# Low on purpose. Eight parallel requests is what provokes the rate limiting
# that made the fallbacks look necessary in the first place.
WORKERS = 3
# Per file, against the same gateway: 429 is a request to wait, so waiting is
# the correct response to it.
ATTEMPTS = 4
BACKOFF = 4  # seconds, doubling


def missing(collection: str, dest: Path) -> list[tuple[str, dict]]:
    """(stem, metadata) for every alive token with no file on disk."""
    supply = json.loads((ROOT / "data" / "supply.json").read_text())
    burned = set(supply.get("burned", {}))
    doc = json.loads((ROOT / "data" / CATALOGUES[collection]).read_text())

    folder = dest / collection
    on_disk = {f.stem for f in folder.iterdir() if f.is_file()} if folder.is_dir() else set()

    seen: Counter[str] = Counter()
    out = []
    for token in doc["tokens"]:
        seen[token["id"]] += 1
        n = seen[token["id"]]
        # Same rule as lib/collections.ts and gen_thumbs.py: repeated editions
        # share an id, so later ones carry a -N suffix.
        stem = token["id"] if n == 1 else f"{token['id']}-{n}"
        meta = token["metadata"]
        if meta["tokenId"] in burned or stem in on_disk:
            continue
        out.append((stem, meta))
    return out


def extension_of(url: str) -> str:
    tail = url.split("?")[0].rsplit(".", 1)
    return tail[1].lower() if len(tail) == 2 and 3 <= len(tail[1]) <= 4 else "png"


def fetch(stem: str, meta: dict, folder: Path) -> tuple[str, str]:
    """Returns (stem, 'ok') or (stem, reason it was not kept)."""
    url = meta.get("imageUrl") or ""
    if not url.startswith("ipfs://"):
        return stem, "no ipfs url"
    cid = url[len("ipfs://") :]
    want = (meta.get("contentHash") or "").lower()
    base = GATEWAYS[0]

    last = "not attempted"
    for attempt in range(ATTEMPTS):
        if attempt:
            # The gateway declined; asking again immediately is what got us
            # declined. Doubling from 4s: 4, 8, 16.
            time.sleep(BACKOFF * (2 ** (attempt - 1)))
        try:
            req = Request(base + cid, headers={"User-Agent": "champions-trading/art"})
            with urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read()
        except Exception as exc:
            # Deliberately broad. The first version listed the exception types
            # that seemed plausible, and a truncated response — IncompleteRead,
            # an HTTPException and not an OSError — escaped the list and killed
            # a batch of 125 at file 40. No failure here is worth aborting a
            # run over, and guessing the taxonomy in advance is what went wrong.
            last = f"{type(exc).__name__}: {exc}"
            continue

        if not body:
            last = "empty response"
            continue

        # The whole point of the exercise. A gateway that returns an error page
        # with a 200, or truncates, fails here rather than on someone's screen.
        if want and hashlib.sha256(body).hexdigest() != want:
            last = "hash mismatch"
            continue

        dest = folder / f"{stem}.{extension_of(url)}"
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(body)
        tmp.rename(tmp.with_suffix(""))  # atomic: no half-written file is ever seen
        return stem, "ok"

    return stem, last


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("collections", nargs="*", default=None)
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    picked = [c for c in (args.collections or COLLECTIONS) if c in COLLECTIONS]
    if not picked:
        sys.exit(f"nothing to do; known collections: {', '.join(COLLECTIONS)}")
    if not args.dest.is_dir():
        sys.exit(f"destination not found: {args.dest}")

    total_ok = total_bad = 0
    for name in picked:
        todo = missing(name, args.dest)
        print(f"\n### {name}: {len(todo)} missing")
        if not todo:
            continue
        if args.dry_run:
            for stem, _ in todo[:20]:
                print(f"  {stem}")
            if len(todo) > 20:
                print(f"  … and {len(todo) - 20} more")
            continue

        folder = args.dest / name
        folder.mkdir(parents=True, exist_ok=True)
        done = ok = 0
        started = time.time()
        failures: list[tuple[str, str]] = []

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            # Wrapped so a worker cannot raise: pool.map surfaces the first
            # exception and abandons the rest of the batch, which is how one
            # bad response cost 85 good downloads on the previous run.
            def safe(arg: tuple[str, dict]) -> tuple[str, str]:
                try:
                    return fetch(*arg, folder)
                except Exception as exc:  # noqa: BLE001 - see above
                    return arg[0], f"{type(exc).__name__}: {exc}"

            for stem, outcome in pool.map(safe, todo):
                done += 1
                if outcome == "ok":
                    ok += 1
                else:
                    failures.append((stem, outcome))
                if done % 10 == 0 or done == len(todo):
                    rate = done / max(time.time() - started, 1e-9)
                    print(f"  {done}/{len(todo)}  ok={ok}  ({rate:.1f}/s)", end="\r")

        print()
        total_ok += ok
        total_bad += len(failures)
        for stem, why in failures[:15]:
            print(f"  ! {stem}: {why}")
        if len(failures) > 15:
            print(f"  ! … and {len(failures) - 15} more")

    if not args.dry_run:
        print(f"\n{total_ok} downloaded, {total_bad} failed")
        if total_bad:
            # Left for a re-run rather than retried forever: a gateway that is
            # down now is often up in ten minutes, and the run is resumable.
            print("Re-run to retry the failures; existing files are skipped.")
        else:
            print("Now rebuild the tiers: python3 scripts/gen_thumbs.py")


if __name__ == "__main__":
    main()
