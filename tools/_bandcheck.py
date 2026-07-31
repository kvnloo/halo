#!/usr/bin/env python
"""Banding gate, identical to the measurement grade.js and grain.js both record:
blue channel down column x=1500, top 800 rows. grade.js's regression gate fails above a
2.0 px mean plateau run.

  _bandcheck.py <img.png> [x] [rows]
"""
import sys
import cv2
import numpy as np

img = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR)
x = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
rows = int(sys.argv[3]) if len(sys.argv) > 3 else 800
col = img[:rows, x, 0].astype(int)          # BGR -> [0] is blue
runs, cur = [], 1
for i in range(1, len(col)):
    if col[i] == col[i - 1]:
        cur += 1
    else:
        runs.append(cur); cur = 1
runs.append(cur)
runs = np.array(runs)
print(f'{sys.argv[1]}  codes={len(np.unique(col))}  mean_run={runs.mean():.2f}  '
      f'max_run={runs.max()}  runs>=8px={(runs >= 8).sum()}  GATE(<2.0)='
      f'{"pass" if runs.mean() < 2.0 else "FAIL"}')
