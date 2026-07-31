#!/usr/bin/env python
"""Cloud-isolating measurement.

The scored `sky` ROI is a fixed screen rectangle and at every pose it contains rock,
cliff or structure that other modules are editing live, so it cannot be used to judge a
cloud change frame-to-frame. This isolates the cloud module two ways:

  body  render.png noclouds.png     cloud-body mask = pixels the module actually wrote
                                    (|diff| > 6 against a --skip clouds control), then
                                    tonal + texture stats on those pixels only.
  ref   kf.png                      the same statistics over an independently-derived
                                    cloud mask on a reference keyframe (bright, low
                                    saturation, above the horizon), so the two are
                                    comparable without assuming the clouds are in the
                                    same places.
  box   img.png x0 y0 x1 y1         raw stats on a pixel box.

Usage: _clstat.py body <render> <noclouds> [ymax]
       _clstat.py ref  <kf> [ymax]
       _clstat.py box  <img> <x0> <y0> <x1> <y1>
"""
import sys
import cv2
import numpy as np


def stats(g, mask):
    n = int(mask.sum())
    if n < 500:
        return dict(px=n)
    v = g[mask].astype(np.float64)
    fill = v.mean()
    filled = np.where(mask, g, fill).astype(np.uint8)
    lap = cv2.Laplacian(filled, cv2.CV_64F)
    k = cv2.GaussianBlur(filled.astype(np.float64), (0, 0), 4.0)
    lc = np.abs(filled.astype(np.float64) - k) / (k + 8.0)
    return dict(
        area=float(mask.mean()), px=n,
        p01=float(np.percentile(v, 1)), p50=float(np.percentile(v, 50)),
        p90=float(np.percentile(v, 90)), p99=float(np.percentile(v, 99)),
        std=float(v.std()),
        f230=float((v > 230).mean()), f110=float((v < 110).mean()),
        lap_var=float(lap[mask].var()), lc=float(lc[mask].mean()),
    )


def main():
    mode = sys.argv[1]
    if mode == 'body':
        a = cv2.imread(sys.argv[2])
        b = cv2.imread(sys.argv[3])
        ymax = int(sys.argv[4]) if len(sys.argv) > 4 else 520
        d = np.abs(a.astype(int) - b.astype(int)).max(2)
        m = d > 6
        m[ymax:] = False
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
        r = stats(g, m)
    elif mode == 'ref':
        a = cv2.imread(sys.argv[2])
        ymax = int(sys.argv[3]) if len(sys.argv) > 3 else 520
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(a, cv2.COLOR_BGR2HSV)
        sat = hsv[..., 1].astype(np.float64) / 255.0
        m = (sat < 0.30) & (g > 100)
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN,
                             np.ones((5, 5), np.uint8)) > 0
        m[ymax:] = False
        r = stats(g, m)
    else:
        a = cv2.imread(sys.argv[2])
        x0, y0, x1, y1 = (int(x) for x in sys.argv[3:7])
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
        m = np.zeros(g.shape, bool)
        m[y0:y1, x0:x1] = True
        r = stats(g, m)
    print(sys.argv[2], ' '.join(f'{k}={v:.4f}' if isinstance(v, float) else f'{k}={v}'
                                for k, v in r.items()))


main()
