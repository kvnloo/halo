#!/usr/bin/env python
"""
Compose blind A/B sheets. Called by tools/blind.mjs; not usually run by hand.

Two products from one pass:
  * per-pose sheets     <out>/<pose>.png    A | B, unlabelled, native-ish resolution
  * ONE contact sheet   <out>/contact.png   every pair, so judging costs one look
                                            instead of one look per pose

The A/B order comes from a caller-supplied CSPRNG seed, NOT from a hash of the render
file. `tools/sbs.py --blind` derived the swap from sha256(render bytes) & 1, which is
reproducible by anyone standing in the repo — it was unguessable only by convention.
This takes the side assignment from the key file, which lives outside the repo.

  blindsheet.py --pairs pairs.json --out shots/blind
  # pairs.json: [{"pose":"ref_00000","ref":"...","render":"...","renderSide":"A"}, ...]
"""
import argparse, json, os
import numpy as np
import cv2


def label(img, text, color=(255, 255, 255), scale=1.0):
    h, w = img.shape[:2]
    pad = max(26, int(h / 22))
    canvas = np.zeros((h + pad, w, 3), np.uint8)
    canvas[pad:] = img
    s = (w / 1400.0) * scale
    cv2.putText(canvas, text, (int(10 * s) + 6, int(pad * 0.74)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.62 * s, color, max(1, int(2 * s)), cv2.LINE_AA)
    return canvas


def read_pair(p):
    ref = cv2.imread(p['ref'], cv2.IMREAD_COLOR)
    rnd = cv2.imread(p['render'], cv2.IMREAD_COLOR)
    if ref is None or rnd is None:
        return None, None
    if rnd.shape[:2] != ref.shape[:2]:
        rnd = cv2.resize(rnd, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)
    return (rnd, ref) if p['renderSide'] == 'A' else (ref, rnd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pairs', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--maxw', type=int, default=3600)
    ap.add_argument('--contact-w', type=int, default=1600)
    ap.add_argument('--rows-per-page', type=int, default=3)
    ap.add_argument('--no-contact', action='store_true')
    a = ap.parse_args()

    pairs = json.load(open(a.pairs))
    os.makedirs(a.out, exist_ok=True)
    rows, made = [], []

    for p in pairs:
        A, B = read_pair(p)
        if A is None:
            continue
        sheet = np.hstack([label(A, 'A'), label(B, 'B')])
        if sheet.shape[1] > a.maxw:
            s = a.maxw / sheet.shape[1]
            sheet = cv2.resize(sheet, (a.maxw, int(sheet.shape[0] * s)), interpolation=cv2.INTER_AREA)
        path = os.path.join(a.out, p['pose'] + '.png')
        cv2.imwrite(path, sheet)
        made.append(path)

        if not a.no_contact:
            pw = a.contact_w // 2
            ph = int(A.shape[0] * pw / A.shape[1])
            ra = cv2.resize(A, (pw, ph), interpolation=cv2.INTER_AREA)
            rb = cv2.resize(B, (pw, ph), interpolation=cv2.INTER_AREA)
            row = np.hstack([label(ra, p['pose'] + '   A'), label(rb, p['pose'] + '   B')])
            sep = np.full((6, row.shape[1], 3), 40, np.uint8)
            rows.append(np.vstack([row, sep]))

    out = {'sheets': made}
    if rows:
        # Paged: one 6400 px sheet is 22 MB and unreadable in a single look, which is
        # exactly the cost this tool exists to remove. 3 pairs per page keeps each page
        # at ~1600x1500 and a few MB, so the whole judgement is 3 looks, not 9.
        n = max(1, a.rows_per_page)
        pages = [np.vstack(rows[i:i + n]) for i in range(0, len(rows), n)]
        paths = []
        for i, pg in enumerate(pages):
            p = os.path.join(a.out, 'contact.png' if len(pages) == 1 else f'contact_{i + 1}.png')
            cv2.imwrite(p, pg)
            paths.append(p)
        out['contact'] = paths[0] if len(paths) == 1 else paths
        out['contact_pages'] = paths
        out['page_size'] = [int(pages[0].shape[1]), int(pages[0].shape[0])]
    print(json.dumps(out))


if __name__ == '__main__':
    main()
