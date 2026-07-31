#!/usr/bin/env bash
# _pfxcap.sh <pose> <outdir> <name=config> ...
# Captures every variant CONCURRENTLY through the shared daemon so a whole sweep sees
# the same state of a tree that other agents are editing. Records the per-capture
# "modules not loaded" list next to each PNG: two captures whose module lists differ
# are two different scenes and must not be compared.
set -u
POSE="$1"; shift
OUT="$1"; shift
mkdir -p "$OUT"
pids=()
for spec in "$@"; do
  name="${spec%%=*}"
  cfg="${spec#*=}"
  (
    node tools/capture.mjs --pose "$POSE" --out "$OUT/$name.png" --settle 48 \
      --config "$cfg" > "$OUT/$name.log" 2>&1
    grep -o 'not loaded:[^"]*' "$OUT/$name.log" | tr '\n' ' ' > "$OUT/$name.mods"
  ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
echo "--- module load state per capture ---"
for spec in "$@"; do
  name="${spec%%=*}"
  printf '%-22s %s\n' "$name" "$(cat "$OUT/$name.mods" 2>/dev/null | head -c 160)"
done
