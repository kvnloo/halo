#!/bin/sh
# paired capture: gun frame + matching --skip weapons frame, back to back, so the
# viewmodel mask is not poisoned by another agent's world edit landing between them.
set -e
cd /workspace/zer0/products/halo
tag="$1"; shift
node tools/capture.mjs --pose ref_00000 --out "shots/${tag}.png" --settle 48 "$@" >/dev/null 2>&1
node tools/capture.mjs --pose ref_00000 --skip weapons --out "shots/${tag}_nw.png" --settle 48 "$@" >/dev/null 2>&1
.venv/bin/python tools/_wpnmask.py ours "shots/${tag}.png" "shots/${tag}_nw.png"
