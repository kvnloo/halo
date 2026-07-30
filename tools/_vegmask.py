#!/usr/bin/env python
"""Vegetation diagnostics for src/world/vegetation.js.

  _vegmask.py frac  IMG [IMG...]                 foliage-hue coverage, whole frame
  _vegmask.py rows  IMG                          coverage per 120-px row band
  _vegmask.py roi   IMG REGION                   coverage inside a named roi.py region
  _vegmask.py box   IMG x0 y0 x1 y1              coverage + stats inside a pixel box
  _vegmask.py diff  A B                          A minus B: changed-pixel bbox + %
  _vegmask.py stats IMG x0 y0 x1 y1              full metric block for a pixel box

Foliage mask is the reviewer's: HSV (OpenCV scale) H in [25,48] deg-halved -> [12.5,24],
S > 60, V > 25.  We use the reviewer's literal ranges on OpenCV's 0-179 hue by halving.
"""
import sys
import cv2
import numpy as np


def mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0].astype(np.float32), hsv[:, :, 1], hsv[:, :, 2]
    return ((h >= 25) & (h <= 48) & (s > 60) & (v > 25))


def stats(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lap = cv2.Laplacian(g, cv2.CV_32F)
    edges = cv2.Canny(img, 60, 160)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    k = 9
    mu = cv2.blur(g, (k, k))
    mu2 = cv2.blur(g * g, (k, k))
    lc = np.sqrt(np.maximum(mu2 - mu * mu, 0)) / np.maximum(mu, 1e-3)
    # radial spectral slope
    f = np.fft.fftshift(np.abs(np.fft.fft2(g - g.mean())))
    hh, ww = f.shape
    yy, xx = np.mgrid[0:hh, 0:ww]
    r = np.hypot(yy - hh / 2, xx - ww / 2).astype(np.int32)
    nb = min(hh, ww) // 2
    prof = np.bincount(r.ravel(), f.ravel(), nb + 1)[1:nb] / np.maximum(np.bincount(r.ravel(), None, nb + 1)[1:nb], 1)
    fr = np.arange(1, nb)
    sel = (fr > 2) & (fr < nb * 0.8) & (prof > 0)
    slope = np.polyfit(np.log(fr[sel]), np.log(prof[sel]), 1)[0] if sel.sum() > 8 else float('nan')
    return dict(
        lum_mean=float(g.mean()), lum_std=float(g.std()),
        p01=float(np.percentile(g, 1)), p99=float(np.percentile(g, 99)),
        sat_mean=float(hsv[:, :, 1].mean()),
        lab_a=float(lab[:, :, 1].mean() - 128), lab_b=float(lab[:, :, 2].mean() - 128),
        lap_var=float(lap.var()), edge_density=float((edges > 0).mean()),
        local_contrast=float(lc.mean()), spectral_slope=float(slope),
        foliage_pct=float(mask(img).mean() * 100),
    )


def fmt(d):
    return ('lum %.2f/%.2f p01 %.0f p99 %.0f sat %.2f lab_b %+.2f lap %.2f edge %.4f '
            'lc %.4f spec %.3f fol %.3f%%') % (
        d['lum_mean'], d['lum_std'], d['p01'], d['p99'], d['sat_mean'], d['lab_b'],
        d['lap_var'], d['edge_density'], d['local_contrast'], d['spectral_slope'], d['foliage_pct'])


REGIONS = {
    'sky': (0.02, 0.02, 0.62, 0.36), 'sky_sun': (0.55, 0.02, 0.98, 0.30),
    'horizon': (0.02, 0.34, 0.60, 0.50), 'water': (0.02, 0.44, 0.52, 0.62),
    'shoreline': (0.10, 0.52, 0.70, 0.72), 'sand': (0.02, 0.66, 0.55, 0.99),
    'rock': (0.24, 0.02, 0.58, 0.50), 'cliff': (0.62, 0.02, 0.99, 0.55),
    'weapon': (0.52, 0.50, 1.00, 1.00), 'lower_left': (0.00, 0.55, 0.50, 1.00),
}


def main():
    cmd = sys.argv[1]
    if cmd == 'frac':
        for p in sys.argv[2:]:
            im = cv2.imread(p, cv2.IMREAD_COLOR)
            print('%-42s %.4f%%' % (p, mask(im).mean() * 100))
    elif cmd == 'rows':
        im = cv2.imread(sys.argv[2], cv2.IMREAD_COLOR)
        m = mask(im)
        for y in range(0, im.shape[0], 120):
            print('y%4d-%4d  %.3f%%' % (y, y + 120, m[y:y + 120].mean() * 100))
    elif cmd == 'roi':
        im = cv2.imread(sys.argv[2], cv2.IMREAD_COLOR)
        h, w = im.shape[:2]
        x0, y0, x1, y1 = REGIONS[sys.argv[3]]
        c = im[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        print('%-42s %s  %s' % (sys.argv[2], sys.argv[3], fmt(stats(c))))
    elif cmd in ('box', 'stats'):
        im = cv2.imread(sys.argv[2], cv2.IMREAD_COLOR)
        x0, y0, x1, y1 = (int(v) for v in sys.argv[3:7])
        c = im[y0:y1, x0:x1]
        print('%-42s [%d,%d,%d,%d] %s' % (sys.argv[2], x0, y0, x1, y1, fmt(stats(c))))
    elif cmd == 'diff':
        a = cv2.imread(sys.argv[2], cv2.IMREAD_COLOR).astype(np.int16)
        b = cv2.imread(sys.argv[3], cv2.IMREAD_COLOR).astype(np.int16)
        d = (np.abs(a - b).max(axis=2) > 2)
        print('changed %.3f%%' % (d.mean() * 100))
        ys, xs = np.nonzero(d)
        if len(ys):
            print('bbox x%d-%d y%d-%d' % (xs.min(), xs.max(), ys.min(), ys.max()))
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
