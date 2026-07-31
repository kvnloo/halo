#!/usr/bin/env python
"""
DISCRIMINATE — the machine half of the blind test.

The blind A/B is the only instrument that has ever told this project the truth, and it
needs a judge. This does the part a judge is not needed for: it asks whether a *machine*
can tell our render from the reference, and by how much.

The trick is the null. Every feature is expressed in units of the reference clip's own
frame-to-frame variation: the same features are measured across N reference keyframes,
and a robust sigma (1.4826 x MAD) is taken per feature. Then

    z_i = | f_i(render, pose) - f_i(reference, pose) |  /  sigma_i(reference clip)

reads as "our render differs from this reference frame by z_i times as much as reference
frames differ from each other". A feature at z > 3 is one a machine can separate, which
means a human separates it instantly.

READ THIS BEFORE QUOTING THE NUMBER
  This instrument is ONE-WAY. A high z proves we would lose a blind pair. A low z proves
  nothing at all — it says only that these particular features did not catch us, and the
  reference frames themselves differ from each other in ways no feature here measures.
  Use it to fail fast, never to declare a pass.

  tools/discriminate.py --shots shots/blindcap
  tools/discriminate.py --shots shots/blindcap --pose ref_01500 --verbose
  tools/discriminate.py --rebuild-null           # recompute the calibration
"""
import argparse, json, os, sys, glob
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import metrics, silhouette, scatter  # noqa: E402

NULLFILE = 'scores/blind_null.json'


def features(path):
    """One flat feature vector per frame. Cheap enough to run on every pose every wave."""
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit('cannot read ' + path)
    f = {}
    st = metrics.stats(bgr)
    for k in ('lum_mean', 'lum_std', 'sat_mean', 'lab_a', 'lab_b', 'lap_var',
              'edge_density', 'local_contrast', 'shadow_frac', 'highlight_frac'):
        f['stat.' + k] = float(st[k])
    f['stat.spectral_slope'] = metrics.spectral_slope(bgr)

    sil = silhouette.analyse(path)
    for k in silhouette.DESCRIPTORS:
        f['sil.' + k] = float(sil['area_weighted'].get(k, 0.0))
    f['sil.n_objects'] = float(sil['n_objects'])
    f['sil.sky_frac'] = float(sil['sky_frac'])

    for reg in ('sand', 'shoreline'):
        sc = scatter.analyse(path, region=reg)
        for k in ('n_per_kpx', 'size_cv', 'size_slope', 'modality', 'nn_cv',
                  'clark_evans', 'tile_peak', 'aniso'):
            f[f'sct.{reg}.{k}'] = float(sc[k])
    return f


def build_null(stride=6, quiet=False):
    """Robust per-feature spread across the reference clip itself."""
    kfs = sorted(glob.glob(os.path.join(ROOT, 'ref/keyframes/kf_*.png')))[::stride]
    rows = []
    for i, p in enumerate(kfs):
        if not quiet:
            sys.stderr.write(f'\r[null] {i + 1}/{len(kfs)} {os.path.basename(p)}   ')
        rows.append(features(p))
    if not quiet:
        sys.stderr.write('\n')
    keys = sorted(rows[0])
    out = {}
    for k in keys:
        v = np.array([r[k] for r in rows], float)
        med = float(np.median(v))
        mad = float(np.median(np.abs(v - med)))
        sd = 1.4826 * mad
        if sd <= 0:                       # feature is constant across the clip
            sd = float(v.std()) or max(abs(med) * 0.02, 1e-3)
        out[k] = {'median': round(med, 6), 'sigma': round(sd, 6), 'n': len(v)}
    return out


def load_null(rebuild=False, stride=6):
    p = os.path.join(ROOT, NULLFILE)
    if rebuild or not os.path.exists(p):
        n = build_null(stride)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        json.dump({'stride': stride, 'features': n}, open(p, 'w'), indent=2)
        return n
    return json.load(open(p))['features']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', default='shots/blindcap')
    ap.add_argument('--pose')
    ap.add_argument('--rebuild-null', action='store_true')
    ap.add_argument('--stride', type=int, default=6)
    ap.add_argument('--top', type=int, default=10)
    ap.add_argument('--json')
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()
    os.chdir(ROOT)

    null = load_null(a.rebuild_null, a.stride)
    if a.rebuild_null and not a.pose and not os.path.isdir(a.shots):
        print(json.dumps({'ok': True, 'null_features': len(null)})); return

    shots = sorted(glob.glob(os.path.join(a.shots, 'ref_*.png')))
    if a.pose:
        shots = [s for s in shots if a.pose in s]
    if not shots:
        raise SystemExit('no ref_*.png in ' + a.shots)

    per_pose, zall = {}, {}
    for s in shots:
        pose = os.path.basename(s)[:-4]
        ref = f"ref/keyframes/kf_{pose.split('_')[1]}.png"
        if not os.path.exists(ref):
            continue
        fr, ft = features(ref), features(s)
        z = {}
        for k in fr:
            sd = null.get(k, {}).get('sigma')
            if not sd:
                continue
            z[k] = abs(ft[k] - fr[k]) / sd
        per_pose[pose] = z
        for k, v in z.items():
            zall.setdefault(k, []).append(v)

    rank = sorted(((float(np.median(v)), k) for k, v in zall.items()), reverse=True)
    maxz = {p: max(z.values()) for p, z in per_pose.items()}
    sep = float(np.median(list(maxz.values())))
    ndet = float(np.mean([sum(v > 3 for v in z.values()) for z in per_pose.values()]))

    out = {
        'shots': a.shots, 'n_poses': len(per_pose),
        'separability': round(sep, 2),
        'detectable_features_per_pose': round(ndet, 1),
        'total_features': len(zall),
        'verdict': ('machine separates every pair — a human will too' if sep > 6 else
                    'machine separates most pairs' if sep > 3 else
                    'these features no longer separate; RUN THE HUMAN BLIND TEST, this '
                    'instrument cannot certify a pass'),
        'top_tells': [{'feature': k, 'median_z': round(v, 2)} for v, k in rank[:a.top]],
        'per_pose_max_z': {p: round(v, 2) for p, v in sorted(maxz.items())},
    }
    if a.verbose:
        out['per_pose'] = {p: {k: round(v, 2) for k, v in sorted(z.items(), key=lambda x: -x[1])[:a.top]}
                           for p, z in per_pose.items()}
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)) or '.', exist_ok=True)
        json.dump(out, open(a.json, 'w'), indent=2)
    if not a.quiet:
        print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
