#!/usr/bin/env python
"""
NULLCHECK — negative controls for the scoring loop.

An instrument you have never fed a known-bad input is not an instrument, it is a
number generator. This feeds the loop's own metrics (`tools/metrics.py`,
`ref/roi_signatures.json`) a set of surrogates that are *guaranteed* to be wrong,
and reports what score they get.

The surrogates are chosen to preserve exactly the quantities the loop measures
while destroying everything it does not:

  phase      phase-randomised reference. Power spectrum is preserved BIT-EXACTLY,
             so spectral_slope is identical and lap_var/edge_density are close.
             Every object, edge and silhouette is gone.
  shuffleN   NxN block shuffle. Histogram is preserved exactly (grade), local
             statistics preserved inside each block, all global layout destroyed.
  mirror     the reference flipped horizontally. Every statistic identical to
             machine precision; the scene is the mirror world.
  wrongpose  a completely different keyframe of the same clip.
  noise      Gaussian noise matched to the reference per-channel mean and std.
  blur       heavy Gaussian blur — the one surrogate the detail axes SHOULD catch.

Any axis on which a surrogate scores near the real render is an axis that cannot
see the difference between our render and structured noise.

  tools/nullcheck.py --ref ref/keyframes/kf_00000.png \
                     --render shots/blindcap/ref_00000.png
  tools/nullcheck.py --all                       # every blind pose, summary table
  tools/nullcheck.py --roi                       # ROI-signature gate, same controls
"""
import argparse, json, os, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import metrics  # noqa: E402
import roi as roimod  # noqa: E402

RNG = np.random.default_rng(20260731)


# ------------------------------------------------------------------ surrogates
def surr_phase(img):
    """Randomise Fourier phase, keep magnitude. Power spectrum exactly preserved."""
    out = np.empty_like(img, dtype=np.float64)
    h, w = img.shape[:2]
    # one shared random phase field keeps channels registered (avoids colour confetti,
    # which would be caught by the grade axis for the wrong reason)
    ph = RNG.uniform(-np.pi, np.pi, (h, w))
    ph = (ph - ph[::-1, ::-1]) / 2.0  # antisymmetric -> real-valued result
    for c in range(3):
        F = np.fft.fft2(img[:, :, c].astype(np.float64))
        out[:, :, c] = np.real(np.fft.ifft2(np.abs(F) * np.exp(1j * ph)))
    # restore per-channel mean/std exactly (phase randomisation preserves them in
    # theory; float round-off drifts them by <0.1)
    for c in range(3):
        s = img[:, :, c].astype(np.float64)
        o = out[:, :, c]
        out[:, :, c] = (o - o.mean()) / (o.std() + 1e-9) * s.std() + s.mean()
    return np.clip(out, 0, 255).astype(np.uint8)


def surr_shuffle(img, bs):
    h, w = img.shape[:2]
    ny, nx = h // bs, w // bs
    crop = img[:ny * bs, :nx * bs]
    blocks = crop.reshape(ny, bs, nx, bs, 3).transpose(0, 2, 1, 3, 4).reshape(ny * nx, bs, bs, 3)
    idx = RNG.permutation(ny * nx)
    out = blocks[idx].reshape(ny, nx, bs, bs, 3).transpose(0, 2, 1, 3, 4).reshape(ny * bs, nx * bs, 3)
    full = img.copy()
    full[:ny * bs, :nx * bs] = out
    return full


def surr_noise(img):
    out = np.empty_like(img, dtype=np.float64)
    for c in range(3):
        s = img[:, :, c].astype(np.float64)
        out[:, :, c] = RNG.normal(s.mean(), s.std(), s.shape)
    return np.clip(out, 0, 255).astype(np.uint8)


def build_surrogates(ref, wrongpose=None):
    s = {
        'phase':      surr_phase(ref),
        'shuffle64':  surr_shuffle(ref, 64),
        'shuffle16':  surr_shuffle(ref, 16),
        'mirror':     ref[:, ::-1].copy(),
        'noise':      surr_noise(ref),
        'blur':       cv2.GaussianBlur(ref, (0, 0), 4.0),
    }
    if wrongpose is not None:
        s['wrongpose'] = cv2.resize(wrongpose, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)
    return s


# ------------------------------------------------------------------ evaluation
AXES = ['structure', 'grade', 'perceptual', 'detail', 'geometry', 'spectrum']
_TMP = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'nullcheck_pairs')


def eval_pair(ref, test, tag):
    """Score a surrogate with the LIVE scorer.

    This deliberately calls `metrics.compare` rather than reimplementing it. An audit
    tool that carries its own copy of the thing it audits goes stale the moment someone
    retunes the scorer — which happened during the session this file was written — and
    then it reports a clean bill of health for code that is no longer running."""
    os.makedirs(_TMP, exist_ok=True)
    ra = os.path.join(_TMP, 'ref.png')
    ta = os.path.join(_TMP, 'test.png')
    cv2.imwrite(ra, ref)
    cv2.imwrite(ta, test)
    res = metrics.compare(ra, ta, tag)
    res['axes'] = {k: res['axes'].get(k, 0.0) for k in AXES}
    return res


# ------------------------------------------------------- ROI signature gate
def roi_gate(img, sig, tol):
    """Reproduce the gate a critic applies: crop each named region, compute its
    stats, and count how many fall within `tol` relative error of the published
    signature. Returns (pass_fraction, per-region detail)."""
    keys = ['lum_mean', 'lum_std', 'sat_mean', 'lap_var', 'edge_density',
            'local_contrast', 'spectral_slope']
    rows, npass, ntot = {}, 0, 0
    for name, r in roimod.REGIONS.items():
        if name not in sig:
            continue
        c = roimod.crop(img, r)
        st = metrics.stats(c)
        st['spectral_slope'] = metrics.spectral_slope(c)
        d = {}
        for k in keys:
            want, got = sig[name][k], st[k]
            rel = abs(got - want) / max(abs(want), 1e-6)
            d[k] = round(rel, 3)
            ntot += 1
            npass += rel <= tol
        rows[name] = d
    return npass / max(ntot, 1), rows


# ------------------------------------------------------------------------ main
# ------------------------------------------- acceptance test for NEW instruments
def instrument_check(ref, cases, tmpdir):
    """An instrument is only worth having if it REJECTS these controls.

    Expected behaviour, and the reason each is here:
      phase / shuffle / noise  must move a shape or distribution descriptor a long
                               way — they contain no objects and no population.
      mirror                   must move it BARELY. Mirroring preserves shape, so a
                               shape instrument that reports a big delta on mirror is
                               measuring position, not form, and is lying to you.
      blur                     must move roughness/undercut (contours are smoothed).
    Reported as |delta| in units of the descriptor's own value on the reference."""
    import silhouette, scatter
    os.makedirs(tmpdir, exist_ok=True)

    def feats(img):
        p = os.path.join(tmpdir, 'x.png')
        cv2.imwrite(p, img)
        s = silhouette.analyse(p)['area_weighted']
        sc = scatter.analyse(p, region='sand')
        return ({'sil.' + k: s.get(k, 0.0) for k in silhouette.DESCRIPTORS}
                | {'sct.' + k: sc[k] for k in ('size_cv', 'size_slope', 'nn_cv',
                                               'clark_evans', 'tile_peak', 'modality')})

    base = feats(ref)
    rows = {}
    for name, img in cases.items():
        f = feats(img)
        rows[name] = {k: round(abs(f[k] - base[k]) / max(abs(base[k]), 1e-3), 2) for k in base}
    return base, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', default='ref/keyframes/kf_00000.png')
    ap.add_argument('--render', default='shots/blindcap/ref_00000.png')
    ap.add_argument('--wrong', default='ref/keyframes/kf_01500.png')
    ap.add_argument('--all', action='store_true', help='run every blind pose')
    ap.add_argument('--roi', action='store_true', help='also run the ROI-signature gate')
    ap.add_argument('--instruments', action='store_true',
                    help='acceptance-test the NEW shape/distribution instruments')
    ap.add_argument('--tol', type=float, default=0.25, help='ROI gate tolerance (rel err)')
    ap.add_argument('--json', help='write results here')
    a = ap.parse_args()
    os.chdir(ROOT)

    poses = ['00000', '00120', '00450', '00600', '00720', '00840', '01500', '01800', '02220'] \
        if a.all else [os.path.basename(a.ref).split('_')[1].split('.')[0]]

    allrows = {}
    for p in poses:
        refp = f'ref/keyframes/kf_{p}.png' if a.all else a.ref
        rndp = f'shots/blindcap/ref_{p}.png' if a.all else a.render
        if not (os.path.exists(refp) and os.path.exists(rndp)):
            continue
        ref = metrics.load(refp)
        rnd = metrics.load(rndp, size=(ref.shape[1], ref.shape[0]))
        wrong = metrics.load(a.wrong) if os.path.exists(a.wrong) else None
        if wrong is not None and os.path.basename(a.wrong) == os.path.basename(refp):
            wrong = metrics.load('ref/keyframes/kf_00600.png')

        cases = {'OUR RENDER': rnd, **build_surrogates(ref, wrong)}
        rows = {k: eval_pair(ref, v, k) for k, v in cases.items()}
        allrows[p] = rows

        print(f'\n=== pose {p} — ref {os.path.basename(refp)} ===')
        hdr = ['case', 'SCORE', 'struct', 'grade', 'percep', 'detail', 'geom', 'spect']
        print(' '.join([hdr[0].ljust(12)] + [h.rjust(7) for h in hdr[1:]]))
        for k, r in rows.items():
            print(' '.join([k.ljust(12), f"{r['score']:7.2f}"] +
                           [f"{r['axes'][x]:7.1f}" for x in
                            ['structure', 'grade', 'perceptual', 'detail', 'geometry', 'spectrum']]))

        if a.roi:
            sig = json.load(open('ref/roi_signatures.json'))
            print(f'\n  ROI-signature gate (tol {a.tol:.0%} relative, 7 stats x 10 regions):')
            for k, v in cases.items():
                frac, _ = roi_gate(v, sig, a.tol)
                print(f'    {k.ljust(12)} pass {frac:6.1%}')
            allrows[p]['_roi'] = {k: roi_gate(v, sig, a.tol)[0] for k, v in cases.items()}

        if a.instruments:
            tmp = os.environ.get('TMPDIR', '/tmp') + '/nullcheck_inst'
            base, ir = instrument_check(ref, cases, tmp)
            keys = list(base)
            print('\n  INSTRUMENT ACCEPTANCE — |delta| relative to the descriptor on the reference')
            print('  (want: LARGE for phase/shuffle/noise, ~0 for mirror)')
            print('  ' + 'case'.ljust(12) + ''.join(k.split('.')[-1][:8].rjust(9) for k in keys))
            for k in cases:
                print('  ' + k.ljust(12) + ''.join(f'{ir[k][f]:9.2f}' for f in keys))
            allrows[p]['_instruments'] = {'reference': base, 'delta': ir}

    if a.json:
        json.dump(allrows, open(a.json, 'w'), indent=2)
        print('\nwrote ' + a.json)


if __name__ == '__main__':
    main()
