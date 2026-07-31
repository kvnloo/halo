#!/usr/bin/env python
"""
SCATTER — distribution instrument. Answers "is this a population or a pattern?"

Motivation: blind.md T2 decided 5 of 9 pairs on "identical cobbles at one size mode with
constant spacing". No mean catches a size distribution. Two shingle fields with the same
lum_mean, lap_var and edge_density can be a natural power-law beach or a regular grid of
clones, and the loop scored them the same.

Method: detect the discrete elements in a region (cobbles, stones, debris) as blobs,
then describe the POPULATION:

  n_per_kpx      element count per 1000 px^2 — density, not coverage
  size_cv        coefficient of variation of blob area. One size mode -> low.
  size_p90_p50   90th / 50th percentile area. Real shingle has boulders; a clone
                 field does not. Power-law -> large ratio.
  size_slope     ML slope of the complementary CDF of area on log-log axes. A
                 power-law population gives a straight line with slope ~-1..-2;
                 a single-mode population gives a cliff.
  modality       fraction of total area held by the single most populous octave bin.
                 1.0 = every stone is the same size.
  nn_cv          coefficient of variation of nearest-neighbour distance. Poisson
                 scatter -> ~0.52. A regular lattice -> ~0. Clustered -> >0.6.
  clark_evans    mean NN distance / expected-under-Poisson. <1 clustered,
                 =1 random, >1 regular/over-dispersed. Constant spacing -> >1.
  tile_peak      strongest off-origin peak of the region's normalised
                 autocorrelation, ignoring a small central exclusion. A visibly
                 tiling texture spikes here; a natural surface does not.
  tile_period    the lag (px) of that peak, so you can see WHAT is repeating.
  aniso          elongation of the mean blob (ellipse axis ratio) — ellipsoidal
                 blobs at one aspect are another clone tell.

Usage:
  tools/scatter.py <img.png> [--region sand] [--json out.json]
  tools/scatter.py --pair ref.png test.png [--region sand]
  tools/scatter.py --pair-pose 00000 [--region sand]
"""
import argparse, json, os, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import roi as roimod  # noqa: E402

FIELDS = ['n_per_kpx', 'size_cv', 'size_p90_p50', 'size_slope', 'modality',
          'nn_cv', 'clark_evans', 'tile_peak', 'tile_period', 'aniso']


# ----------------------------------------------------------------- detection
def blobs(bgr, min_area=24, max_area_frac=0.05):
    """Discrete elements = local luminance extrema separated from their surround.

    Uses a difference-of-Gaussians band-pass so a global brightness or wetness
    gradient across the region cannot create or destroy elements, followed by a
    watershed split so touching cobbles are counted as two and not one."""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lo = cv2.GaussianBlur(g, (0, 0), 2.0)
    hi = cv2.GaussianBlur(g, (0, 0), 14.0)
    dog = lo - hi
    s = dog.std()
    if s < 1e-6:
        return [], np.zeros(g.shape, np.int32)
    m = (dog > 0.6 * s).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # split touching elements
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    _, sure = cv2.threshold(dist, 0.45 * dist.max(), 255, 0)
    sure = sure.astype(np.uint8)
    n, mk = cv2.connectedComponents(sure)
    mk = mk + 1
    unknown = cv2.subtract(m, sure // 255)
    mk[unknown == 1] = 0
    mk = cv2.watershed(cv2.cvtColor(g.astype(np.uint8), cv2.COLOR_GRAY2BGR), mk)

    out = []
    h, w = g.shape
    for i in range(2, mk.max() + 1):
        ys, xs = np.nonzero(mk == i)
        a = xs.size
        if a < min_area or a > max_area_frac * h * w:
            continue
        cx, cy = xs.mean(), ys.mean()
        # second moments -> axis ratio
        if a >= 12:
            c = np.cov(np.vstack([xs - cx, ys - cy]))
            ev = np.linalg.eigvalsh(c)
            ar = float(np.sqrt(max(ev[1], 1e-9) / max(ev[0], 1e-9)))
        else:
            ar = 1.0
        out.append((cx, cy, float(a), ar))
    return out, mk


# ---------------------------------------------------------------- statistics
def ccdf_slope(areas):
    """ML power-law exponent over the upper half of the size range (Clauset-style,
    xmin fixed at the median so the estimate is comparable between images)."""
    a = np.asarray(areas, float)
    xmin = np.median(a)
    tail = a[a >= xmin]
    if tail.size < 12:
        return 0.0
    alpha = 1.0 + tail.size / np.sum(np.log(tail / xmin))
    return float(-(alpha - 1.0))          # CCDF slope


def nn_stats(pts, area_px):
    p = np.asarray([(x, y) for x, y, _, _ in pts], float)
    if len(p) < 8:
        return 0.0, 0.0
    d2 = ((p[:, None, :] - p[None, :, :]) ** 2).sum(-1)
    np.fill_diagonal(d2, np.inf)
    nn = np.sqrt(d2.min(1))
    lam = len(p) / max(area_px, 1.0)
    expected = 0.5 / np.sqrt(lam)         # Clark & Evans, 2D Poisson
    return float(nn.std() / max(nn.mean(), 1e-9)), float(nn.mean() / max(expected, 1e-9))


def autocorr_peak(bgr, exclude=8):
    """Normalised autocorrelation of the band-passed region. A visibly tiling texture
    produces an off-origin peak; a natural surface decays to noise."""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = g - cv2.GaussianBlur(g, (0, 0), 12.0)
    g = g * np.outer(np.hanning(g.shape[0]), np.hanning(g.shape[1]))
    F = np.fft.fft2(g)
    ac = np.real(np.fft.ifft2(F * np.conj(F)))
    ac = np.fft.fftshift(ac)
    ac /= max(ac.max(), 1e-9)
    cy, cx = np.array(ac.shape) // 2
    y, x = np.indices(ac.shape)
    r = np.sqrt((y - cy) ** 2 + (x - cx) ** 2)
    mask = r > exclude
    lim = min(cy, cx) * 0.8
    mask &= r < lim
    if not mask.any():
        return 0.0, 0.0
    i = np.argmax(np.where(mask, ac, -1))
    return float(ac.ravel()[i]), float(r.ravel()[i])


def analyse(path, region=None, box=None):
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit('cannot read ' + path)
    if region:
        bgr = roimod.crop(bgr, roimod.REGIONS[region])
    elif box:
        h, w = bgr.shape[:2]
        x0, y0, x1, y1 = box
        bgr = bgr[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
    h, w = bgr.shape[:2]
    pts, _ = blobs(bgr)
    d = {k: 0.0 for k in FIELDS}
    d['n_per_kpx'] = round(len(pts) / (h * w / 1000.0), 4)
    if len(pts) >= 12:
        a = np.array([p[2] for p in pts])
        d['size_cv'] = round(float(a.std() / max(a.mean(), 1e-9)), 4)
        d['size_p90_p50'] = round(float(np.percentile(a, 90) / max(np.median(a), 1e-9)), 4)
        d['size_slope'] = round(ccdf_slope(a), 4)
        oct_bins = np.floor(np.log2(np.maximum(a, 1.0))).astype(int)
        tot = a.sum()
        d['modality'] = round(float(max(a[oct_bins == b].sum() for b in np.unique(oct_bins)) / max(tot, 1e-9)), 4)
        cv_, ce = nn_stats(pts, h * w)
        d['nn_cv'] = round(cv_, 4)
        d['clark_evans'] = round(ce, 4)
        d['aniso'] = round(float(np.median([p[3] for p in pts])), 4)
    pk, per = autocorr_peak(bgr)
    d['tile_peak'] = round(pk, 4)
    d['tile_period'] = round(per, 1)
    d['n_blobs'] = len(pts)
    d['region_px'] = [w, h]
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('img', nargs='?')
    ap.add_argument('--pair', nargs=2, metavar=('REF', 'TEST'))
    ap.add_argument('--pair-pose')
    ap.add_argument('--shots', default='shots/blindcap')
    ap.add_argument('--region', default='sand', choices=sorted(roimod.REGIONS) + ['full'])
    ap.add_argument('--box')
    ap.add_argument('--json')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()
    os.chdir(ROOT)
    reg = None if a.region == 'full' else a.region
    box = tuple(float(v) for v in a.box.split(',')) if a.box else None

    if a.pair_pose:
        a.pair = [f'ref/keyframes/kf_{a.pair_pose}.png', f'{a.shots}/ref_{a.pair_pose}.png']
    if a.pair:
        r = analyse(a.pair[0], reg, box); t = analyse(a.pair[1], reg, box)
        out = dict(region=a.region, ref=r, test=t)
        if not a.quiet:
            print(f"region {a.region}   blobs: ref {r['n_blobs']}  render {t['n_blobs']}")
            print(f"{'field':<15}{'REF':>10}{'RENDER':>10}{'delta':>10}")
            for k in FIELDS:
                print(f'{k:<15}{r[k]:10.3f}{t[k]:10.3f}{t[k] - r[k]:+10.3f}')
    else:
        out = analyse(a.img, reg, box)
        if not a.quiet:
            print(json.dumps(out, indent=2))
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=2)


if __name__ == '__main__':
    main()
