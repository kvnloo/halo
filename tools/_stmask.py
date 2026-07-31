#!/usr/bin/env python
"""Isolated structures mask: |A-B| over a with/without-structures capture pair.

  python tools/_stmask.py A.png B.png [thresh] [--vis out.png]

Prints the bbox and pixel fraction at several thresholds so the bridge's
on-screen footprint can be compared against the reference framing directly.
"""
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
d = np.abs(a - b).max(axis=2)
H, W = d.shape
for t in (6, 25, 50):
    m = d > t
    n = int(m.sum())
    if n == 0:
        print(f"thr>{t:3d}  EMPTY")
        continue
    ys, xs = np.nonzero(m)
    print(f"thr>{t:3d}  n={n:8d} ({100.0*n/(H*W):6.3f}%)  x{xs.min()}-{xs.max()}  y{ys.min()}-{ys.max()}")
if '--vis' in sys.argv:
    o = sys.argv[sys.argv.index('--vis') + 1]
    v = np.asarray(Image.open(sys.argv[1]).convert('RGB')).copy()
    v[d <= 25] = (v[d <= 25] * 0.30).astype(np.uint8)
    Image.fromarray(v).save(o)
