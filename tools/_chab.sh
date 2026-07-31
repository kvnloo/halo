#!/usr/bin/env bash
# A/B the characters against the HEAD version of src/game/ai.js ONLY.
#
# Other agents are editing src/ concurrently, so a capture taken an hour ago is not a
# valid control: the sky, ocean and cliff have all moved underneath. The only honest
# before/after swaps one file, back to back, in the same tree at the same minute.
set -e
cd "$(dirname "$0")/.."
POSE_ARGS=${POSE_ARGS:-"--pos -24.5,1.60,-11.0 --rot -3,90,0 --fov 32"}
OUT=${OUT:-shots/latest}
SETTLE=${SETTLE:-24}

cap () {  # cap <outfile> [extra args]
  local f=$1; shift
  for i in 1 2 3 4 5 6; do
    if node tools/_chcam.mjs $POSE_ARGS --settle "$SETTLE" --skip ssr "$@" --out "$f" 2>&1 | tail -1 | grep -q '"ok":true'; then
      return 0
    fi
    echo "  retry $f ($i)" >&2; sleep 40
  done
  echo "FAILED $f" >&2; return 1
}

echo "== after (working tree) =="
cap "$OUT/ab_after.png"
cap "$OUT/ab_after_noai.png" --skip ssr,ai

echo "== before (HEAD ai.js) =="
cp src/game/ai.js /tmp/ai_work.js
git show HEAD:src/game/ai.js > src/game/ai.js
trap 'cp /tmp/ai_work.js src/game/ai.js' EXIT
cap "$OUT/ab_before.png"
cap "$OUT/ab_before_noai.png" --skip ssr,ai
cp /tmp/ai_work.js src/game/ai.js
trap - EXIT
echo "== restored =="
