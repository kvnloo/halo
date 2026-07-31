#!/usr/bin/env python
"""postfx helper: per-ROI table for one or more captures, against ref/roi_signatures.json.

  _pfx.py shots/px/a.png shots/px/b.png ...          # sand water weapon sky + whole
  _pfx.py --regions sand,weapon a.png b.png
"""
import sys, os, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import numpy as np
import metrics as M
import roi as R

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIG = json.load(open(os.path.join(ROOT, 'ref/roi_signatures.json')))

KEYS = ['lum_mean', 'lum_std', 'sat_mean', 'lab_b', 'lap_var', 'edge_density',
        'local_contrast', 'spectral_slope']


def stats(img):
    return M.stats_of(img) if hasattr(M, 'stats_of') else None


def main():
    args = [a for a in sys.argv[1:]]
    regions = ['sand', 'water', 'weapon', 'sky']
    if args and args[0] == '--regions':
        regions = args[1].split(',')
        args = args[2:]
    files = args
    rows = {}
    for f in files:
        img = cv2.imread(f, cv2.IMREAD_COLOR)
        if img is None:
            print('missing', f); continue
        def st(im):
            d = dict(M.stats(im))
            d['spectral_slope'] = M.spectral_slope(im)
            return d
        rows[f] = {'whole': st(img)}
        for rg in regions:
            rows[f][rg] = st(R.crop(img, R.REGIONS[rg]))
    # print
    for rg in ['whole'] + regions:
        ref = SIG.get(rg)
        print('== ' + rg)
        hdr = f"{'file':<34}" + ''.join(f'{k[:9]:>11}' for k in KEYS)
        print(hdr)
        if rg == 'whole':
            ref = {'lum_mean': 107.8, 'lum_std': 52.3, 'sat_mean': 83.9, 'lab_b': 1.4,
                   'lap_var': 463, 'edge_density': 0.085, 'local_contrast': 0.192,
                   'spectral_slope': -2.60}
        if ref:
            print(f"{'REF':<34}" + ''.join(f'{ref.get(k, float("nan")):>11.4g}' for k in KEYS))
        for f in files:
            if f not in rows: continue
            d = rows[f][rg]
            print(f"{os.path.basename(f):<34}" + ''.join(f'{d.get(k, float("nan")):>11.4g}' for k in KEYS))
        print()


if __name__ == '__main__':
    main()
