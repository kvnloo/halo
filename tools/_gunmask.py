#!/usr/bin/env python3
"""Gun-only measurement: mask = |with - without| > thresh, then stats over mask.

usage: _gunmask.py with.png without.png [--vis out.png]
"""
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage

def load(p):
    return np.asarray(Image.open(p).convert('RGB'), dtype=np.float32)

a = load(sys.argv[1]); b = load(sys.argv[2])
vis = None
if '--vis' in sys.argv: vis = sys.argv[sys.argv.index('--vis')+1]

d = np.abs(a-b).max(axis=2)
m = d > 6.0
# clean: remove specks smaller than 12 px
lab, n = ndimage.label(m)
sizes = ndimage.sum(m, lab, range(1, n+1))
keep = np.zeros(n+1, bool)
keep[1:][sizes >= 12] = True
m = keep[lab]

H, W = m.shape
lab, ncomp = ndimage.label(m)
sizes = ndimage.sum(m, lab, range(1, ncomp+1)) if ncomp else np.array([])

px = a[m]
if px.size == 0:
    print(json.dumps({'pixels': 0})); sys.exit()

lum = 0.2126*px[:,0] + 0.7152*px[:,1] + 0.0722*px[:,2]
mx = px.max(axis=1); mn = px.min(axis=1)
sat = np.where(mx > 0, (mx-mn)/np.maximum(mx,1e-6)*255.0, 0.0)

# lab_b via sRGB->Lab
def srgb_lin(c):
    c = c/255.0
    return np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)
lin = srgb_lin(px)
X = lin@np.array([0.4124,0.3576,0.1805]); Y = lin@np.array([0.2126,0.7152,0.0722]); Z = lin@np.array([0.0193,0.1192,0.9505])
Xn,Yn,Zn = 0.95047,1.0,1.08883
def f(t): return np.where(t > 0.008856, np.cbrt(t), 7.787*t + 16/116)
fx,fy,fz = f(X/Xn), f(Y/Yn), f(Z/Zn)
lab_a = 500*(fx-fy); lab_b = 200*(fy-fz)

# interior stats: erode mask so edge-of-silhouette contrast doesn't dominate
inner = ndimage.binary_erosion(m, np.ones((7,7)))
gray = (0.2126*a[:,:,0] + 0.7152*a[:,:,1] + 0.0722*a[:,:,2])
lapk = np.array([[0,1,0],[1,-4,1],[0,1,0]], np.float32)
lp = ndimage.convolve(gray, lapk, mode='reflect')
sx = ndimage.sobel(gray, 0); sy = ndimage.sobel(gray, 1)
gm = np.hypot(sx, sy)/4.0
lo = ndimage.uniform_filter(gray, 9)
hi = np.abs(gray - lo)
loc = hi / np.maximum(lo, 1.0)

res = {
  'pixels': int(m.sum()),
  'coverage_frame': float(m.sum()/(H*W)),
  'cov_weaponROI': float(m[int(0.50*H):, int(0.52*W):].mean()),
  'cov_bottomrow': float(m[int(0.93*H):, :].mean()),
  'cov_rightcol': float(m[:, int(0.95*W):].mean()),
  'lum_mean': float(lum.mean()), 'lum_std': float(lum.std()),
  'p50': float(np.percentile(lum,50)), 'p99': float(np.percentile(lum,99)),
  'frac_gt200': float((lum>200).mean()),
  'frac_gt160': float((lum>160).mean()),
  'sat_mean': float(sat.mean()),
  'lab_a': float(lab_a.mean()), 'lab_b': float(lab_b.mean()),
  'components': int(ncomp),
  'largest_frac': float(sizes.max()/m.sum()) if ncomp else 0.0,
  'inner_px': int(inner.sum()),
  'inner_lap_var': float(lp[inner].var()) if inner.sum() > 100 else None,
  'inner_edge_density': float((gm[inner] > 12).mean()) if inner.sum() > 100 else None,
  'inner_local_contrast': float(loc[inner].mean()) if inner.sum() > 100 else None,
}
ys, xs = np.nonzero(m)
res['bbox'] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
print(json.dumps(res, indent=1))
if vis:
    out = (a*0.25).astype(np.uint8)
    out[m] = a[m].astype(np.uint8)
    Image.fromarray(out).save(vis)
