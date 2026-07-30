#!/usr/bin/env python3
"""weapons-agent scratch tool: gun-only statistics.

ours: exact viewmodel mask = |frame - frame_without_weapons| > 3
ref : hand-traced polygon over the MA5B + glove in kf_00000 (verified by dumping the
      masked image and looking at it).
"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw

def lum(a):
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]

def lapvar(g):
    k = np.zeros_like(g)
    k[1:-1,1:-1] = (-4*g[1:-1,1:-1] + g[:-2,1:-1] + g[2:,1:-1] + g[1:-1,:-2] + g[1:-1,2:])
    return k

# ref gun polygon in full-frame 1920x1080 coords (gun body + stock + glove)
REF_POLY = [(998,1080),(998,890),(1060,850),(1120,842),(1180,790),(1240,752),
            (1276,600),(1300,558),(1400,545),(1458,612),(1450,700),(1472,792),
            (1600,880),(1780,978),(1920,1044),(1920,1080)]

def stats(rgb, mask, name):
    px = rgb[mask]
    if px.shape[0] < 100:
        print(f'{name}: empty mask'); return {}
    L = 0.2126*px[:,0] + 0.7152*px[:,1] + 0.0722*px[:,2]
    g = lum(rgb.astype(np.float64))
    lv = lapvar(g)
    m2 = mask.copy(); m2[:2]=False; m2[-2:]=False; m2[:,:2]=False; m2[:,-2:]=False
    d = dict(
        n=int(px.shape[0]),
        lum_mean=float(L.mean()), lum_std=float(L.std()),
        p50=float(np.percentile(L,50)), p99=float(np.percentile(L,99)),
        R=float(px[:,0].mean()), G=float(px[:,1].mean()), B=float(px[:,2].mean()),
        RmB=float(px[:,0].mean()-px[:,2].mean()),
        lap_var=float(lv[m2].var()),
        hi_frac=float((L>200).mean()),
    )
    print(name, json.dumps({k:(round(v,3) if isinstance(v,float) else v) for k,v in d.items()}))
    return d

def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float64)

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'ours':
        a = load(sys.argv[2]); b = load(sys.argv[3])
        mask = np.abs(a-b).max(axis=2) > 3
        # restrict to weapon ROI to drop tracers etc
        m = np.zeros(mask.shape, bool); m[540:, 998:] = True
        mask &= m
        if len(sys.argv) > 4:
            out = a.copy(); out[~mask] = [255,0,255]
            Image.fromarray(out.astype(np.uint8)).save(sys.argv[4])
        stats(a, mask, 'GUN(ours)')
        # background sand inside ROI
        sand = m & ~mask
        stats(a, sand, 'SAND(ours)')
    else:
        a = load(sys.argv[2])
        img = Image.new('L', (a.shape[1], a.shape[0]), 0)
        ImageDraw.Draw(img).polygon(REF_POLY, fill=255)
        mask = np.asarray(img) > 128
        if len(sys.argv) > 3:
            out = a.copy(); out[~mask] = [255,0,255]
            Image.fromarray(out.astype(np.uint8)).save(sys.argv[3])
        stats(a, mask, 'GUN(ref)')
