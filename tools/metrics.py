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
    """Bhattacharyya distance over a joint 3D HSV histogram. 0 = identical grade."""
    ha = cv2.calcHist([cv2.cvtColor(a, cv2.COLOR_BGR2HSV)], [0, 1, 2], None, [bins] * 3, [0, 180, 0, 256, 0, 256])
    hb = cv2.calcHist([cv2.cvtColor(b, cv2.COLOR_BGR2HSV)], [0, 1, 2], None, [bins] * 3, [0, 180, 0, 256, 0, 256])
    cv2.normalize(ha, ha); cv2.normalize(hb, hb)
    return float(cv2.compareHist(ha, hb, cv2.HISTCMP_BHATTACHARYYA))


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


def compare(ref_path, test_path, tag=None):
    ref = load(ref_path)
    test = load(test_path, size=(ref.shape[1], ref.shape[0]))
    sr, st = stats(ref), stats(test)
    lap_ratio = st['lap_var'] / max(sr['lap_var'], 1e-6)
    edge_ratio = st['edge_density'] / max(sr['edge_density'], 1e-6)
    res = dict(
        tag=tag or os.path.basename(test_path),
        ref=os.path.basename(ref_path), test=os.path.basename(test_path),
        ssim=ssim_score(ref, test),
        ms_ssim=ms_ssim(ref, test),
        hist=hist_distance(ref, test),
        grad_hist=gradient_hist_distance(ref, test),
        lap_ratio=lap_ratio,
        edge_ratio=edge_ratio,
        lpips=lpips_score(ref, test),
        spectral_slope_ref=spectral_slope(ref),
        spectral_slope_test=spectral_slope(test),
        ref_stats=sr, test_stats=st,
    )
    # single headline number in 0..100 - weighted so no axis can be ignored
    def band(v, good, bad):
        return float(np.clip((bad - v) / (bad - good), 0, 1))
    parts = {
        'structure': band(1 - res['ms_ssim'], 0.15, 0.65),
        'grade': band(res['hist'], 0.25, 0.75),
        'perceptual': band(res['lpips'] if res['lpips'] is not None else 0.6, 0.25, 0.70),
        'detail': band(abs(np.log(max(lap_ratio, 1e-3))), 0.15, 1.2),
        'geometry': band(abs(np.log(max(edge_ratio, 1e-3))), 0.15, 1.2),
        'spectrum': band(abs(res['spectral_slope_test'] - res['spectral_slope_ref']), 0.15, 1.0),
    }
    res['axes'] = {k: round(v * 100, 2) for k, v in parts.items()}
    w = dict(structure=0.22, grade=0.20, perceptual=0.26, detail=0.12, geometry=0.12, spectrum=0.08)
    res['score'] = round(sum(parts[k] * w[k] for k in w) * 100, 2)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a', nargs='?'); ap.add_argument('b', nargs='?')
    ap.add_argument('--stats', help='descriptive stats for one image')
    ap.add_argument('--batch', nargs=2, metavar=('REFGLOB', 'TESTDIR'))
    ap.add_argument('--json'); ap.add_argument('--tag')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    if a.stats:
        out = {'file': a.stats, **stats(load(a.stats)), 'spectral_slope': spectral_slope(load(a.stats))}
    elif a.batch:
        refs = sorted(glob.glob(a.batch[0]))
        rows = []
        for r in refs:
            t = os.path.join(a.batch[1], os.path.basename(r))
            if os.path.exists(t):
                rows.append(compare(r, t))
        agg = {k: float(np.mean([r['axes'][k] for r in rows])) for k in rows[0]['axes']} if rows else {}
        out = {'n': len(rows), 'score': float(np.mean([r['score'] for r in rows])) if rows else 0,
               'axes': {k: round(v, 2) for k, v in agg.items()}, 'rows': rows}
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
