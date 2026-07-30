#!/usr/bin/env python
"""Crop named regions out of reference/render frames so a subsystem can be measured
against the part of the image it is actually responsible for.

  roi.py <img.png> <region> <out.png>
  roi.py --all <img.png> <outdir>

Regions are fractional (x0,y0,x1,y1) of the frame.
"""
import sys, os
import cv2

REGIONS = {
    'sky':        (0.02, 0.02, 0.62, 0.36),   # open sky, above the horizon
    'sky_sun':    (0.55, 0.02, 0.98, 0.30),   # near-sun region: Mie glow, bloom
    'horizon':    (0.02, 0.34, 0.60, 0.50),   # the haze band + distant stacks
    'water':      (0.02, 0.44, 0.52, 0.62),   # open + shallow water
    'shoreline':  (0.10, 0.52, 0.70, 0.72),   # swash zone, foam, wet sand
    'sand':       (0.02, 0.66, 0.55, 0.99),   # foreground sand + cobbles
    'rock':       (0.24, 0.02, 0.58, 0.50),   # sea-stack faces (best on kf_01500)
    'cliff':      (0.62, 0.02, 0.99, 0.55),   # cliff + vegetation (best on kf_00000)
    'weapon':     (0.52, 0.50, 1.00, 1.00),   # viewmodel + HUD
    'lower_left': (0.00, 0.55, 0.50, 1.00),
}

def crop(img, r):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = r
    return img[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]

def main():
    if sys.argv[1] == '--all':
        src, outdir = sys.argv[2], sys.argv[3]
        img = cv2.imread(src, cv2.IMREAD_COLOR)
        os.makedirs(outdir, exist_ok=True)
        base = os.path.splitext(os.path.basename(src))[0]
        for name, r in REGIONS.items():
            cv2.imwrite(os.path.join(outdir, f'{base}__{name}.png'), crop(img, r))
        print(outdir)
    else:
        src, region, out = sys.argv[1], sys.argv[2], sys.argv[3]
        img = cv2.imread(src, cv2.IMREAD_COLOR)
        os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
        cv2.imwrite(out, crop(img, REGIONS[region]))
        print(out)

if __name__ == '__main__':
    main()
