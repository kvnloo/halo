#!/usr/bin/env python3
"""weapons-agent scratch tool #2 — gun-only structural statistics.

The mean is not the image (KNOWN_ISSUES 4/6). This prints the things that actually
separate "gunmetal" from "sandstone stick":

  * luma histogram in the bins that matter (deep black / midtone jam / rail-sheen band)
  * connected-component analysis of the highlight population
  * per-scanline silhouette coverage inside the weapon ROI
  * lap_var / local_contrast on an ERODED mask (silhouette edge excluded)

usage:
  _wpn2.py ours  frame.png frame_noweapons.png [--dump out.png]
  _wpn2.py ref   ref/keyframes/kf_00000.png     [--dump out.png]
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROI_X0, ROI_Y0 = 998, 540           # weapon ROI origin used by the critic
W_FULL, H_FULL = 1920, 1080

# hand-traced polygon over the MA5B + both gloves in kf_00000.
REF_POLY = [(998,1080),(998,890),(1060,850),(1120,842),(1180,790),(1240,752),
            (1276,600),(1300,558),(1400,545),(1458,612),(1450,700),(1472,792),
            (1600,880),(1780,978),(1920,1044),(1920,1080)]


def lum(a):
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]


def stats(rgb, mask, name):
    px = rgb[mask]
    n = px.shape[0]
    if n < 100:
        print(f'{name}: empty mask'); return {}
    L = 0.2126*px[:,0] + 0.7152*px[:,1] + 0.0722*px[:,2]
    g = lum(rgb.astype(np.float64))

    # laplacian + local contrast on an eroded mask so the silhouette edge is excluded
    inner = ndimage.binary_erosion(mask, np.ones((5,5)))
    lap = ndimage.convolve(g, np.array([[0,1,0],[1,-4,1],[0,1,0]], np.float64), mode='reflect')
    lo = ndimage.uniform_filter(g, 9)
    loc = np.abs(g-lo)/np.maximum(lo, 1.0)

    Lg = lum(rgb)
    hist = {}
    for a, b in [(0,15),(15,25),(25,80),(80,130),(130,170),(170,200),(200,256)]:
        hist[f'{a}-{b}'] = round(float(((L>=a)&(L<b)).mean()), 4)

    comps = {}
    for thr in (170, 200):
        hm = mask & (Lg > thr)
        lab, k = ndimage.label(hm)
        cnt = int(hm.sum())
        if k:
            sizes = np.asarray(ndimage.sum(hm, lab, range(1, k+1)))
            energy = np.asarray(ndimage.sum(Lg*hm, lab, range(1, k+1)))
            big = float(energy.max()/max(energy.sum(), 1e-6))
        else:
            big = 0.0
        comps[f'>{thr}'] = dict(px=cnt, frac=round(cnt/n, 4), ncomp=int(k), largest_energy=round(big,3))

    d = dict(
        n=n,
        lum_mean=round(float(L.mean()),2), lum_std=round(float(L.std()),2),
        p01=round(float(np.percentile(L,1)),1), p50=round(float(np.percentile(L,50)),2),
        p99=round(float(np.percentile(L,99)),1),
        R=round(float(px[:,0].mean()),1), G=round(float(px[:,1].mean()),1), B=round(float(px[:,2].mean()),1),
        RmB=round(float(px[:,0].mean()-px[:,2].mean()),2),
        lap_var=round(float(lap[inner].var()),1),
        local_con=round(float(loc[inner].mean()),4),
        frac_lt25=round(float((L<25).mean()),4),
        frac_gt200=round(float((L>200).mean()),4),
    )
    print(f'--- {name}')
    print('  ', json.dumps(d))
    print('   hist', json.dumps(hist))
    print('   comp', json.dumps(comps))

    # per-scanline coverage inside the ROI
    cov = []
    for y in (1079, 1040, 1000, 950, 900, 850, 800, 750):
        row = mask[y, ROI_X0:]
        cov.append(f'y{y}:{int(row.sum())}')
    print('   cover/%d' % (W_FULL-ROI_X0), ' '.join(cov))
    ys, xs = np.nonzero(mask)
    print('   bbox x[%d,%d] y[%d,%d]' % (xs.min(), xs.max(), ys.min(), ys.max()))
    return d


def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float64)


if __name__ == '__main__':
    mode = sys.argv[1]
    dump = None
    if '--dump' in sys.argv:
        dump = sys.argv[sys.argv.index('--dump')+1]
    if mode == 'ours':
        a = load(sys.argv[2]); b = load(sys.argv[3])
        mask = np.abs(a-b).max(axis=2) > 3
        m = np.zeros(mask.shape, bool); m[ROI_Y0:, ROI_X0:] = True
        mask &= m
        if dump:
            out = a.copy(); out[~mask] = [255,0,255]
            Image.fromarray(out.astype(np.uint8)).save(dump)
        stats(a, mask, 'GUN(ours)')
        # stray fragments: components far from the main body
        lab, k = ndimage.label(mask)
        sizes = np.asarray(ndimage.sum(mask, lab, range(1, k+1)))
        main = int(np.argmax(sizes))+1
        stray = int((sizes < sizes.max()*0.01).sum())
        print(f'   components={k}  main={int(sizes.max())}px  stray(<1% of main)={stray}')
        stats(a, m & ~mask, 'SAND(ours, ROI minus gun)')
    else:
        a = load(sys.argv[2])
        img = Image.new('L', (a.shape[1], a.shape[0]), 0)
        ImageDraw.Draw(img).polygon(REF_POLY, fill=255)
        mask = np.asarray(img) > 128
        if dump:
            out = a.copy(); out[~mask] = [255,0,255]
            Image.fromarray(out.astype(np.uint8)).save(dump)
        stats(a, mask, 'GUN(ref)')
