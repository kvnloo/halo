#!/usr/bin/env python
"""
PIXELCHECK — mechanical scan for the two image defects this project keeps finding by eye.

Why this exists
---------------
KNOWN_ISSUES §24: `taa` writes **exact rgb(0,0,0)** over the ocean at `shot_sky_ring`.
In an AgX-tonemapped, grain-dithered frame, exact zero in all three channels is a NaN/Inf
reaching the framebuffer, not a lighting result. That defect was:

  * found by a human counting pixels in one preview sheet (Wave F: 7,978 px),
  * still there a wave later (Wave G: 7,934 px in the identical bounding box),
  * and in that wave it **leaked into two more poses** — `ref_00000` (17 px) and
    `shot_shoreline` (6 px) — which was noticed only because someone re-read the sheet
    by hand. Wave F had recorded zero in every non-`sky_ring` frame.

Nothing in the loop looks for it. `score.mjs` cannot: 8k pixels is 0.385% of a frame and
moves no aggregate statistic. So the spread was invisible to every instrument we own.

§24 also established that **film grain dithers about half the corrupt pixels off exact
zero** (grain_off nearly doubled the count, 7,977 -> 14,814). So a count taken on a normal
capture is a LOWER BOUND, by roughly 2x. It is still monotone, which is all a gate needs.

Native captures only
--------------------
The scan is restricted to images at the capture resolution (--res, default 1920x1080).
This is not cosmetic filtering, it is the domain of the metric: **exact zero does not
survive resampling.** Measured on the live `ref_00000` residue — 5 exact-black px at native
resolution becomes 0 px when the frame is downscaled to 0.75x or 0.5x. So a contact sheet
or montage can never produce a true positive, and reliably produces false ones: the label
strips on `shots/preview/00_sky_progress.png` (2880x586) are drawn at exact black and count
124,149 px, all of them in a y0-45 band spanning the full width. A gate whose loudest hit is
its own chrome gets ignored, and then it protects nothing.

Non-matching images are listed as `skipped (not a capture: WxH)` and never counted. Use
`--res any` to scan everything regardless, and `--res 2560x1440` if capture resolution moves.
If the filter leaves nothing to scan, that is reported as an error (exit 2), not a pass —
otherwise a changed capture resolution would silently turn the gate into a no-op.

Usage
-----
  tools/pixelcheck.py shots/preview                 # scan a directory of PNGs
  tools/pixelcheck.py shots/latest/*.png            # or explicit files
  tools/pixelcheck.py shots/preview --max-black 8   # tolerate a known residue
  tools/pixelcheck.py shots/preview --res any       # include sheets/montages too
  tools/pixelcheck.py --diff base.png a.png b.png   # ablation diff table (see ablate.mjs)

Exit code is 1 when a scanned frame exceeds --max-black (default 0) or --max-white (default
disabled), 2 when nothing was scannable, so it can be dropped into a wave's checklist.

`tools/pixelcheck.py shots/preview` exits 1 today. That is a REAL defect, not noise: 5
exact-black px in `ref_00000.png` at `y635-639 x882-895`, the same band Wave G recorded.

This tool only READS images. It changes no measurement and no score.
"""
import argparse
import glob
import os
import sys

import cv2
import numpy as np


def load(path):
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    if im is None:
        raise SystemExit(f"pixelcheck: cannot read {path}")
    return im


def bbox(mask):
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return None
    return (int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max()))


def parse_res(s):
    """'1920x1080' -> (1920, 1080); 'any'/'' -> None (no filtering)."""
    if s is None or s.strip().lower() in ("any", "all", "none", ""):
        return None
    try:
        w, h = s.lower().split("x")
        return (int(w), int(h))
    except ValueError:
        raise SystemExit(f"pixelcheck: --res wants WxH or 'any', got {s!r}")


def scan_one(path):
    im = load(path)
    h, w = im.shape[:2]
    n = h * w
    black = np.all(im == 0, axis=2)
    white = np.all(im == 255, axis=2)
    return {
        "path": path,
        "w": w, "h": h,
        "black": int(black.sum()),
        "black_pct": 100.0 * black.sum() / n,
        "black_bbox": bbox(black),
        "white": int(white.sum()),
        "white_pct": 100.0 * white.sum() / n,
        "white_bbox": bbox(white),
    }


def fmt_bbox(b):
    return "-" if b is None else f"y{b[0]}-{b[1]} x{b[2]}-{b[3]}"


def cmd_scan(args):
    files = []
    for a in args.paths:
        if os.path.isdir(a):
            files += sorted(glob.glob(os.path.join(a, "*.png")))
        else:
            files += sorted(glob.glob(a)) or [a]
    if not files:
        raise SystemExit("pixelcheck: no PNGs matched")

    want = parse_res(args.res)

    bad = 0
    scanned = 0
    skipped = []
    print(f"{'frame':<34}{'exact-black':>12}{'pct':>8}  {'bbox':<26}{'exact-white':>12}{'pct':>8}")
    for f in files:
        r = scan_one(f)
        if want is not None and (r["w"], r["h"]) != want:
            # Exact zero does not survive resampling, so a non-native image cannot carry
            # the signal -- only its own chrome. See module docstring.
            skipped.append(f)
            note = "skipped (not a capture: %dx%d)" % (r["w"], r["h"])
            print(f"{os.path.basename(f):<34}{note:>34}")
            continue
        scanned += 1
        flag = ""
        if args.max_black is not None and r["black"] > args.max_black:
            flag, bad = "  <-- NaN/Inf suspect (KNOWN_ISSUES 24)", bad + 1
        if args.max_white is not None and r["white"] > args.max_white:
            flag, bad = flag + "  <-- clipped-white suspect", bad + 1
        print(f"{os.path.basename(f):<34}{r['black']:>12}{r['black_pct']:>8.3f}  "
              f"{fmt_bbox(r['black_bbox']):<26}{r['white']:>12}{r['white_pct']:>8.3f}{flag}")

    if skipped:
        print(f"\n{len(skipped)} not at capture resolution {want[0]}x{want[1]}, not scanned "
              f"(exact zero does not survive resampling; --res any to override).")

    if scanned == 0:
        print(f"pixelcheck: matched {len(files)} file(s) but scanned NONE — every one was "
              f"skipped by --res {args.res}.\nIf capture resolution changed, pass the new "
              f"--res; otherwise this gate is silently inert.", file=sys.stderr)
        return 2

    if bad:
        print(f"\n{bad} frame(s) over threshold, of {scanned} scanned.", file=sys.stderr)
        print("Exact zero in all three channels of a tonemapped, grain-dithered frame is a\n"
              "NaN/Inf reaching the framebuffer. Grain hides about half of them, so this is a\n"
              "LOWER BOUND — re-check with grain off. Bisect with tools/ablate.mjs.", file=sys.stderr)
    return 1 if bad else 0


def cmd_diff(args):
    """Table of image deltas against the first file. Used by tools/ablate.mjs."""
    base = load(args.diff[0]).astype(np.int16)
    print(f"{'variant':<28}{'meanAbs':>10}{'changed%':>10}{'max':>7}{'exact-black':>13}")
    rows = []
    for p in args.diff:
        im = load(p).astype(np.int16)
        if im.shape != base.shape:
            raise SystemExit(f"pixelcheck: shape mismatch for {p}")
        d = np.abs(im - base)
        dm = d.max(axis=2)
        blk = int(np.all(im == 0, axis=2).sum())
        rows.append((os.path.basename(p), float(d.mean()),
                     100.0 * float((dm > 0).mean()), int(dm.max()), blk))
    for name, mean, ch, mx, blk in rows:
        inert = "   <-- INERT: byte-identical to baseline" if mx == 0 and name != rows[0][0] else ""
        print(f"{name:<28}{mean:>10.4f}{ch:>10.3f}{mx:>7}{blk:>13}{inert}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", help="PNG files, globs, or a directory")
    ap.add_argument("--diff", nargs="+", metavar="PNG",
                    help="diff mode: every PNG compared against the first")
    ap.add_argument("--max-black", type=int, default=0,
                    help="fail if a frame has more exact-rgb(0,0,0) pixels than this (default 0)")
    ap.add_argument("--max-white", type=int, default=None,
                    help="fail if a frame has more exact-rgb(255,255,255) pixels than this")
    ap.add_argument("--res", default="1920x1080", metavar="WxH",
                    help="only scan images at this resolution; 'any' disables the filter. "
                         "Exact zero does not survive resampling, so montages and contact "
                         "sheets can only yield false positives (default: 1920x1080)")
    args = ap.parse_args()

    if args.diff:
        sys.exit(cmd_diff(args))
    if not args.paths:
        ap.print_help()
        sys.exit(2)
    sys.exit(cmd_scan(args))


if __name__ == "__main__":
    main()
