#!/usr/bin/env python
"""Cloud-module measurement helper.  Prints, for each image given:
  - the `sky`, `horizon` and `rock` ROI signatures (same crops as tools/roi.py)
  - a zenith band (top 12% of frame) breakdown: cloud/blue fractions, clipping
  - a cloud-body-only crop stat (brightest connected sky material) via a sat/lum mask
Reference frames may be passed too; the crops are identical so numbers are comparable.
Usage: _cloudstat.py <region|zenith|body> img [img ...]
"""
import sys, cv2, numpy as np

REGIONS = {
    'sky':       (0.02, 0.02, 0.62, 0.36),
    'horizon':   (0.02, 0.34, 0.60, 0.50),
    'rock':      (0.24, 0.02, 0.58, 0.50),
    'weapon':    (0.52, 0.50, 1.00, 1.00),
    'cliff':     (0.62, 0.02, 0.99, 0.55),
    'zenith':    (0.00, 0.00, 1.00, 0.12),
}


def crop(img, r):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = r
    return img[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]


def sig(c):
    g = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(c, cv2.COLOR_BGR2LAB)
    gf = g.astype(np.float64)
    lap = cv2.Laplacian(g, cv2.CV_64F).var()
    ed = float((cv2.Canny(g, 60, 160) > 0).mean())
    k = cv2.GaussianBlur(gf, (0, 0), 4.0)
    lc = float((np.abs(gf - k) / (k + 8.0)).mean())
    return dict(lum_mean=gf.mean(), lum_std=gf.std(), sat_mean=hsv[..., 1].mean(),
                lab_a=lab[..., 1].astype(np.float64).mean() - 128.0,
                lab_b=lab[..., 2].astype(np.float64).mean() - 128.0,
                lap_var=lap, edge_density=ed, local_contrast=lc,
                p01=float(np.percentile(gf, 1)), p99=float(np.percentile(gf, 99)),
                shadow=float((gf < 32).mean()), hi=float((gf > 224).mean()))


def zenith(c):
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
    g = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY).astype(np.float64)
    sat = hsv[..., 1].astype(np.float64) / 255.0
    cloud = (sat < 0.16) & (g > 110)
    blue = (sat > 0.30)
    return dict(frac_cloud=float(cloud.mean()), frac_blue=float(blue.mean()),
                sat=hsv[..., 1].mean(), lum=g.mean(),
                p99=float(np.percentile(g, 99)), clip=float((g > 224).mean()))


def body(c):
    """cloud-body-only: mask bright low-sat pixels, report texture inside the mask bbox
    restricted to the mask (masked pixels only, others filled with the mask mean)."""
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
    g = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)
    sat = hsv[..., 1].astype(np.float64) / 255.0
    m = ((sat < 0.20) & (g > 100)).astype(np.uint8)
    m = cv2.erode(m, np.ones((9, 9), np.uint8))
    if m.sum() < 400:
        return dict(px=int(m.sum()), lap_var=0.0, edge=0.0, std=0.0, mean=0.0)
    gf = g.astype(np.float64)
    fill = gf[m > 0].mean()
    filled = np.where(m > 0, gf, fill).astype(np.uint8)
    lap = cv2.Laplacian(filled, cv2.CV_64F)
    e = (cv2.Canny(filled, 60, 160) > 0)
    return dict(px=int(m.sum()), lap_var=float(lap[m > 0].var()),
                edge=float(e[m > 0].mean()), std=float(gf[m > 0].std()),
                mean=float(fill))


def main():
    mode = sys.argv[1]
    for f in sys.argv[2:]:
        img = cv2.imread(f)
        if img is None:
            print(f"{f}: MISSING"); continue
        if mode == 'zenith':
            d = zenith(crop(img, REGIONS['zenith']))
        elif mode == 'body':
            d = body(crop(img, REGIONS['sky']))
        else:
            d = sig(crop(img, REGIONS[mode]))
        print(f, ' '.join(f"{k}={v:.4f}" for k, v in d.items()))


main()
