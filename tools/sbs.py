#!/usr/bin/env python
"""Build a labelled side-by-side (and difference) sheet for the critic agent.

  sbs.py reference.png render.png out.png [--blind]

--blind randomises left/right order and drops the labels, writing the true order to
out.png.key so a critic can be asked which is better without being told which is which.
"""
import sys, os, hashlib
import cv2
import numpy as np

def label(img, text, color=(255, 255, 255)):
    h, w = img.shape[:2]
    pad = max(28, h // 26)
    canvas = np.zeros((h + pad, w, 3), np.uint8)
    canvas[pad:] = img
    scale = w / 1400.0
    cv2.putText(canvas, text, (int(10 * scale) + 6, int(pad * 0.72)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.62 * scale, color, max(1, int(2 * scale)), cv2.LINE_AA)
    return canvas


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    blind = '--blind' in sys.argv
    ref_p, test_p, out_p = args[0], args[1], args[2]

    ref = cv2.imread(ref_p, cv2.IMREAD_COLOR)
    test = cv2.imread(test_p, cv2.IMREAD_COLOR)
    if ref is None or test is None:
        raise SystemExit(f'cannot read {ref_p} / {test_p}')
    if test.shape[:2] != ref.shape[:2]:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)

    if blind:
        # deterministic but unguessable order, keyed on the file contents
        h = hashlib.sha256(open(test_p, 'rb').read()).digest()[0]
        swap = bool(h & 1)
        a, b = (test, ref) if swap else (ref, test)
        sheet = np.hstack([label(a, 'A'), label(b, 'B')])
        with open(out_p + '.key', 'w') as f:
            f.write('A=render B=reference\n' if swap else 'A=reference B=render\n')
    else:
        # difference map: where the two images disagree perceptually
        la = cv2.cvtColor(ref, cv2.COLOR_BGR2LAB).astype(np.float32)
        lb = cv2.cvtColor(test, cv2.COLOR_BGR2LAB).astype(np.float32)
        d = np.linalg.norm(la - lb, axis=2)
        d = np.clip(d / 60.0 * 255.0, 0, 255).astype(np.uint8)
        dm = cv2.applyColorMap(d, cv2.COLORMAP_INFERNO)
        sheet = np.hstack([
            label(ref, 'REFERENCE  (Halo: Campaign Evolved)', (150, 230, 255)),
            label(test, 'RENDER  (this build)', (150, 255, 200)),
            label(dm, 'delta E', (200, 200, 200)),
        ])

    # keep the sheet a sane size for an agent to look at
    maxw = 3600
    if sheet.shape[1] > maxw:
        s = maxw / sheet.shape[1]
        sheet = cv2.resize(sheet, (maxw, int(sheet.shape[0] * s)), interpolation=cv2.INTER_AREA)

    os.makedirs(os.path.dirname(os.path.abspath(out_p)) or '.', exist_ok=True)
    cv2.imwrite(out_p, sheet)
    print(out_p)


if __name__ == '__main__':
    main()
