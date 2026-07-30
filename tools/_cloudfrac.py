#!/usr/bin/env python3
"""Cloud-cover fraction in the sky band: fraction of the top 42% of the frame that is
low-saturation and bright (sat<0.16, lum>110).  Plus the tonal statistics of that band,
which is where cloud-top clipping shows up.  Used by the clouds module only."""
import sys, cv2, numpy as np

for f in sys.argv[1:]:
    img = cv2.imread(f)
    if img is None:
        print(f"{f}: MISSING"); continue
    h = img.shape[0]
    band = img[:int(h * 0.42)]
    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    lum = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY).astype(np.float64)
    sat = hsv[..., 1].astype(np.float64) / 255.0
    cloud = (sat < 0.16) & (lum > 110)
    g = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    print(f"{f}: cover={cloud.mean():.4f} lum_mean={lum.mean():.2f} lum_std={lum.std():.2f} "
          f"max={lum.max():.1f} frac>235={float((lum>235).mean()):.5f} "
          f"lap_var={cv2.Laplacian(g, cv2.CV_64F).var():.1f}")
