# `player` — first-person controller / movement feel

Owner file: `src/game/player.js` (only). Research: `research/feel.md` (all § refs below).
Probe: `tools/_playerprobe.mjs` (new, headless; see "How this was measured").

---

## 0. How this was measured — no image metric can validate this file

`player.js` is **inert under `tools/capture.mjs`**. In `deterministic` mode `update()` takes
the `syncFromCamera()` early return and never writes the camera; `src/main.js:setPose` and
`src/world/poses.js` own it, and every `ref_*` pose hard-codes `fov: 78`.

Measured, `ref_00000`, `--settle 48`:

| capture | lum_mean | sat_mean | p50 |
|---|---|---|---|
| normal, t₀ | 107.161 | 50.085 | 113 |
| `--skip player`, t₀+2 min | 106.349 | 48.973 | 112 |
| normal, t₀+4 min | 106.322 | 49.006 | 112 |

Removing the module entirely moves `lum_mean` by **0.027** against the adjacent normal
capture. The larger 0.81 gap is chronological, not causal: `find src -name '*.js' -newer`
shows `clouds.js`, `terrain.js`, `rocks.js` and `weapons.js` all landed between the first
and second capture (the concurrent wave), which is also why two captures of *identical*
code are not byte-identical right now. Nothing in this file can move a score.

So the instrument for this file is a **simulator, not a screenshot**:

```bash
node tools/_playerprobe.mjs                       # current file
node tools/_playerprobe.mjs <path/to/other.js>    # A/B against a copy
node tools/_playerprobe.mjs --hz=30|60|144        # frame-rate independence
```

It loads the real module against a mocked `ctx` (no `physics`, no `terrain` → the module's
documented degraded path, flat ground at y=0), drives the real key handlers, and measures
apex / hang / dip / coast / speed envelope / bob / FOV. Both columns below come from that
probe at 60 Hz; "before" is `git show HEAD:src/game/player.js`.

One measurement trap worth recording: `camera.y − position.y` is **not** the camera-local
offset once the camera renders an interpolated position — it picks up a constant `v·dt`
lag that looks exactly like a 5 cm per-frame pop. The probe samples at the sim rate and
evaluates against both the current and previous tick's feet, keeping the coherent one.

---

## 1. Before → after

| Quantity | before | after | target (feel.md) |
|---|---|---|---|
| gravity | 19.6 m/s² (2.0 g) | **10.14** | 10.14 §2.5 [DERIVED from 2 Bungie sources] |
| jump apex | 1.050 m | **2.125** | 2.438 × k = 2.125 §2.5 |
| hang time | 0.633 s (38 f) | **1.283 s (77 f)** | 1.387 × √k = 1.295; floaty over ~90 f §7 |
| jump v0 | 6.416 m/s | 6.565 | ≈ 6.56 |
| **one-frame camera pop** | **0.0598 m** | **0.0048 m** | 0 (0.0048 is the dip spring's own first frame) |
| plain-jump dip | 0.0256 m | 0.0261 m | 0.0244 analytic (see §3) |
| dip, 4 m drop (8.8 m/s) | 0.0508 m | **0.0573 m** | soft/hard knee at 8.50 m/s |
| dip, 10 m drop (14.0 m/s) | 0.0801 m | **0.1712 m** | hardDip 0.1743 §3.3 |
| default speed (no key) | 3.600 m/s | **6.403** | 6.858 × √k = 6.403 §1.3 [VERIFIED] |
| diagonal / forward | 0.979 | **0.940** | 0.940 (ellipse) §2.1 |
| strafe / forward | 0.930 | **0.889** | 0.889 §2.1 |
| backpedal / forward | 0.800 | **0.889** | 0.889 §2.1 |
| held-walk speed | absent | **1.457 m/s** | 1.561 × √k §1.3 |
| crouch speed | 1.900 | 2.881 | 0.45 × run §0 |
| sprint | 6.400 (1.78×) | 8.323 (1.30×) | 1.2–1.35× §4 |
| ramp to 95% | 0.250 s | 0.217 s | ≈0.23 s §2.3 |
| **coast after release** | **0.601 m** | **0.440 m** | < 0.6 m §7; 0.55 × k = 0.48 |
| stop time | 0.433 s | 0.150 s | 0.16 s §2.3 |
| coast vs frame rate (30/60/144) | 0.553 / 0.601 / 0.630 | **0.440 / 0.440 / 0.440** | invariant §6.3 |
| dip vs frame rate (30/60/144) | 0.0217 / 0.0256 / 0.0281 | **0.0261 / 0.0261 / 0.0263** | invariant |
| camera bob vertical @ run | 0.0199 m (1.16% eye) | **0.0035 m (0.20%)** | ≤ 2% §3.2 |
| camera bob vertical @ sprint | 0.0519 m (3.02%) | **0.0035 m (0.20%)** | ≤ 2% |
| camera bob lateral @ sprint | 0.0480 m | **0.0030 m** | — |
| camera bob roll @ sprint | 1.395° (+1.2° strafe tilt) | **0.12°** | ≤ 1.5° §3.2 |
| hand (viewmodel) bob vertical | — (channel did not exist) | **0.0140 m** | 80/20 hands:head §3.1 |
| FOV vertical | 78° | **55.41°** | 55.4° = 70° H at 4:3 §3.7 [VERIFIED] |
| FOV horizontal @ 16:9 | 110.4° | **86.07°** | 86.1° (Hor+) |
| mouse | 9.50 cm/360 @ 800 dpi | **35.0 cm/360** | 30–45 §5.1 |
| step height | 0.550 m | **0.319 m** | 0.366 × k [VERIFIED H2EK] |
| max slope | 52° | **45°** | 45 [VERIFIED H2EK] |
| speed up a 30° ramp | 3.600 (=flat) | **5.282 (0.825×)** | falloff 15°/cutoff 45°/0.65 §2.7 |
| speed up a 45° ramp | 3.600 (=flat) | **4.162 (0.650×)** | 0.65 at cutoff |
| speed down a 30° ramp | 3.600 (=flat) | **7.043 (1.100×)** | falloff 10°/cutoff 40°/1.15 |
| hard-landing input lock | none | **0.267 s** | brief lock §4.7 |

Slope numbers come from a probe run with a mocked `physics.moveCharacter` + `terrain.height`
reporting a real ramp normal (`onSlope()` in the probe) — on flat ground the block is a
no-op by construction, so testing it needs a slope. Old file: identical at every angle,
which is feel.md §2.7's "flat plane with painted-on relief".

---

## 2. What changed, by critic item

1. **[critical] The Halo jump.** `gravity` 19.6 → 10.14, `jumpApex` 1.05 → 2.438·k = 2.125.
   `JUMP_V` barely moves (6.416 → 6.565) — it was a *gravity* bug, not a launch-velocity
   bug, which is why it read as plausible. Hang 0.633 → 1.283 s (77 frames at 60 fps;
   feel.md §7 calls >90 floaty and <50 not-Halo). `gravityFallMul` exists at 1.0 (Halo is
   symmetric) as the documented lever if the float is judged too much for a modern
   audience — it preserves apex and ledge reachability and shortens only the descent.
   Every Forerunner ledge authored to Halo metrics (2.44 m → 2.12 m here) is now reachable,
   which is what lets step height come back down to its verified value (item 9).
2. **[critical] The 5.5 cm one-frame teleport is gone.** The old
   `if (!grounded) viewBobOffset.y += clamp(-vel.y*0.0125, ±0.055)` saturated on *every*
   jump (6.416 × 0.0125 = 0.080 > 0.055) and was gated on `grounded` with no blend.
   Measured: **0.0598 m** in one frame, against a landing spring whose entire peak was
   0.0256 m — the pop was 2.3× the designed motion it was masking. The term is now
   (a) removed from the camera entirely and (b) re-created on the **hand** channel through
   a first-order lag with the same τ = 0.15 s on both sides of the ground transition, so
   it decays continuously instead of being gated. feel.md §7: freeze the phase, *fade* the
   amplitude, never gate. Residual one-frame camera-local change is 0.0048 m, which is the
   dip spring's own `v₀·dt` — continuous motion, not a discontinuity.
3. **[critical] Locomotion + the ellipse.** `walk` is now 6.403 m/s and is what you get
   with **no key held**; `slowWalk` 1.457 m/s moved onto Alt; sprint is 1.30× (8.32) per
   the PlayStation Blog's "not drastically faster"; crouch 0.45×. `dirScale`'s cosine lerp
   is replaced by feel.md §2.1's ellipse
   `v_max(θ) = 1/hypot(cosθ/v_along, sinθ/v_side)`, `v_along = 6.403` forward / `5.691`
   back, `v_side = 5.691`. Measured ratios are now exactly the verified tag ratios
   (0.940 / 0.889 / 0.889) instead of 0.979 / 0.930 / 0.800.
4. **[major] Multiplicative friction is gone.** `applyFriction` (Q3 `PM_Friction`) and
   `accelerate` (Q3 `PM_Accelerate`) are both replaced by the single
   `accelerateToward()` — the branch id shipped `#if`-ed out with the comment *"proper way
   (avoids strafe jump maxspeed bug), but feels bad"* — with a rate selector
   `grounded ? (speedingUp ? 29.3 : 44.0) : 5.5` and a snap to zero under 0.15 m/s.
   Coast 0.601 → 0.440 m, stop 0.433 → 0.150 s, and because the brake is now linear-in-dt
   *by construction* rather than a `v *= 1 − f·dt` decay, coast is now **identical at 30,
   60 and 144 Hz** (it varied by 14% before). The file header no longer advertises the
   slide as a feature.
5. **[major] FOV.** `fovBase` 78 → `2·atan(tan 35°/(4/3))` = 55.41° vertical = 86.07°
   horizontal at 16:9, i.e. Hor+ from Halo's verified 70° at 4:3. **`poses.js` untouched**
   — it hard-codes `fov: 78` on every `ref_*` pose and per KNOWN_ISSUES §3 those numbers
   are the immutable substrate of every recorded score. See "Open / handed off" below:
   if 78 is also wrong there, the entire score history is framed through a lens the
   reference never used, and that is a pose-refit task, not this one.
6. **[major] Two-tier landing.** Spring is now ζ = 0.67 with a tier-dependent ω
   (12.0 rad/s soft → 6.71 hard, i.e. ~0.30 s vs ~0.84 s recovery, matching the biped
   tag's *maximum soft/hard landing time* pair). Thresholds are feel.md §3.3's
   reconstruction Froude-scaled: soft 4.294, hard 8.496, max-hard 14.191, death 18.485 m/s;
   dips 0.0523 / 0.1743 / 0.3312 m (3% / 10% / 19% of eye height). The impulse is no longer
   a hard-coded ×11.5 that delivered ~48% of its nominal dip; it is solved from the closed
   form for an underdamped spring's peak,
   `x_peak = (v₀/ω)·exp(−ζ·acos ζ/√(1−ζ²))` ⇒ `v₀ = dip·ω/0.4705`, so the nominal dip *is*
   the achieved dip (measured 0.1712 against a nominal 0.1743 at the hard cap — the 2%
   shortfall is the sub-stepped integrator, 8 substeps per tick). A hard landing now also
   takes a 0.15–0.25 s **input lock** (`player.inputLocked`), which feel.md §4.7 calls the
   strongest mass signal available. `landPitchPerM` cut 1.15 → 0.35 rad/m: at the new
   hard dip 1.15 would have pitched the view 11.5°.
7. **[major] Bob moved to the hands.** Camera bob is now 0.0035 m vertical (0.20% of eye
   height, ceiling 2%), 0.0030 lateral, 0.12° roll (ceiling 1.5°), 0.08° pitch. The
   `bobVertSprint`/`bobLatSprint`/`bobRollSprint` double-count and the 1.55 over-clamp are
   deleted — amplitude now scales **once**, as `min(speed/6.403, 1)`. `strafeTilt` is
   deleted (feel.md §4: strafe camera roll is on the "what Halo does NOT have" list).
   The removed 80% is exposed as **`handBobOffset` / `handBobAngles`** (4× the camera
   amplitude, 0.0140 m vertical, *not* applied to the camera), plus the airborne float.
   **`weapons.js` must be switched onto it** — see below.
8. **[major] Look.** Sensitivity 0.0021 → 5.700e-4 rad/count = 35.0 cm/360 at 800 dpi
   (`TUNE.cm360` / `TUNE.mouseDPI` are the user-facing form). `getCoalescedEvents()` is
   used when `PointerEvent` exists, so 1000 Hz mice are not decimated. A full gamepad path
   now exists with all five stages of feel.md §5.2: scaled-radial deadzone 0.15 (Sutphin),
   max-input shelf 0.05, response exponent 2, and **turn acceleration** — peg threshold
   0.90, 0.35 s ramp to 2.5× (120 → 300 °/s), released twice as fast — which feel.md §4.3
   ranks the #3 contributor to Halo's weight. Stage 5 (magnetism/adhesion) is deliberately
   *not* here: it belongs to weapons/AI and is controller-only.
9. **[minor] Step height, slope.** `stepHeight` 0.55 → 0.319, new `stepCrouch` 0.213,
   selected on `crouching` and pushed into `_moveOpts` per move. `maxSlopeDeg` 52 → 45.
   The biped tag's slope model is implemented (uphill falloff 15° / cutoff 45° / scale
   0.65; downhill 10° / 40° / 1.15) as a continuous multiplier on wish speed, from
   `acos(groundNormal.y)` and the sign of `wishDir · uphill`. Step smoothing changed from
   `approach(11, dt)` (max velocity at t=0) to feel.md §3.4's smoothstep over 0.168 s with
   Q3's accumulate-onto-in-progress behaviour retained.
10. **[minor] Timestep.** Not fixed in `Engine.js` — flagged, not touched, six agents are
    in the tree. Instead `player.js` now owns a **local** fixed-step accumulator
    (`SIM_DT = 1/120`, `MAX_FRAME 0.25`, `MAX_STEPS 16`) with prev/cur render
    interpolation of position, dip, step offset, eye height and bob phase; view angles are
    integrated at *render* rate outside the tick (mouse is displacement, never × dt);
    `snapNext` suppresses interpolation across teleports. 1/120 rather than 1/60 so the
    interpolation lag on a 60 Hz display is 8 ms rather than 17 ms. Also fixed: `prevVy`
    was sampled *after* the first Verlet half-kick, biasing every landing impact low by
    `g·dt/2`; the contact speed is now sampled before it.

---

## 3. Where I did not do what the critic asked, and why

**Plain-jump dip.** The critic asks for 0.052 m from an ordinary jump ("want 0.052 m
Froude-scaled soft dip"). That treats a plain jump as a *full* soft landing. feel.md §3.3
does not: it puts min-soft at 4.6 m/s and min-hard at 9.1 m/s and says the soft tier
"scales 0→1 across that band", while noting a plain jump lands at exactly v₀ = 7.03 m/s —
54% of the way across. feel.md's own arithmetic therefore gives 0.54 × 0.06 = 0.032 m at
Spartan scale, i.e. **0.028 m here**, and that is what is implemented (measured 0.0261).
I did not bend the band to hit 0.052, because that would put an ordinary hop at the same
dip as a 4 m fall and flatten the tier structure the same item asks for. What actually
fixes "the landing has no weight" is elsewhere and is done: the pop that was 2.3× the dip
is gone, the spring is 1.8× slower (ω 12.2 → 6.7–12.0 with 2.3× the recovery time at the
hard tier), the large landings got *much* bigger (0.080 → 0.171 m at 14 m/s), and hard
landings now lock input.

**Sprint kept.** feel.md §4 is explicit that CE has no sprint. The target here is
*Campaign Evolved*, which adds it on L3, so it stays — at 1.30×, inside the blog-sourced
1.2–1.35× band, instead of the shipped 1.78×.

---

## 4. Cost

Zero GPU. CPU per render frame: one to two `simulate()` ticks (was one), each doing 1–2
`physics.moveCharacter` calls; the dip spring is 8 sub-steps of three multiply-adds. Under
the capture harness the cost is unchanged and exactly zero — the module early-returns.

---

## 5. Open / handed off

- **`weapons.js` (owned by the concurrent wave) must switch to `handBobOffset`.** It
  currently does `bobX = bobX*0.35 + vb.x*0.55` on `viewBobOffset` (`weapons.js:2666-2671`)
  — i.e. it *adds* the camera bob rather than counter-swaying it, so the gun used to move
  1.55× the head. Now that the camera channel is 1/5 the size, that path leaves the gun
  nearly static. `handBobOffset` / `handBobAngles` carry the full amplitude and are not
  applied to the camera. Also `weapons.js:2618` drives `st.bobPhase` off **wall time**
  (`dt * (5.6 - sprint*1.4) * …`) instead of `player.stepPhase`; that is the beat-frequency
  bug `stepPhase`'s own docstring warns about, and it is now guaranteed to beat, because
  the stride model changed.
- **`docs/WORLD.md` "Player" block is now stale** (it still lists walk 3.6 / sprint 6.4 /
  gravity 19.6 / apex 1.05 / step 0.55). Those numbers are generic-shooter values, not
  measured from the reference clip, and every one of them is contradicted by a verified
  Bungie source. I do not own that file.
- **`poses.js` fov 78 vs a 55.4° game.** Not touched (KNOWN_ISSUES §3). If the reference
  clip was shot at Halo's FOV, every scored capture is 24° wider than the thing it is
  scored against, and that is a systematic geometry error no material fix can absorb.
  Worth a pose-refit task with a fov term.
- **`Engine.js` still has no accumulator** (KNOWN_ISSUES / feel.md §6.1). `player.js` no
  longer cares, but every other simulated module still runs at render rate.
- **Not implemented:** the stun block (`stun movement/turning/jumping penalty`, feel.md
  §4.6) — it needs a damage-source hook that does not exist yet; and controller aim
  magnetism/adhesion (feel.md §5.2 stage 5), which belongs in weapons/AI.
- **Weakest thing left:** the whole file is validated by simulation only. Nothing here has
  been felt by a human at 60 fps with a mouse in hand, and feel is the one thing a probe
  cannot measure.
