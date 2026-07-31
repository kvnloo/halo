#!/usr/bin/env python
"""
STACKPROFILE — per-object silhouette profile, for T1 ("extrusions, not erosion").

Why this exists, and what is wrong with reading `tools/silhouette.py --pair-pose`
at its default whole-frame box (measured, this session):

  1. At the default box the segmenter's largest objects are HALF-FRAME MERGED MASSES,
     not stacks. At kf_01500 the two dominant "objects" are 1080x594 and 834x594 boxes
     covering 37% and 17% of the crop -- cliff + stack + beach + shadowed sea fused into
     one dark blob by Otsu. Their descriptors describe that blob, not a rock.
  2. `undercut_index` scans DOWNWARD from the top of the object and returns the largest
     fractional re-widening below a running minimum. A plain truncated cone widens
     monotonically downward, so it scores arbitrarily high -- the statistic cannot
     separate "sea-notch" from "cone". The ref's 23.67 on that half-frame mass is a
     mask that is 6 px wide at the top and 800 px wide at the bottom, which is the
     signature of an extrusion, not of erosion.

  So docs/LOOP.md's "undercut ref 8.46 vs render 0.99, wave-cut erosion returns 6-8"
  is not a measurement of rock silhouettes and must not be steered by. See
  reports/rocks.md.

What this tool measures instead: ONE object, inside an explicitly given per-image box,
described by its half-width profile w(y) after removing the linear taper -- so a cone
scores zero on every descriptor by construction.

  taper_rms    RMS residual of w(y) about its own straight-line fit, as a fraction of
               mean half-width. A truncated cone -> 0.00-0.02. This is THE headline:
               it is exactly "how much of the silhouette is not explained by a taper".
  n_infl       inflections in the detrended profile per 100 px of height (deep ones
               only: excursion > 0.02 of mean width), i.e. how many parts the outline
               has in the Hoffman-Richards sense.
  visor        local outward flare ABOVE a local waist in the lower 45% of the object:
               max over (a above b) of w(a)/w(b) - 1. This is the notch+brow pair, and
               unlike `undercut_index` it is immune to plain conical widening because
               it requires the WIDER row to be the HIGHER one.
  notch_y      where that waist sits, as a fraction of object height from the base.
  edge_rms_l   same detrended-RMS statistic on the left and right boundaries taken
  edge_rms_r   separately, so a one-sided buttress is not cancelled by the other side.
  crown_ratio  half-width at 90% height / half-width at 10% height. Ko Tapu = 2.0;
               a truncated cone with a straight batter is < 1 by definition.

Usage:
  tools/stackprofile.py IMG --box x0,y0,x1,y1 [--json out.json]
  tools/stackprofile.py --pair REF TEST --refbox ... --testbox ...
  tools/stackprofile.py --spec specs.json          # named cases, both sides, table

Boxes are PIXEL boxes x0,y0,x1,y1 and are per-image on purpose: the same stack is not
in the same place in the reference and in our render (the poses are not co-registered --
docs/LOOP.md section 1), so one shared fractional box cannot crop the same subject twice.
"""
import argparse, json, os, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import silhouette as S           # reuse its profile()/roughness/tonal-break helpers


# ------------------------------------------------------------------ segmentation
#
# silhouette.py's Otsu-darker-class segmenter is NOT usable on a tight per-stack crop,
# and this was checked before replacing it: on kf_00450's hero stack the sunlit right
# face is BRIGHTER than the Otsu threshold, so a 60 px-wide vertical strip of the rock
# is cut out of the mask and the right-hand boundary becomes the shadow line instead of
# the silhouette. That file states the assumption itself ("if a subject is BRIGHTER than
# its background, this tool is blind to it"); at whole-frame scale the sky dominates the
# histogram and it holds, but inside a crop that is 65% rock it does not.
#
# Replacement: classify BACKGROUND (sky, cloud, open water) by chroma rather than by
# luminance, then take the largest component and fill enclosed holes.
#   sky/sea : hue in [185,268) with saturation > 0.09
#   cloud   : value > 0.66 with saturation < 0.22
# Both hold in the reference frames and in our render (sampled: ref sky HSV 219/0.46/0.61,
# our sky 219/0.47/0.61 -- the hue agrees even though the tonemap does not).
# Failure mode to know: a rock face that is BOTH bright and desaturated (a blown
# highlight) is read as cloud. Check the mask overlay before trusting a new box.

def subject_mask(bgr):
    b = cv2.GaussianBlur(bgr, (0, 0), 2.0).astype(np.float32) / 255.0
    hsv = cv2.cvtColor(b, cv2.COLOR_BGR2HSV)
    H, Sa, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    sky = (((H > 185) & (H < 268) & (Sa > 0.09)) | ((V > 0.66) & (Sa < 0.22)))
    m = (~sky).astype(np.uint8)
    k = max(5, (min(bgr.shape[:2]) // 45) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((max(3, k // 2) | 1,) * 2, np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n < 2:
        return m
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    out = (lab == i).astype(np.uint8)
    nb, lb, _sb, _ = cv2.connectedComponentsWithStats(1 - out, 8)
    border = set(lb[0, :]) | set(lb[-1, :]) | set(lb[:, 0]) | set(lb[:, -1])
    for j in range(1, nb):
        if j not in border:
            out[lb == j] = 1
    return out

DESC = ['taper_rms', 'n_infl', 'visor', 'notch_y', 'edge_rms_l', 'edge_rms_r',
        'crown_ratio', 'rough_D', 'vert_break']


def _detrend_rms(v, ys):
    """RMS residual about a straight-line fit, in units of mean(v)."""
    if v.size < 12:
        return 0.0, None
    A = np.polyfit(ys, v, 1)
    res = v - np.polyval(A, ys)
    m = max(abs(v.mean()), 1e-6)
    return float(np.sqrt((res ** 2).mean()) / m), res / m


def biggest_object(bgr, box):
    """The land mass inside a pixel box. Returns (crop, obj) or None."""
    x0, y0, x1, y1 = box
    crop = bgr[y0:y1, x0:x1]
    m = subject_mask(crop)
    if m.sum() < 200:
        return None
    ys, xs = np.nonzero(m)
    ob = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    return crop, dict(mask=m, box=ob, area=int(m.sum()))


def describe_stack(bgr, box, frac=0.75):
    got = biggest_object(bgr, box)
    if got is None:
        return None
    crop, obj = got
    m, ob = obj['mask'], obj['box']
    ys, w, xl, xr = S.profile(m, ob)
    if w.size < 24:
        return None
    # Restrict to the lower `frac` of the object. The top of a real stack is a tree
    # canopy (kf_00450) or a vegetated crown, and a canopy silhouette is vegetation's
    # shape, not rock's -- leaving it in would credit the reference for a tree.
    keep = ys <= ys.min() + (ys.max() - ys.min()) * 1.0
    if frac < 1.0:
        y0r = ys.max() - (ys.max() - ys.min()) * frac
        keep = ys >= y0r
    ys, w, xl, xr = ys[keep], w[keep], xl[keep], xr[keep]
    if w.size < 24:
        return None
    d = {k: 0.0 for k in DESC}

    # S._smooth is a mode='same' box filter, so the first and last k/2 samples are
    # divided by the full window while only part of it is real data -- they collapse
    # toward zero and would show up as a huge fake excursion at both ends of every
    # profile. Trim them. (Caught by a cone scoring taper_rms 0.19 on a synthetic test.)
    ktr = max(5, w.size // 20) | 1
    tr = slice(ktr // 2 + 1, -(ktr // 2 + 1) or None)
    sm = S._smooth(w, ktr)[tr]
    ys_s, xl_s, xr_s = ys[tr], xl[tr], xr[tr]
    if sm.size < 20:
        return None
    h = float(ys_s.max() - ys_s.min() + 1)

    d['taper_rms'], res = _detrend_rms(sm, ys_s)

    # deep inflections in the detrended profile, per 100 px of height
    if res is not None:
        dr = np.diff(res)
        sgn = np.sign(dr); sgn = sgn[sgn != 0]
        flips = np.flatnonzero(np.diff(sgn) != 0)
        # keep only flips whose local excursion is real, not quantisation
        keep, hw = 0, max(6, int(res.size / 12))   # window scales with the object
        for f in flips:
            a = max(0, f - hw); b = min(res.size, f + hw + 1)
            if np.ptp(res[a:b]) > 0.02:
                keep += 1
        d['n_infl'] = float(keep / max(h, 1) * 100.0)

    # visor: a wider row ABOVE a narrower row, both in the lower 45% of the object.
    # rows are in image order, so "above" = smaller index.
    n = sm.size
    lo = int(n * 0.55)                       # index range covering the lower 45%
    best, bj = 0.0, 0
    for j in range(lo, n):                   # j = the waist (lower, narrower)
        a0 = max(lo - int(n * 0.30), 0)
        seg = sm[a0:j]
        if seg.size < 3 or sm[j] < 1e-6:
            continue
        v = seg.max() / sm[j] - 1.0
        if v > best:
            best, bj = v, j
    d['visor'] = float(best)
    d['notch_y'] = float(1.0 - bj / max(n - 1, 1))

    d['edge_rms_l'] = _detrend_rms(S._smooth(xl, ktr)[tr], ys_s)[0]
    d['edge_rms_r'] = _detrend_rms(S._smooth(xr, ktr)[tr], ys_s)[0]

    i10, i90 = int(n * 0.90), int(n * 0.10)  # image order: 90% index = 10% height
    d['crown_ratio'] = float(sm[i90] / max(sm[i10], 1e-6))

    d['rough_D'] = S.contour_roughness_D(m)
    d['vert_break'] = S.tonal_break(crop, m, ob)
    d['_box'] = [int(v) for v in ob]
    d['_area_frac'] = round(obj['area'] / (crop.shape[0] * crop.shape[1]), 4)
    d['_w'] = [round(float(v), 2) for v in sm[::max(1, n // 48)]]
    return d


def _load(p):
    im = cv2.imread(p, cv2.IMREAD_COLOR)
    if im is None:
        raise SystemExit('cannot read ' + p)
    return im


def run_case(name, refp, refbox, testp, testbox, frac=0.75):
    r = describe_stack(_load(refp), refbox, frac)
    t = describe_stack(_load(testp), testbox, frac)
    return dict(name=name, ref=r, test=t)


def print_table(cases):
    print(f"{'case':<12}{'descriptor':<13}{'REF':>9}{'RENDER':>9}{'delta':>9}")
    for c in cases:
        r, t = c['ref'], c['test']
        if r is None or t is None:
            print(f"{c['name']:<12}  -- no object segmented --")
            continue
        for k in DESC:
            print(f"{c['name']:<12}{k:<13}{r[k]:9.3f}{t[k]:9.3f}{t[k] - r[k]:+9.3f}")
        print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('img', nargs='?')
    ap.add_argument('--box')
    ap.add_argument('--pair', nargs=2, metavar=('REF', 'TEST'))
    ap.add_argument('--refbox'); ap.add_argument('--testbox')
    ap.add_argument('--spec', help='json: [{name,ref,refbox,test,testbox}, ...]')
    ap.add_argument('--shots', default=None, help='replace $SHOTS in a spec file')
    ap.add_argument('--frac', type=float, default=0.75)
    ap.add_argument('--json')
    a = ap.parse_args()
    os.chdir(ROOT)
    B = lambda s: [int(v) for v in s.split(',')]

    if a.spec:
        spec = json.load(open(a.spec))
        cases = []
        for c in spec:
            tp = c['test'].replace('$SHOTS', a.shots or 'shots/latest')
            cases.append(run_case(c['name'], c['ref'], c['refbox'], tp, c['testbox'], a.frac))
        print_table(cases)
        out = cases
    elif a.pair:
        out = [run_case('pair', a.pair[0], B(a.refbox), a.pair[1], B(a.testbox), a.frac)]
        print_table(out)
    else:
        out = describe_stack(_load(a.img), B(a.box), a.frac)
        print(json.dumps(out, indent=2))
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=2)


if __name__ == '__main__':
    main()
