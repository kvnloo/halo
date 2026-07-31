#!/usr/bin/env python
"""Crop stats for the structures work: the numbers the review scores this file on.

  python tools/_stcrop.py IMG x0 y0 x1 y1 [label]

Reports lum/std/sat/rgb, the p01/p99 tails, laplacian energy, the *normalised*
laplacian energy lap_var/std^2 (which is what separates 'architecture' from
'corduroy' — absolute lap_var also rises with legitimate contrast), and multi-scale
std at blur radius 1/8/32 px.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

p = sys.argv[1]
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
label = sys.argv[6] if len(sys.argv) > 6 else p
im = Image.open(p).convert('RGB').crop((x0, y0, x1, y1))
a = np.asarray(im).astype(np.float64)
lum = a @ np.array([0.2126, 0.7152, 0.0722])
mx = a.max(axis=2); mn = a.min(axis=2)
sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6) * 255.0, 0.0)
k = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float64)
L = lum[1:-1, 1:-1] * -4 + lum[:-2, 1:-1] + lum[2:, 1:-1] + lum[1:-1, :-2] + lum[1:-1, 2:]
std = lum.std()
ms = []
for r in (1, 8, 32):
    b = np.asarray(im.filter(ImageFilter.GaussianBlur(r)).convert('RGB')).astype(np.float64)
    ms.append((b @ np.array([0.2126, 0.7152, 0.0722])).std())
print(f"{label}: n={a.shape[0]}x{a.shape[1]}")
print(f"  lum {lum.mean():7.2f}  std {std:6.2f}  sat {sat.mean():6.2f}  "
      f"rgb {a[:,:,0].mean():5.1f}/{a[:,:,1].mean():5.1f}/{a[:,:,2].mean():5.1f}  B/R {a[:,:,2].mean()/max(a[:,:,0].mean(),1e-6):.3f}")
print(f"  p01 {np.percentile(lum,1):6.1f}  p50 {np.percentile(lum,50):6.1f}  p99 {np.percentile(lum,99):6.1f}  "
      f"range {np.percentile(lum,99)-np.percentile(lum,1):6.1f}")
print(f"  lap_var {L.var():8.1f}   lap_var/std^2 {L.var()/max(std*std,1e-6):6.3f}   "
      f"ms_std(1/8/32) {ms[0]:5.1f}/{ms[1]:5.1f}/{ms[2]:5.1f}")
