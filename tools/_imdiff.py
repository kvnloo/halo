#!/usr/bin/env python
"""Numeric difference between two captures, in 8-bit code values.

  _imdiff.py a.png b.png [more.png ...]      # each compared against the first

Reports max, mean and the count of pixels differing by >=1 and >=2 code values, plus a
per-ROI breakdown for the 'rock' region (the rock/sky silhouette this project cares
about). `cmp` only answers "identical or not"; a TAA that is still crawling needs the
magnitude.
"""
import sys
import numpy as np
import cv2

REGIONS = {'rock': (0.24, 0.02, 0.58, 0.50), 'sky': (0.02, 0.02, 0.62, 0.36),
           'sand': (0.02, 0.66, 0.55, 0.99)}


def crop(img, r):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = r
    return img[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]


def rep(name, a, b):
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    n = d.size
    print(f'  {name:<10} max {d.max():3d}  mean {d.mean():.5f}  '
          f'frac>=1 {(d >= 1).sum() / n:.5f}  frac>=2 {(d >= 2).sum() / n:.6f}')


ref = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR)
for p in sys.argv[2:]:
    img = cv2.imread(p, cv2.IMREAD_COLOR)
    print(f'{sys.argv[1]}  vs  {p}')
    rep('full', ref, img)
    for k, r in REGIONS.items():
        rep(k, crop(ref, r), crop(img, r))
