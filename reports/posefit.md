# posefit — `src/world/poses.js`

Wave I. Owner file: `src/world/poses.js` only. New files: `tools/_posefit_metrics.py`
(pinned metric snapshot, see §6).

Brief: run `tools/fitpose.mjs --all --apply` to unblock `structure` and `perceptual`,
which "have been near zero for five waves and CANNOT move: they are measuring a
correctly-rendered beach photographed from the wrong place."

**The brief's premise is wrong, and the headline number it predicted does not exist.**
The poses were genuinely unfitted and refitting them does help a little, but framing was
never the reason those axes read zero. Details below; the refit is shipped anyway,
because it is a real if small gain and because it fixes a physical error in the camera.

---

## 0. TL;DR

| | |
|---|---|
| `structure` before / after | 21.10 → **24.15** |
| `perceptual` before / after | 16.33 → **17.57** |
| raw `ms_ssim` / `lpips` | 0.3145 → **0.3275** / 0.6724 → **0.6682** |
| `score_comparative` | 13.86 → **15.32** |
| composite (new bands) | 16.39 → 16.85 |
| composite (legacy bands) | 29.44 → 30.15 |
| ms cost | **0** — data table, not in any frame's critical path |
| poses under terrain | 0 before, 0 after (`_posecheck` 28 poses, 0 FAIL, 0 WARN) |

**How much of the "structure has been stuck at zero" problem was actually framing: about
13%.** Re-banding the metric moved `structure` 3.42 → 21.10 with *zero* pose change.
Refitting the poses then added 3.05 on top. The band was worth ~6x the pose.

**How much of the refit's own gain was just standing the camera up: about half.** Raising
eye height to `terrain.height(x,z) + 1.72` with no reframing at all is worth `ms_ssim`
+0.0067 of the total +0.0130.

---

## 1. The premise is false: this metric barely responds to camera pose

Before applying anything, I measured the metric's sensitivity to framing directly, using
the reference clip against itself — so neither side is anything this engine renders
(KNOWN_ISSUES 4).

**A. Real camera motion in the real game barely moves the metric.**

```
kf_00000 vs kf_XXXXX   — same engine, same scene, ONLY the camera moved
frame      ms_ssim   lpips
00015      0.7983    0.1054
00030      0.7778    0.1220
00060      0.7772    0.1390
00120      0.8056    0.1542
```

Four seconds of camera travel costs 0.20 of `ms_ssim`. Our gap at the *nominally correct*
pose was 0.49. Framing cannot be the dominant term.

**B. Our render is equidistant from every reference frame.**

Hold our render fixed at the old `ref_00000` pose and sweep the *target*:

```
ref frame  ms_ssim   lpips
00000      0.2882    0.6596     <- the frame this pose is supposed to match
00030      0.2843    0.6585
00120      0.2824    0.6628
00450      0.2807    0.6643     <- a different shot, 450 frames of camera motion away
01500      0.2577    0.6928     <- the far end of the beach, unrelated composition
```

Moving the target 450 frames away costs **0.0075** of `ms_ssim`. The whole pose refit
gained **0.0130**. The metric's entire dynamic range with respect to framing, in our
regime, is the same size as the effect we were sent to chase.

**C. The floor.** Two genuinely unrelated shots of the reference score `ms_ssim` 0.2719
(`kf_00000` vs `kf_01500`). Our correctly-framed render scored 0.2882. We were sitting
at the "no relationship at all" floor *with the camera in the right place*. That is a
content problem — it is blind.md's T1 (rock silhouettes are extrusions, not erosion) —
not a framing problem.

This was measured independently of, and agrees with, the metrics agent's own finding that
landed the same night: the `structure` band demanded a distance of 0.15 when the reference
scores 0.524 against *its own next frame*, so the axis was pinned at 0 for reasons that
have nothing to do with where the camera stood.

---

## 2. Two things contaminated the A/B, and both had to be removed

### 2.1 `fitpose.mjs`'s own verification screenshots have no viewmodel

The first fitted preview came back with the assault rifle missing. Every reference frame
has the rifle in the same place at ~10-15% of frame with very strong edges, so this is not
cosmetic.

All three integrity channels were clean — `__HALO_MISSING__` `[]`, `__HALO_MISSING_PASSES__`
`[]`, `failedModules` `[]`, all 19 modules including `weapons` present — so this is *not*
KNOWN_ISSUES 20. Isolated by replaying fitpose's exact session:

```
A  boot 1280x720, advance 48            gun PRESENT
B  setSize(1920,1080), advance 48       gun GONE
C  still 1920x1080, advance 120         gun GONE      (not a convergence issue)
D  setSize(1280,720), advance 48        gun BACK      (not a corrupted state)
```

**The viewmodel is dropped by a runtime resize, not by the resolution itself** —
`capture.mjs` boots directly at 1920x1080 and the gun is there. Belongs to whoever owns
`RenderPipeline.js` / `passes/scene.js` (the Wave H `viewDepthTex` work resizes two
attachments); it is not in my file. Cost, measured on the identical pose and size with the
gun as the only difference:

```
                        ms_ssim   lpips    perceptual   score
WITH gun (score.mjs)     0.2882   0.6596      8.97      32.82
NO gun (fitpose verify)  0.2772   0.6658      7.59      30.66
```

So **every metric `fitpose.mjs` prints is penalised by ~2.16 score**, and its `--apply`
decision is being made on frames that are not the frames we ship. The *search* is fine —
it runs at 720p, where the gun is present.

`fitpose.mjs` also never reads any of the three integrity channels, so if a subsystem
*had* failed it would have fitted the camera to a world with a hole in it and said nothing.
That is worth fixing in the tool.

### 2.2 The scoring function was re-banded mid-experiment

`tools/metrics.py` was re-banded and re-weighted by a concurrent agent **between** my
before and after runs, and its md5 changed three times inside a single measurement pass
(`a580fdc9` → `92b2b50a` → `0592ed3f`). The tell was a control: `ref_01500`'s pose was
*not changed by the fitter* (all deltas 0.00) yet its score moved 29.40 → 9.56. A pose
edit cannot do that.

Everything below is therefore re-measured from the surviving PNGs with **one pinned
metric** (`tools/_posefit_metrics.py`, md5 `0592ed3f`), all arms back to back, gun present
in all. With that pinning `ref_01500` reads 0.2793 → 0.2796 — the control now behaves, and
it is what makes the rest of the table trustworthy.

---

## 3. Four arms, one instrument

`A` hand-authored (baseline) · `B` `fitpose --all --apply` verbatim · `C` fitted x/z/rot/fov
with `y = terrain.height(x,z) + EYE_STAND` · `D` hand poses with only `y` raised.

```
                    A hand    B fitpose   C fit+stand   D hand+stand
score_comparative    13.86       15.27        15.32         14.81
score (all 6)        16.39       16.98        16.85         16.85
score (legacy)       29.44       29.70        30.15         29.89
structure            21.10       23.73        24.15         22.57
perceptual           16.33       17.80        17.57         17.64
raw ms_ssim         0.3145      0.3256       0.3275        0.3212
raw lpips           0.6724      0.6663       0.6682        0.6684
```

**Shipped: C.** It wins `score_comparative` and `structure`, wins the legacy composite, and
is the only arm that is physically correct. B's 0.13 lead on the 6-axis composite is
entirely `spectrum`, which is noise at this operating point — it swings 0.33 → 99.99 at
`ref_02220` on a small pose change, and 92.69 → 1.28 at `ref_00720`.

**D is the important row.** Raising eye height *alone*, with no reframing whatsoever, gets
`ms_ssim` 0.3145 → 0.3212 — half the total gain — and `structure` +1.47 of the +3.05. This
closes reports/poses.md section 5, which measured the old `ref_*` cameras at 0.26–1.18 m
off the sand and flagged it for the next refit. `ref_00000`, the pose the entire score
history is anchored on, was 0.26 m above the beach: effectively lying down, while the
reference is a standing Chief.

---

## 4. Why the fitter's own answer had to be constrained

`fitpose.mjs` searches **absolute** Y against a hard floor clamp of 0.4 m. It has no
concept of the ground, so it pushed cameras down onto the sand:

```
                        clearance   ms_ssim
A hand      ref_01800      1.73 m    0.2849
B fitpose   ref_01800      0.19 m    0.3324   <- best single number in the whole experiment
C shipped   ref_01800      1.72 m    0.3058
```

That 0.3324 is the highest `ms_ssim` I measured anywhere, and the frame is *worse*: the
camera is lying on the beach and the shot has lost its subject — the sea stacks and the
waterline that the reference frame is about are gone, replaced by a face full of foreground
pebbles, which MS-SSIM likes because it correlates with the reference's big smooth wet-sand
foreground. This is precisely the "converges on a wrong local optimum that scores better
while framing worse" case the brief said to look for, and reading the number alone would
have shipped it.

Two poses (`ref_00720`, `ref_01800`) came out of the raw fit at 0.18 m and 0.19 m
clearance. Under arm C every scored camera stands at exactly 1.72 m.

Visual check of the shipped arm at all nine poses: no degenerate frames. `ref_00000` gains
the low horizon and open sky the reference has; `ref_01800` keeps its stacks and waterline.

---

## 5. What actually changed in the file

- Nine `ref_*` poses: x/z/pitch/yaw/fov from the fitter, `pos[1]` pinned to standing height.
- `POSE_GROUND` rebaked for all nine (`_posecheck --rebake`).
- `minClear` for the `ref_*` set 0.10 → **1.20**. They stand now, so the gate should say so.
  Not 1.40 (the showcase value): `terrain.js` is re-profiled most waves and a hard FAIL has
  a blast radius across every agent, so this leaves 0.52 m of headroom below the authored
  1.72 and lets the 0.60 m drift WARN fire first.
- Header rewritten: it previously said the `ref_*` poses "must NOT be moved", which is now
  false and would mislead the next reader.
- Wave H's under-terrain machinery (`selfCheck`, `auditPoses`, `assertPosesAboveGround`,
  the `terrain.raycast` second witness) is untouched and still passing.

`scores/history.jsonl` carries a `== POSE REFIT LINE ==` marker row recording **both**
discontinuities — the refit and the re-band — because a reader who attributes the
`structure` jump to this wave's work would be wrong by a factor of six.

---

## 6. Verification

- `node tools/parsecheck.mjs` — ok, 42 files.
- `node tools/_posecheck.mjs` — 28 poses, 0 FAIL, 0 WARN; all nine scored cameras at 1.72 m.
- Control pose `ref_01500` (unchanged by the fitter) reads 0.2793 → 0.2796 under the pinned
  metric, confirming the A/B isolates the pose edit.
- All four arms captured at `--settle 48`, 1920x1080, viewmodel present, re-measured from
  PNGs with one hash-verified metric.
- `tools/_posefit_metrics.py` is a pinned snapshot of `metrics.py` md5 `0592ed3f`, kept only
  so these numbers stay reproducible. Delete it once `metrics.py` settles.

## 7. Weakest thing left

**The refit is worth ~1 point and the wave was planned as if it were worth twenty.** The
two axes this task was told to unblock are limited by content, not framing: at the correct
pose our render sits at the same MS-SSIM as two completely unrelated shots of the reference.
Nothing in `poses.js` can move that. The next real gain is blind.md T1 — rock silhouettes —
and the grade, not the camera.

Second: `fitpose.mjs` needs two fixes before anyone runs it again — constrain Y to
`terrain.height(x,z) + EYE_STAND` rather than absolute Y with a 0.4 m clamp, and read the
three integrity channels. Third: the viewmodel-drops-on-resize bug in §2.1 belongs to
`RenderPipeline.js` / `passes/scene.js`.

## 8. Files

- `src/world/poses.js` — refitted `ref_*`, rebaked `POSE_GROUND`, tightened `minClear`.
- `tools/_posefit_metrics.py` — pinned metric snapshot (temporary).
- `shots/waveI-prefit|posefit|fitstand|handstand/` — the four arms.
- `scores/waveI-*.json`, `scores/history.jsonl` marker row.
