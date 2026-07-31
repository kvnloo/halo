#!/usr/bin/env python
"""
SILHOUETTE — shape instrument. Answers "is this thing eroded or extruded?"

Motivation: blind.md T1 decided 7 of 9 pairs on rock silhouette alone, and no ROI
mean can see a silhouette. A truncated cone and a wave-cut sea stack can have
identical lum_mean, lap_var, edge_density and spectral slope.

Method: segment objects against the sky (flood-fill sky model), then describe the
OUTLINE — not the pixels inside it — with descriptors that separate a lathe/extrusion
from an eroded natural form:

  taper_r2        R^2 of a straight-line fit to the half-width profile w(y).
                  A truncated cone with a straight batter -> ~1.00. Erosion -> lower.
  monotone_frac   fraction of rows where dw/dy keeps the dominant sign. A pure
                  taper -> 1.00. A stack with a notch and a brow -> well under 1.
  reversals       sign changes in dw/dy per 100 px of height. Extrusion ~0.
  undercut        max fractional re-widening BELOW a local minimum of w(y),
                  i.e. the sea-notch: the outline pinches in and opens out again.
                  A monotone taper cannot produce a non-zero value here. THE tell.
  overhang        same measurement on the left/right boundaries separately, so a
                  one-sided brow is not cancelled by the other side.
  convex_def      1 - area/convex_hull_area. Fracture planes and detached buttresses
                  raise this; a cone is ~0.02.
  rough_D         box/perimeter fractal dimension of the contour across scales.
                  Smooth lathe ~1.02-1.06; eroded rock 1.10-1.25.
  vert_break      strongest horizontal tone discontinuity inside the object,
                  in units of the object's own contrast. The wet/dry tidal band.

Usage:
  tools/silhouette.py <img.png> [--box x0,y0,x1,y1] [--json out.json]
  tools/silhouette.py --pair ref.png test.png [--box ...]     # side-by-side verdict
  tools/silhouette.py --pair-pose 01500                       # ref vs shots/blindcap
"""
import argparse, json, os, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DESCRIPTORS = ['taper_r2', 'monotone_frac', 'reversals', 'undercut', 'overhang',
               'convex_def', 'rough_D', 'vert_break']


# ------------------------------------------------------------------- sky model
#
# Segmentation note, because this is where a shape instrument usually dies.
# Three approaches were tried on kf_01500 / shots/blindcap/ref_01500 and only one
# survived contact with both images:
#   * flood-fill the sky from the top edge  -> leaks through the smooth sky/sea/sand
#     gradient and claims 99.5% of the frame. Useless.
#   * per-column "first strong vertical gradient" skyline -> fires on cloud edges and
#     on reference film grain; median skyline row 114 on a frame whose real skyline is
#     row 0. Useless.
#   * Otsu inside a search box, darker class = subject -> clean masks on BOTH images
#     (see the workings in this file's history). Sea stacks, cliffs, trees and the
#     bridge are all darker than the sky they occlude, which is the one assumption
#     this instrument makes. It is stated here so you can check it before trusting a
#     number: if a subject is BRIGHTER than its background, this tool is blind to it.

def subject_mask(bgr):
    """Darker-than-Otsu class inside the given crop, cleaned, as a label image."""
    g = cv2.cvtColor(cv2.GaussianBlur(bgr, (0, 0), 1.5), cv2.COLOR_BGR2GRAY)
    t, _ = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = (g < t).astype(np.uint8)
    k = max(5, (min(bgr.shape[:2]) // 60) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((max(3, k - 2),) * 2, np.uint8))
    return m, float(t)


def objects_against_sky(bgr, min_area_frac=2e-3, max_objs=24):
    """Subject blobs that have background directly above them: things that break the
    skyline. Returns (objects, sky_fraction)."""
    h, w = bgr.shape[:2]
    m, _ = subject_mask(bgr)
    sky = (1 - m).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < min_area_frac * h * w or bh < 16 or bw < 10:
            continue
        cols = np.flatnonzero(lab[y, x:x + bw] == i)
        if y >= 3 and cols.size:
            above = sky[y - 3, x + cols]
            if above.mean() < 0.3:      # buried inside another mass, not a skyline
                continue
        out.append(dict(id=i, box=[int(x), int(y), int(bw), int(bh)], area=int(area),
                        mask=(lab == i).astype(np.uint8)))
    out.sort(key=lambda o: -o['area'])
    return out[:max_objs], sky


# --------------------------------------------------------------- descriptors
def profile(mask, box):
    """half-width w(y), left boundary xl(y), right boundary xr(y) over the object."""
    x, y, bw, bh = box
    sub = mask[y:y + bh, x:x + bw]
    ws, xls, xrs, ys = [], [], [], []
    for r in range(bh):
        cols = np.flatnonzero(sub[r])
        if cols.size < 2:
            continue
        ys.append(r); xls.append(cols[0]); xrs.append(cols[-1])
        ws.append((cols[-1] - cols[0] + 1) / 2.0)
    return np.array(ys, float), np.array(ws, float), np.array(xls, float), np.array(xrs, float)


def _smooth(v, k):
    k = max(3, int(k) | 1)
    if v.size < k:
        return v.copy()
    return np.convolve(v, np.ones(k) / k, mode='same')


def undercut_index(w):
    """Largest fractional re-widening that occurs BELOW a local minimum.

    Scanning downward (image order: index increases downward), an undercut is a
    place where the half-width falls to a minimum and then grows again lower down.
    A monotone taper returns exactly 0. Symmetric-in-intent to `overhang`, which
    looks at the outline rather than the width."""
    if w.size < 12:
        return 0.0
    s = _smooth(w, max(5, w.size // 25))
    best = 0.0
    runmin = s[0]
    for v in s[1:]:
        runmin = min(runmin, v)
        if runmin > 1e-6:
            best = max(best, (v - runmin) / runmin)
    return float(best)


def overhang_index(xl, xr):
    """Same idea applied to each boundary independently, so a one-sided brow over a
    one-sided notch is not averaged away. Value = fractional lateral re-extension
    below a local extreme, in units of the object's mean half-width."""
    scale = max(np.ptp(xr - xl) * 0.5, np.mean(xr - xl) * 0.5, 1.0)
    out = 0.0
    for v, sgn in ((xl, -1.0), (xr, +1.0)):
        s = _smooth(v * sgn, max(5, v.size // 25))   # sgn -> "outward is larger"
        run = s[0]
        for t in s[1:]:
            run = min(run, t)
            out = max(out, (t - run) / scale)
    return float(out)


def contour_roughness_D(mask):
    """Perimeter-vs-smoothing-scale slope. Richardson-style fractal estimate on the
    outline only: resample the contour, smooth it at increasing scales, and fit
    log(perimeter) vs log(scale). Smooth lathe forms -> D ~ 1.0."""
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return 0.0
    c = max(cs, key=cv2.contourArea)[:, 0, :].astype(np.float64)
    if len(c) < 64:
        return 0.0
    ks, ps = [], []
    for k in (1, 2, 4, 8, 16, 32):
        if len(c) < k * 6:
            break
        d = c[::k]
        p = np.sum(np.linalg.norm(np.diff(np.vstack([d, d[:1]]), axis=0), axis=1))
        ks.append(k); ps.append(max(p, 1e-6))
    if len(ks) < 3:
        return 0.0
    slope = np.polyfit(np.log(ks), np.log(ps), 1)[0]
    return float(1.0 - slope)          # perimeter falling with step -> D > 1


def tonal_break(bgr, mask, box):
    """Strongest horizontal tone step inside the object (the wet/dry tidal band),
    normalised by the object's own luminance spread. 0 = uniform wash."""
    x, y, bw, bh = box
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)[y:y + bh, x:x + bw]
    m = mask[y:y + bh, x:x + bw].astype(bool)
    rows = np.array([g[r][m[r]].mean() if m[r].sum() >= 4 else np.nan for r in range(bh)])
    ok = ~np.isnan(rows)
    if ok.sum() < 24:
        return 0.0
    r = rows[ok]
    r = _smooth(r, 5)
    sd = r.std()
    if sd < 1e-6:
        return 0.0
    n = r.size
    lo, hi = int(n * 0.15), int(n * 0.9)
    if hi - lo < 8:
        return 0.0
    # best two-segment split: how much of the row-mean variance a single horizontal
    # break explains. A hard wet/dry line explains most of it.
    best = 0.0
    tot = ((r - r.mean()) ** 2).sum()
    for s in range(lo, hi):
        a, b = r[:s], r[s:]
        ss = ((a - a.mean()) ** 2).sum() + ((b - b.mean()) ** 2).sum()
        best = max(best, 1.0 - ss / max(tot, 1e-9))
    return float(best)


def describe(bgr, obj):
    m, box = obj['mask'], obj['box']
    ys, w, xl, xr = profile(m, box)
    d = {k: 0.0 for k in DESCRIPTORS}
    if w.size >= 12:
        A = np.polyfit(ys, w, 1)
        pred = np.polyval(A, ys)
        ssr = ((w - pred) ** 2).sum(); sst = ((w - w.mean()) ** 2).sum()
        d['taper_r2'] = float(1.0 - ssr / max(sst, 1e-9))
        dw = np.diff(_smooth(w, max(5, w.size // 25)))
        pos = (dw > 0).sum(); neg = (dw < 0).sum()
        d['monotone_frac'] = float(max(pos, neg) / max(pos + neg, 1))
        sgn = np.sign(dw); sgn = sgn[sgn != 0]
        d['reversals'] = float((np.diff(sgn) != 0).sum() / max(box[3], 1) * 100.0)
        d['undercut'] = undercut_index(w)
        d['overhang'] = overhang_index(xl, xr)
    area = float(m[box[1]:box[1] + box[3], box[0]:box[0] + box[2]].sum())
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cs:
        hull = cv2.convexHull(max(cs, key=cv2.contourArea))
        ha = max(cv2.contourArea(hull), 1.0)
        d['convex_def'] = float(max(0.0, 1.0 - area / ha))
    d['rough_D'] = contour_roughness_D(m)
    d['vert_break'] = tonal_break(bgr, m, box)
    return d


# ------------------------------------------------------------------- driver
DEFAULT_BOX = (0.0, 0.0, 1.0, 0.55)     # above the waterline in every blind pose


def analyse(path, box=None, top_n=6):
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit('cannot read ' + path)
    box = box or DEFAULT_BOX
    h, w = bgr.shape[:2]
    x0, y0, x1, y1 = box
    bgr = bgr[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
    objs, sky = objects_against_sky(bgr)
    rows = []
    for o in objs[:top_n]:
        d = describe(bgr, o)
        d['area_frac'] = round(o['area'] / (bgr.shape[0] * bgr.shape[1]), 5)
        d['box'] = o['box']
        rows.append({k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items()})
    agg = {}
    if rows:
        wts = np.array([r['area_frac'] for r in rows], float)
        wts = wts / wts.sum()
        for k in DESCRIPTORS:
            agg[k] = round(float(np.sum(wts * np.array([r[k] for r in rows]))), 4)
    return dict(file=os.path.basename(path), sky_frac=round(float(sky.mean()), 4),
                n_objects=len(objs), objects=rows, area_weighted=agg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('img', nargs='?')
    ap.add_argument('--pair', nargs=2, metavar=('REF', 'TEST'))
    ap.add_argument('--pair-pose', help='e.g. 01500 -> ref/keyframes vs shots/blindcap')
    ap.add_argument('--shots', default='shots/blindcap')
    ap.add_argument('--box', help='fractional x0,y0,x1,y1 crop before analysis')
    ap.add_argument('--json')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()
    os.chdir(ROOT)
    box = tuple(float(v) for v in a.box.split(',')) if a.box else None

    if a.pair_pose:
        a.pair = [f'ref/keyframes/kf_{a.pair_pose}.png', f'{a.shots}/ref_{a.pair_pose}.png']
    if a.pair:
        r = analyse(a.pair[0], box); t = analyse(a.pair[1], box)
        out = dict(ref=r, test=t, delta={k: round(t['area_weighted'].get(k, 0) - r['area_weighted'].get(k, 0), 4)
                                         for k in DESCRIPTORS})
        if not a.quiet:
            print(f"{'descriptor':<15}{'REF':>10}{'RENDER':>10}{'delta':>10}")
            for k in DESCRIPTORS:
                rv = r['area_weighted'].get(k, 0.0); tv = t['area_weighted'].get(k, 0.0)
                print(f'{k:<15}{rv:10.3f}{tv:10.3f}{tv - rv:+10.3f}')
            print(f"\nobjects against sky: ref {r['n_objects']}  render {t['n_objects']}"
                  f"   sky fraction: ref {r['sky_frac']:.3f}  render {t['sky_frac']:.3f}")
    else:
        out = analyse(a.img, box)
        if not a.quiet:
            print(json.dumps(out, indent=2))
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=2)


if __name__ == '__main__':
    main()
