#!/usr/bin/env python3
"""Character-interior detail probe.

Builds an exact character mask by differencing a frame against the same frame with the
`ai` module skipped, erodes it so the silhouette boundary contributes nothing, and
reports Laplacian variance / edge density of the actor SURFACE only.

That distinction is the whole point: a flat plastic model still scores a high lap_var
on a hand-picked crop, because the crop's energy is the silhouette against a busy
background. Erode the mask and the surface has to carry the number on its own.

  .venv/bin/python tools/_chmask.py shots/a_ai.png shots/a_noai.png [--erode 4]
"""
import sys
import numpy as np
from PIL import Image

def lum(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]

def erode(m, k):
    out = m.copy()
    for _ in range(k):
        e = out.copy()
        e[1:, :] &= out[:-1, :]
        e[:-1, :] &= out[1:, :]
        e[:, 1:] &= out[:, :-1]
        e[:, :-1] &= out[:, 1:]
        out = e
    return out

def main():
    ai = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float64)
    no = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.float64)
    er = 4
    if '--erode' in sys.argv:
        er = int(sys.argv[sys.argv.index('--erode') + 1])
    diff = np.abs(ai - no).max(axis=2)
    mask = diff > 10.0
    mask = erode(mask, er)
    n = int(mask.sum())
    if n < 200:
        print('{"err":"mask too small","px":%d}' % n)
        return

    L = lum(ai)
    # 4-neighbour Laplacian, valid only where the whole stencil is inside the mask
    lap = np.zeros_like(L)
    lap[1:-1, 1:-1] = (L[:-2, 1:-1] + L[2:, 1:-1] + L[1:-1, :-2] + L[1:-1, 2:]
                       - 4 * L[1:-1, 1:-1])
    inner = np.zeros_like(mask)
    inner[1:-1, 1:-1] = (mask[1:-1, 1:-1] & mask[:-2, 1:-1] & mask[2:, 1:-1]
                         & mask[1:-1, :-2] & mask[1:-1, 2:])
    v = lap[inner]
    gx = np.zeros_like(L); gy = np.zeros_like(L)
    gx[:, 1:-1] = L[:, 2:] - L[:, :-2]
    gy[1:-1, :] = L[2:, :] - L[:-2, :]
    g = np.sqrt(gx ** 2 + gy ** 2)[inner]

    px = ai[mask]
    mx = px.max(axis=1); mn = px.min(axis=1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6) * 255.0, 0.0)

    out = {
        'px': n, 'inner_px': int(inner.sum()),
        'lap_var': float(v.var()),
        'edge_density': float((g > 12.0).mean()),
        'lum_mean': float(lum(px).mean()),
        'lum_std': float(lum(px).std()),
        'p99': float(np.percentile(lum(px), 99)),
        'sat_mean': float(sat.mean()),
        'spec_frac': float((lum(px) > 200).mean()),
    }
    print('{' + ', '.join('"%s": %s' % (k, round(v, 4) if isinstance(v, float) else v)
                          for k, v in out.items()) + '}')

main()
