#!/usr/bin/env python
"""
Visual fidelity metrics: measures how close a rendered frame is to a reference frame.

Axes (each scored independently so a /loop knows *which* one is failing):
  ssim        structural similarity            (higher better, 0..1)
  hist        color-histogram distance         (lower better, 0..1)  -> grade match
  lap         Laplacian variance ratio         (1.0 = identical detail density)
  edge        Canny edge-density ratio         (1.0 = identical geometric detail)
  lpips       learned perceptual distance      (lower better, 0..~1)
  sat/lum/... raw descriptive stats for both images

Usage:
  metrics.py ref.png test.png [--json out.json] [--tag name]
  metrics.py --stats img.png                  # descriptive stats only
  metrics.py --batch refdir testdir --json out.json
"""
import argparse, json, os, sys, glob
import numpy as np
import cv2

_LPIPS = None


def _lpips_model():
    """lpips chatters on stdout at import/construct time; keep JSON output clean."""
    global _LPIPS
    if _LPIPS is None:
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            import torch, lpips
            dev = 'cuda' if torch.cuda.is_available() else 'cpu'
            m = lpips.LPIPS(net='alex', verbose=False).to(dev)
        _LPIPS = (m, dev, torch)
    return _LPIPS


def load(path, size=None):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f'cannot read {path}')
    if size is not None and (img.shape[1], img.shape[0]) != size:
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    return img


def stats(bgr):
    """Descriptive statistics of a single image."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gf = g.astype(np.float32) / 255.0
    lap = cv2.Laplacian(g, cv2.CV_64F)
    edges = cv2.Canny(g, 60, 160)
    # tonal distribution
    hist = cv2.calcHist([g], [0], None, [256], [0, 256]).ravel()
    hist /= hist.sum()
    cdf = np.cumsum(hist)
    def pct(p):
        return int(np.searchsorted(cdf, p))
    # local contrast (std of 8x8 blocks means)
    h, w = g.shape
    bs = 16
    blocks = gf[:h // bs * bs, :w // bs * bs].reshape(h // bs, bs, w // bs, bs)
    bmean = blocks.mean(axis=(1, 3))
    return dict(
        lum_mean=float(g.mean()), lum_std=float(g.std()),
        p01=pct(0.01), p50=pct(0.50), p99=pct(0.99),
        shadow_frac=float((g < 32).mean()), highlight_frac=float((g > 224).mean()),
        sat_mean=float(hsv[:, :, 1].mean()), sat_std=float(hsv[:, :, 1].std()),
        lab_a=float(lab[:, :, 1].mean() - 128.0), lab_b=float(lab[:, :, 2].mean() - 128.0),
        lap_var=float(lap.var()),
        edge_density=float((edges > 0).mean()),
        local_contrast=float(bmean.std()),
        rgb_mean=[float(bgr[:, :, 2].mean()), float(bgr[:, :, 1].mean()), float(bgr[:, :, 0].mean())],
    )


def hist_distance(a, b, bins=32):
    """Bhattacharyya distance over a joint 3D HSV histogram. 0 = identical grade.

    LEGACY. Kept because five waves of history are recorded against it, but do not
    band it — it is a near-binary detector, not a grade measure. Measured on the
    reference frames themselves (reports/metrics.md 4a): a **2 degree** hue rotation
    of a frame scores 0.278 against itself, which is already worse than the 0.234 two
    genuinely different keyframes of the clip score against each other. The cause is
    hard 3D bin edges: 32 hue bins over 180 degrees is 5.6 deg/bin, so a hue shift
    smaller than one bin moves most of the mass across an edge and the Bhattacharyya
    overlap collapses. Use `hist_smooth` for anything that is scored.
    """
    ha = cv2.calcHist([cv2.cvtColor(a, cv2.COLOR_BGR2HSV)], [0, 1, 2], None, [bins] * 3, [0, 180, 0, 256, 0, 256])
    hb = cv2.calcHist([cv2.cvtColor(b, cv2.COLOR_BGR2HSV)], [0, 1, 2], None, [bins] * 3, [0, 180, 0, 256, 0, 256])
    cv2.normalize(ha, ha); cv2.normalize(hb, hb)
    return float(cv2.compareHist(ha, hb, cv2.HISTCMP_BHATTACHARYYA))


def hist_smooth(a, b, bins=32, sig=1.0):
    """`hist_distance` with the joint histogram smoothed by one bin before comparison
    (hue axis wrapped). This is what makes it continuous in small grade changes instead
    of quantisation-limited, and it is the axis `grade` is banded against.

    Validated on a deliberate degradation ladder applied to the reference itself
    (reports/metrics.md 4a): monotone in hue rotation, saturation scale and gamma, and
    it ranks an invisible 2 deg hue shift *below* the clip's own frame-to-frame
    variation, which the unsmoothed form gets backwards.
    """
    from scipy.ndimage import gaussian_filter
    out = []
    for img in (a, b):
        h = cv2.calcHist([cv2.cvtColor(img, cv2.COLOR_BGR2HSV)], [0, 1, 2], None,
                         [bins] * 3, [0, 180, 0, 256, 0, 256])
        h = gaussian_filter(h, sigma=sig, mode=('wrap', 'nearest', 'nearest'))
        out.append(h / (h.sum() + 1e-12))
    bc = float(np.sum(np.sqrt(out[0] * out[1])))
    return float(np.sqrt(max(0.0, 1.0 - bc)))


def ssim_score(a, b):
    from skimage.metrics import structural_similarity
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    s, _ = structural_similarity(ga, gb, full=True, gaussian_weights=True, sigma=1.5, data_range=255)
    return float(s)


def ms_ssim(a, b, levels=4):
    """Multi-scale SSIM - far more meaningful than single-scale for whole scenes."""
    from skimage.metrics import structural_similarity
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float64)
    gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float64)
    vals = []
    for i in range(levels):
        if min(ga.shape) < 32:
            break
        vals.append(structural_similarity(ga, gb, gaussian_weights=True, sigma=1.5, data_range=255))
        ga = cv2.pyrDown(ga); gb = cv2.pyrDown(gb)
    return float(np.mean(vals))


def gms_map(a, b, T=170.0):
    """Gradient Magnitude Similarity map (Xue et al. 2014), 0..1 per pixel, 1 = identical
    local gradient. Prewitt gradients after the paper's 2x average-pool prefilter."""
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float64)
    gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float64)
    ga = cv2.resize(ga, (ga.shape[1] // 2, ga.shape[0] // 2), interpolation=cv2.INTER_AREA)
    gb = cv2.resize(gb, (gb.shape[1] // 2, gb.shape[0] // 2), interpolation=cv2.INTER_AREA)
    hx = np.array([[1, 0, -1], [1, 0, -1], [1, 0, -1]], np.float64) / 3.0
    def mag(g):
        return np.sqrt(cv2.filter2D(g, -1, hx) ** 2 + cv2.filter2D(g, -1, hx.T) ** 2)
    ma, mb = mag(ga), mag(gb)
    return (2 * ma * mb + T) / (ma ** 2 + mb ** 2 + T)


def gms_distance(a, b):
    """1 - mean(GMS). 0 = identical. **This is what `structure` is banded against.**

    MS-SSIM is not usable as a structure measure at this project's operating point, and
    the proof is short (reports/metrics.md 9). Scored against the 9 reference keyframes:

        FLAT grey rectangle, ref mean luminance   1-MS_SSIM = 0.495   GMSM = 0.294
        the earliest untextured build             1-MS_SSIM = 0.510   GMSM = 0.285
        the real game vs its own next keyframe    1-MS_SSIM = 0.446   GMSM = 0.165
        our current head                          1-MS_SSIM = 0.686   GMSM = 0.248

    A flat grey rectangle beats every render this project has ever produced on MS-SSIM,
    and beats the `good` anchor (0.524) taken from the real game's own adjacent frames.
    The cause is SSIM's structure term s = (sxy + C3) / (sx*sy + C3): as the test frame's
    local variance goes to zero it tends to C3/C3 = 1, so a frame with no structure scores
    full marks for structure it does not have. Gaussian-blurring our own render raised the
    banded `structure` axis monotonically 17.4 -> 22.1 -> 28.6 -> 39.9 -> 57.6 -> 75.0 at
    kernel 0/3/7/15/31/61 - about +14 composite points for destroying the image.

    GMS has no such term: where the reference has gradient and the test has none,
    (2*ma*0 + T)/(ma^2 + 0 + T) -> T/(ma^2+T) -> 0. It ranks the flat frame and the
    untextured build LAST, which is where they belong. Variance-weighted SSIM pooling was
    tried first and does not fix it - the fault is in the term's value, not the pooling.

    `ms_ssim` is still computed and still in `raw`, unbanded, so every run recorded before
    2026-07-31 stays readable and `score_legacy` still reproduces its original number.
    """
    return float(1.0 - gms_map(a, b).mean())


def lpips_score(a, b):
    try:
        m, dev, torch = _lpips_model()
    except Exception as e:
        return None
    def prep(x):
        x = cv2.cvtColor(x, cv2.COLOR_BGR2RGB).astype(np.float32) / 127.5 - 1.0
        return torch.from_numpy(x).permute(2, 0, 1)[None].to(dev)
    with torch.no_grad():
        return float(m(prep(a), prep(b)).item())


def gradient_hist_distance(a, b, bins=36):
    """Distribution of edge orientations - proxy for 'does the geometry feel alike'."""
    out = []
    for img in (a, b):
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
        mag = np.sqrt(gx * gx + gy * gy)
        ang = (np.arctan2(gy, gx) % np.pi) / np.pi
        h, _ = np.histogram(ang, bins=bins, range=(0, 1), weights=mag)
        h = h / (h.sum() + 1e-9)
        out.append(h)
    bc = float(np.sum(np.sqrt(np.maximum(out[0] * out[1], 0.0))))
    return float(np.sqrt(max(0.0, 1.0 - bc)))


def spectral_slope(bgr):
    """log-log slope of the radially averaged power spectrum.
    Natural/photoreal images sit near -2. Flat CG (untextured, no grain) is steeper/noisier."""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    g = g - g.mean()
    win = np.outer(np.hanning(g.shape[0]), np.hanning(g.shape[1]))
    F = np.fft.fftshift(np.abs(np.fft.fft2(g * win)) ** 2)
    cy, cx = np.array(F.shape) // 2
    y, x = np.indices(F.shape)
    r = np.sqrt((y - cy) ** 2 + (x - cx) ** 2).astype(int)
    nmax = min(cy, cx)
    tbin = np.bincount(r.ravel(), F.ravel())[:nmax]
    nr = np.bincount(r.ravel())[:nmax]
    prof = tbin / np.maximum(nr, 1)
    k = np.arange(1, nmax)
    p = prof[1:]
    m = (k > 3) & (k < nmax * 0.8) & (p > 0)
    if m.sum() < 8:
        return 0.0
    slope = np.polyfit(np.log(k[m]), np.log(p[m]), 1)[0]
    return float(slope)


# ===========================================================================
#  Banding
# ===========================================================================
# Every axis reduces to a raw *distance* that is 0 when the two frames are
# identical and grows as they diverge. Turning that into 0..100 needs two
# anchors, and until 2026-07-31 all six pairs were hand-picked constants that
# had never been checked against anything. They were wrong, in both directions
# at once (reports/metrics.md 3):
#
#   axis        old band      measured good / null       what that did
#   structure   0.15  0.65      (metric replaced) demanded a match tighter than the
#                                                 reference achieves against its OWN
#                                                 next frame -> pinned at 0
#   perceptual  0.25  0.70      0.391 / 0.692     same fault -> pinned near 0
#   grade       0.25  0.75      0.084 / 0.446     `bad` landed on this project's own
#                                                 operating point -> 0.00 in every run
#                                                 ever recorded
#   detail      0.15  1.2       0.075 / 0.422     both anchors ~2x too loose
#   geometry    0.15  1.2       0.049 / 0.258     both anchors ~5x too loose
#   spectrum    0.15  1.0       0.016 / 0.088     both anchors ~9x too loose
#                                                 -> the last three pinned near 100
#
# CALIB below replaces them with measured ground truth. Two anchors per axis,
# both taken from the reference clip compared against ITSELF, so neither is a
# property of anything this engine renders (KNOWN_ISSUES 4):
#
#   good  = median over the 156 pairs of adjacent keyframes (kf_X vs kf_X+15).
#           "as close as the real game gets to its own next frame."  -> scores 90
#   null  = median over 91 pairs of keyframes at least 20 apart.
#           "no more related than two unrelated shots of Halo."      -> scores 10
#
# and map raw distance v through a soft band that is exactly 100 at v=0 and
# **never reaches 0 or 100 anywhere else**:
#
#       s(v) = 100 / (1 + (v / u50) ** p)
#       p    = ln(81) / ln(null / good)
#       u50  = good * 9 ** (1/p)
#
# The no-rails property is the point. The old linear band clipped, so 23 of the
# 54 axis readings on the current build sat at exactly 0 or exactly 100 with
# zero derivative — improvements at those poses were arithmetically incapable of
# moving the score. Regenerate with:  tools/metrics.py --calibrate ref/keyframes
#
# REGENERATED 2026-07-31 (second pass). The first pass's anchors were NOT reproducible
# by the command this file documented, and three of them disagreed with a direct
# measurement at the nine scored poses (perceptual `good` was shipped as 0.481 where the
# measurement is 0.392; geometry 0.021 vs 0.049). Two causes, both now fixed:
#   - `--calibrate` globbed `kf_*.png`, which swept up two 357x1018 `kf_*_sand.png` crops
#     another agent had saved into ref/keyframes. It now takes only `kf_<digits>.png` at
#     the modal resolution and says so.
#   - `structure` is now banded against `gmsm`, not `1 - ms_ssim`. See gms_distance():
#     a flat grey rectangle beat the `good` anchor on MS-SSIM, so the old structure band
#     was calibrated over a range whose "excellent" end is reached by rendering nothing.
# Everything below is the verbatim output of the documented command, on 157 keyframes /
# 156 adjacent pairs / 91 cross pairs. If it does not reproduce, trust the command.
#
# Bump BAND_VERSION whenever CALIB, WEIGHTS, or any axis's underlying raw metric changes.
# Scores from different band versions are different quantities that happen to share a name
# and a 0..100 range; `score.mjs --history` uses this to refuse to plot them as one series.
#   1 = 2026-07-31 first pass  (structure = 1 - MS_SSIM; good anchors not reproducible)
#   2 = 2026-07-31 second pass (structure = GMSM; anchors regenerated by --calibrate)
BAND_VERSION = 2

CALIB = {
    'structure':  dict(good=0.18411, null=0.26578, u50=0.22121, p=11.9690),
    'grade':      dict(good=0.08404, null=0.44554, u50=0.19351, p=2.6346),
    'perceptual': dict(good=0.39080, null=0.69240, u50=0.52018, p=7.6830),
    'detail':     dict(good=0.07518, null=0.42218, u50=0.17815, p=2.5467),
    'geometry':   dict(good=0.04907, null=0.25820, u50=0.11256, p=2.6465),
    'spectrum':   dict(good=0.01607, null=0.08823, u50=0.03765, p=2.5803),
}

# Comparative axes carry 0.70. structure/grade/perceptual are the only three that
# can tell whether we rendered *Halo*; detail/geometry/spectrum only say whether we
# rendered something with plausible texture statistics, and the reference scores
# 79/88/98 on them against completely unrelated shots of itself. A run must not be
# able to gain composite points on texture alone.
WEIGHTS = dict(structure=0.25, grade=0.22, perceptual=0.23,
               detail=0.12, geometry=0.10, spectrum=0.08)
COMPARATIVE = ('structure', 'grade', 'perceptual')

# The pre-2026-07-31 bands and weights, verbatim. Every score in scores/history.jsonl
# was produced by these; they are kept so old runs stay readable and so a re-band can
# be shown against them rather than silently replacing them.
LEGACY_BANDS = dict(structure=(0.15, 0.65), grade=(0.25, 0.75), perceptual=(0.25, 0.70),
                    detail=(0.15, 1.2), geometry=(0.15, 1.2), spectrum=(0.15, 1.0))
LEGACY_WEIGHTS = dict(structure=0.22, grade=0.20, perceptual=0.26,
                      detail=0.12, geometry=0.12, spectrum=0.08)
# Where a legacy axis was banded against a *different* raw number than the current axis is.
LEGACY_DIST = {
    'grade':     lambda res, v: res['hist'],           # unsmoothed, near-binary
    'structure': lambda res, v: 1.0 - res['ms_ssim'],  # winnable by rendering nothing
}


def soft_band(v, cal):
    """Raw distance -> 0..100. Exactly 100 at v=0, asymptotic to 0, never clipped."""
    return 100.0 / (1.0 + (max(float(v), 0.0) / cal['u50']) ** cal['p'])


def progress(v, cal):
    """Raw distance -> signed linear percentage. THIS is the number to tune against.

      0   = no closer to the reference than an unrelated shot of the real game
      100 = as close as the real game's own adjacent frames
      <0  = further away than an unrelated shot

    Linear in the raw metric, so its derivative is constant and every unit of real
    improvement shows up as the same number of points wherever you happen to be.
    Unbounded on purpose: an axis that is 60 points beyond the null needs to say so.
    """
    return 100.0 * (cal['null'] - float(v)) / (cal['null'] - cal['good'])


def legacy_band(v, good, bad):
    return float(np.clip((bad - v) / (bad - good), 0, 1))


def axis_distances(res):
    """The six raw distances the axes are computed from. 0 = identical."""
    return {
        'structure':  res['gmsm'],
        'grade':      res['hist_smooth'],
        'perceptual': res['lpips'],
        'detail':     abs(np.log(max(res['lap_ratio'], 1e-3))),
        'geometry':   abs(np.log(max(res['edge_ratio'], 1e-3))),
        'spectrum':   abs(res['spectral_slope_test'] - res['spectral_slope_ref']),
    }


def compare(ref_path, test_path, tag=None):
    ref = load(ref_path)
    test = load(test_path, size=(ref.shape[1], ref.shape[0]))
    sr, st = stats(ref), stats(test)
    lap_ratio = st['lap_var'] / max(sr['lap_var'], 1e-6)
    edge_ratio = st['edge_density'] / max(sr['edge_density'], 1e-6)
    warnings = []
    lp = lpips_score(ref, test)
    if lp is None:
        # Never substitute a default here. The old code silently used 0.6, which bands
        # to perceptual=22.2 - higher than any value this project has ever genuinely
        # scored - so a broken torch install reported *better* than a working one and
        # nothing in the output said so. See reports/metrics.md 1a.
        warnings.append('lpips unavailable: perceptual axis is null, not zero. '
                        'Check torch/lpips import (a stray profile.py on sys.path will do it).')
    res = dict(
        tag=tag or os.path.basename(test_path),
        ref=os.path.basename(ref_path), test=os.path.basename(test_path),
        ssim=ssim_score(ref, test),
        ms_ssim=ms_ssim(ref, test),             # legacy, unbanded - see gms_distance()
        gmsm=gms_distance(ref, test),           # what `structure` is banded against
        hist=hist_distance(ref, test),          # legacy, unbanded - see hist_distance()
        hist_smooth=hist_smooth(ref, test),     # what `grade` is banded against
        grad_hist=gradient_hist_distance(ref, test),
        lap_ratio=lap_ratio,
        edge_ratio=edge_ratio,
        lpips=lp,
        spectral_slope_ref=spectral_slope(ref),
        spectral_slope_test=spectral_slope(test),
        ref_stats=sr, test_stats=st,
    )

    dist = axis_distances(res)
    res['raw'] = {k: (None if v is None else round(float(v), 6)) for k, v in dist.items()}
    res['raw'].update(ms_ssim=round(res['ms_ssim'], 6), ssim=round(res['ssim'], 6),
                      gmsm=round(res['gmsm'], 6),
                      hist=round(res['hist'], 6), hist_smooth=round(res['hist_smooth'], 6),
                      grad_hist=round(res['grad_hist'], 6),
                      lpips=None if lp is None else round(lp, 6),
                      lap_ratio=round(lap_ratio, 6), edge_ratio=round(edge_ratio, 6),
                      spectral_slope_ref=round(res['spectral_slope_ref'], 6),
                      spectral_slope_test=round(res['spectral_slope_test'], 6))

    axes, prog, legacy = {}, {}, {}
    for k, cal in CALIB.items():
        v = dist[k]
        if v is None:
            axes[k] = None; prog[k] = None; legacy[k] = None
            continue
        axes[k] = round(soft_band(v, cal), 2)
        prog[k] = round(progress(v, cal), 2)
        g, b = LEGACY_BANDS[k]
        # The legacy axes read different underlying numbers: `grade` the unsmoothed hist,
        # `structure` 1-MS_SSIM. Both were replaced (hist_smooth, gmsm) because the old
        # ones were measured to be unfit, but score_legacy must keep reproducing the
        # numbers in scores/history.jsonl exactly, so it still reads the originals.
        lv = LEGACY_DIST.get(k, lambda r, v: v)(res, v)
        legacy[k] = round(legacy_band(lv, g, b) * 100, 2)

    res['axes'] = axes
    res['progress'] = prog
    res['axes_legacy'] = legacy
    live = [k for k in CALIB if axes[k] is not None]
    wsum = sum(WEIGHTS[k] for k in live) or 1.0
    res['score'] = round(sum(axes[k] * WEIGHTS[k] for k in live) / wsum, 2)
    csum = sum(WEIGHTS[k] for k in COMPARATIVE if axes[k] is not None) or 1.0
    res['score_comparative'] = round(
        sum(axes[k] * WEIGHTS[k] for k in COMPARATIVE if axes[k] is not None) / csum, 2)
    # Tamper check. The weighted GEOMETRIC mean of the same axes: it collapses if any
    # single axis is near zero, so it cannot be raised by improving five axes while
    # destroying the sixth. Measured on a reference frame hue-rotated 30 degrees - the
    # right image, the wrong colour - `score` gives 77.7 and `score_geometric` gives
    # 36.1. It is NOT the headline number, because being dominated by the worst axis
    # would steer the loop at `grade`, which reports/blind.md ranks last of eleven
    # things worth fixing. Read it as a guard: if `score` rises and this does not, the
    # gain came from axes that were already the strong ones.
    res['score_geometric'] = round(float(np.exp(
        sum(WEIGHTS[k] * np.log(max(axes[k], 1e-2)) for k in live) / wsum)), 2)
    lsum = sum(LEGACY_WEIGHTS[k] for k in live) or 1.0
    res['score_legacy'] = round(sum(legacy[k] * LEGACY_WEIGHTS[k] for k in live) / lsum, 2)
    res['band_version'] = BAND_VERSION
    res['warnings'] = warnings
    return res


def calibrate(kfdir, near=15, min_gap=20, n_cross=91, seed=20260731):
    """Re-measure the CALIB anchors from the reference clip alone.

    `good` = median over adjacent-keyframe pairs, `null` = median over pairs at least
    `min_gap` keyframes apart. Both are properties of the reference footage only, so
    this is not the circular calibration of KNOWN_ISSUES 4 — no render is involved.
    Prints a CALIB block that can be pasted straight back into this file.
    """
    import random, re
    # Only `kf_<digits>.png`, and only at the modal resolution. `ref/keyframes/` is a
    # shared directory: agents drop crops and working images into it (on 2026-07-30 two
    # 357x1018 `kf_*_sand.png` crops appeared there), and a plain `kf_*.png` glob silently
    # folds them into the "adjacent keyframe" set, which is the thing that defines what
    # "good" means for every axis. Anchors must not move because someone saved a crop.
    allf = sorted(glob.glob(os.path.join(kfdir, 'kf_*.png')))
    kfs = [k for k in allf if re.fullmatch(r'kf_\d+\.png', os.path.basename(k))]
    shapes = {}
    for k in kfs:
        im = cv2.imread(k, cv2.IMREAD_COLOR)
        shapes.setdefault(im.shape[:2], []).append(k)
    modal = max(shapes, key=lambda s: len(shapes[s]))
    kept = set(shapes[modal])
    dropped = [k for k in allf if k not in kept]
    if dropped:
        sys.stderr.write(f'[calibrate] ignoring {len(dropped)} non-keyframe file(s) in {kfdir}: '
                         + ', '.join(os.path.basename(d) for d in dropped[:6])
                         + (' ...' if len(dropped) > 6 else '') + '\n')
    kfs = [k for k in kfs if k in kept]
    sys.stderr.write(f'[calibrate] {len(kfs)} keyframes at {modal[1]}x{modal[0]}\n')
    if len(kfs) < min_gap + 2:
        raise SystemExit(f'need more keyframes in {kfdir}')
    idx = {os.path.basename(k): i for i, k in enumerate(kfs)}
    step = None
    nums = [int(re.search(r'kf_(\d+)', os.path.basename(k)).group(1)) for k in kfs]
    if len(nums) > 1:
        step = nums[1] - nums[0]

    def dists(pairs):
        out = []
        for pa, pb in pairs:
            r = compare(pa, pb)
            d = axis_distances(r)
            d['_lpips_ok'] = r['lpips'] is not None
            out.append(d)
        return out

    npairs = [(kfs[i], kfs[i + 1]) for i in range(len(kfs) - 1)]
    rng = random.Random(seed)
    seen, xpairs = set(), []
    while len(xpairs) < n_cross:
        i, j = rng.randrange(len(kfs)), rng.randrange(len(kfs))
        if abs(i - j) < min_gap or (i, j) in seen:
            continue
        seen.add((i, j)); xpairs.append((kfs[i], kfs[j]))

    sys.stderr.write(f'[calibrate] {len(npairs)} adjacent pairs (step {step}), {len(xpairs)} cross pairs\n')
    nd, xd = dists(npairs), dists(xpairs)
    if not all(r['_lpips_ok'] for r in nd + xd):
        raise SystemExit('lpips unavailable - refusing to calibrate the perceptual axis '
                         'from a null. Fix the torch import first.')
    cal = {}
    for k in CALIB:
        good = float(np.median([r[k] for r in nd]))
        null = float(np.median([r[k] for r in xd]))
        p = float(np.log(81.0) / np.log(null / good))
        cal[k] = dict(good=round(good, 5), null=round(null, 5),
                      u50=round(good * 9.0 ** (1.0 / p), 5), p=round(p, 4))
    sys.stderr.write('\nCALIB = {\n')
    for k, c in cal.items():
        key = "'%s':" % k
        sys.stderr.write(f"    {key:<14}dict(good={c['good']}, null={c['null']}, "
                         f"u50={c['u50']}, p={c['p']}),\n")
    sys.stderr.write('}\n')
    return {'n_near': len(nd), 'n_cross': len(xd), 'keyframe_step': step, 'CALIB': cal}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a', nargs='?'); ap.add_argument('b', nargs='?')
    ap.add_argument('--stats', help='descriptive stats for one image')
    ap.add_argument('--batch', nargs=2, metavar=('REFGLOB', 'TESTDIR'))
    ap.add_argument('--calibrate', metavar='KEYFRAMEDIR',
                    help='re-measure the axis anchors from the reference clip and print a CALIB block')
    ap.add_argument('--json'); ap.add_argument('--tag')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    if a.calibrate:
        out = calibrate(a.calibrate)
    elif a.stats:
        out = {'file': a.stats, **stats(load(a.stats)), 'spectral_slope': spectral_slope(load(a.stats))}
    elif a.batch:
        refs = sorted(glob.glob(a.batch[0]))
        rows = []
        for r in refs:
            t = os.path.join(a.batch[1], os.path.basename(r))
            if os.path.exists(t):
                rows.append(compare(r, t))

        def am(field, k):
            vals = [r[field][k] for r in rows if r[field].get(k) is not None]
            return round(float(np.mean(vals)), 2) if vals else None
        out = {'n': len(rows),
               'score': round(float(np.mean([r['score'] for r in rows])), 2) if rows else 0,
               'score_comparative': round(float(np.mean([r['score_comparative'] for r in rows])), 2) if rows else 0,
               'score_geometric': round(float(np.mean([r['score_geometric'] for r in rows])), 2) if rows else 0,
               'score_legacy': round(float(np.mean([r['score_legacy'] for r in rows])), 2) if rows else 0,
               'axes': {k: am('axes', k) for k in CALIB} if rows else {},
               'progress': {k: am('progress', k) for k in CALIB} if rows else {},
               'axes_legacy': {k: am('axes_legacy', k) for k in CALIB} if rows else {},
               'rows': rows}
    else:
        out = compare(a.a, a.b, a.tag)

    txt = json.dumps(out, indent=2)
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        with open(a.json, 'w') as f:
            f.write(txt)
    if not a.quiet:
        print(txt)


if __name__ == '__main__':
    main()
