#!/usr/bin/env python
"""Radial profile of the bloom contribution.

  _glare.py <with_bloom.png> <without_bloom.png> [x y]

Bloom is verified by its PROFILE, not by lum_mean: a glare kernel falls by one to two
orders of magnitude between r=2 and r=640, a veil is flat. Prints the mean signed
difference (with - without), in display code values, in log-spaced annuli around the
brightest pixel of the source (or an explicit x y).
"""
import sys
import cv2
import numpy as np

RADII = [1, 2, 3, 5, 8, 12, 20, 32, 50, 80, 128, 200, 320, 500, 800]


def main():
    a = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR).astype(np.float64)
    b = cv2.imread(sys.argv[2], cv2.IMREAD_COLOR).astype(np.float64)
    lum_b = b @ np.array([0.0722, 0.7152, 0.2126])
    if len(sys.argv) > 4:
        cx, cy = int(sys.argv[3]), int(sys.argv[4])
    else:
        cy, cx = np.unravel_index(np.argmax(cv2.GaussianBlur(lum_b, (5, 5), 0)), lum_b.shape)
    d = (a - b) @ np.array([0.0722, 0.7152, 0.2126]) / 1.0
    h, w = lum_b.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    print(f'centre ({cx},{cy})  source code {lum_b[cy, cx]:.0f}  peak-diff {d.max():.2f}')
    prev = 0
    rows = []
    for rad in RADII:
        m = (r > prev) & (r <= rad)
        if m.sum() == 0:
            prev = rad; continue
        rows.append((rad, d[m].mean(), m.sum()))
        prev = rad
    for rad, v, n in rows:
        print(f'  r<={rad:4d}  {v:+8.3f} codes   (n={n})')
    peak = rows[0][1] if rows else 0
    tail = [v for rad, v, n in rows if rad >= 200]
    print(f'core(r<=1) {peak:+.3f}   tail(r>=200) mean {np.mean(tail):+.3f}'
          f'   ratio {abs(peak) / max(abs(np.mean(tail)), 1e-3):.1f}x')


if __name__ == '__main__':
    main()
