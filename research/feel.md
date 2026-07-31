# First-person movement feel, Halo-style, for a JS/WebGL2 game loop

**Key: `feel`.** Target: reproduce the movement and camera feel of *Halo: Combat Evolved* /
*Halo: Campaign Evolved* in a fixed-timestep JavaScript loop.

**Reading guide.** Every number below is tagged:

- **[VERIFIED]** — taken verbatim from a primary source (id/Valve source code, Bungie's shipped
  editing-kit documentation, or the c20 reverse-engineering wiki). URL given inline.
- **[DERIVED]** — computed by me from two or more verified numbers. The arithmetic is shown so
  you can check it.
- **[TUNED]** — my recommendation. Not from any source. Treat as a starting point to playtest.

I flag explicitly at the end what I could **not** verify. Bungie never published the
`cyborg.biped` tag values, and I could not find a public dump of them; several of the most
interesting constants (jump velocity, camera height, landing thresholds) are therefore
**[DERIVED]** or **[TUNED]**, not datamined.

---

## 0. Copy-paste constant block

Everything in SI. This is the "Halo-faithful" set — a 2.13 m Spartan. See §1.4 if you want to
rescale to a human-sized protagonist.

```js
// ─── SCALE ────────────────────────────────────────────────────────────────────
export const WU          = 3.048;      // m per Halo world unit               [VERIFIED]
export const TICK_HZ     = 30;         // Halo's native sim rate              [VERIFIED]

// ─── BODY ─────────────────────────────────────────────────────────────────────
export const H_STAND     = 2.134;      // m, capsule height standing          [VERIFIED]
export const H_CROUCH    = 1.294;      // m, capsule height crouched          [VERIFIED]
export const RADIUS      = 0.455;      // m, capsule radius                   [DERIVED]
export const EYE_STAND   = 1.98;       // m above feet                        [TUNED]
export const EYE_CROUCH  = 1.16;       // m above feet                        [TUNED]
export const STEP_HEIGHT = 0.366;      // m, walk-over-it height, standing    [VERIFIED]
export const STEP_CROUCH = 0.244;      // m, crouched                         [VERIFIED]
export const MAX_SLOPE   = 45;         // degrees                             [VERIFIED]

// ─── GROUND MOVEMENT ──────────────────────────────────────────────────────────
export const V_FWD       = 6.858;      // m/s  (2.25 wu/s)                    [VERIFIED]
export const V_BACK      = 6.096;      // m/s  (2.00 wu/s)                    [VERIFIED]
export const V_SIDE      = 6.096;      // m/s  (2.00 wu/s)                    [VERIFIED]
export const V_WALK      = 1.561;      // m/s  (0.512 wu/s)                   [VERIFIED]
export const V_CROUCH    = 0.45 * V_FWD; //                                   [TUNED]
export const V_SPRINT    = 1.30 * V_FWD; // Campaign Evolved only             [TUNED]
export const ACCEL       = 29.3;       // m/s^2 (9.6 wu/s^2) → top speed 0.23s [DERIVED]
export const DECEL       = 44.0;       // m/s^2 → full stop in 0.16 s         [TUNED]
export const ACCEL_AIR   = 5.5;        // m/s^2, redirect only, no speed gain [TUNED]

// ─── JUMP / GRAVITY ───────────────────────────────────────────────────────────
export const GRAVITY     = 10.14;      // m/s^2 (3.327 wu/s^2)                [DERIVED]
export const JUMP_V0     = 7.03;       // m/s   (2.307 wu/s = 0.0769 wu/tick) [DERIVED]
// ⇒ apex 2.44 m, time-to-apex 0.693 s, hang time 1.387 s, flat range 9.51 m
export const GRAVITY_FALL_MUL = 1.0;   // Halo is symmetric. 1.4–2.0 = snappier [TUNED]

// ─── CAMERA ───────────────────────────────────────────────────────────────────
export const FOV_H_CLASSIC = 70;       // degrees horizontal at 4:3           [VERIFIED]
export const CROUCH_TIME   = 0.25;     // s, standing↔crouch camera blend     [TUNED]
export const STEP_SMOOTH_T = 0.18;     // s, stair-step camera catch-up       [TUNED]
export const STEP_SMOOTH_MAX = 0.75;   // m, cap on accumulated step offset   [TUNED]
export const BOB_Z_AMP     = 0.012;    // m at full run (0.6 % of eye height) [TUNED]
export const BOB_X_AMP     = 0.010;    // m at full run                       [TUNED]
export const BOB_ROLL      = 0.35;     // degrees at full run                 [TUNED]
export const BOB_PITCH     = 0.25;     // degrees at full run                 [TUNED]
export const LAND_SPRING_K = 65.0;     // 1/s^2 — Source PUNCH_SPRING_CONSTANT [VERIFIED]
export const LAND_SPRING_C = 9.0;      // 1/s   — Source PUNCH_DAMPING        [VERIFIED]
```

---

## 1. Units, scale, and why they matter before anything else

### 1.1 The Blam world unit

`1 world unit (wu) = 100 3ds-Max/JMS units`, and the Halo Editing Kit fixes the scale by
Master Chief's height: "approximately 7 feet tall … approximately 10 units = 1 foot".
Therefore **1 wu = 10 feet = 3.048 m exactly**, and the H1 cyborg biped's standing height is
0.7 wu = 2.1336 m.
[VERIFIED — https://c20.reclaimers.net/general/scale/]

### 1.2 The tick

Halo CE and Halo 2 simulate at **30 ticks/second (1/30 s per tick)**; object movement is tied
to the tick, so nothing moves faster than 30 Hz regardless of render rate. MCC raised Halo 2
Classic to 60 Hz (which is why super-bouncing broke).
[VERIFIED — https://github.com/Daylonz/MCCBounceEnable and
https://support.halowaypoint.com/hc/en-us/articles/23707515298324]

This matters for one reason: Halo's tag values that are labelled *per tick* must be multiplied
by 30 to become per-second, and vice versa. `jump velocity` is stored in **world units per
tick**.
[VERIFIED — https://c20.reclaimers.net/h1/tags/object/unit/biped/]

The NTSC/PAL history is the proof: the Xbox PAL release ran at 25 Hz instead of 30 Hz, and
because the sim was tied to frame rate, Bungie had to *raise the speed tags* to compensate.
The speedrun community measures PAL walking as ~17.5 % slower than NTSC — which is exactly
`1 - 25/30 = 16.7 %`.
[VERIFIED — c20 biped page (above); speedrun figure quoted from
https://halospeedruns.fandom.com/wiki/Game-Specific_Tricks]

### 1.3 The verified movement constants

The single best find in this research: c20 documents that the biped flag *"unit uses old ntsc
player physics"* makes the engine **override the globals with hard-coded values**, and lists
them, noting *"These values are identical to the globals in all non-PAL versions of the game."*

| Halo CE `globals` → player information | Value | m/s |
|---|---|---|
| walking speed | 0.512 wu/s | **1.561** |
| run forward | 2.25 wu/s | **6.858** |
| run backward | 2.00 wu/s | **6.096** |
| run sideways | 2.00 wu/s | **6.096** |
| run acceleration | 0.32 | see §2.3 |

[VERIFIED — https://c20.reclaimers.net/h1/tags/object/unit/biped/, section "NTSC vs PAL physics"]

**Independent corroboration.** Bungie's own shipped Halo 2 Editing Kit documentation, under
*Player Speed (World Units/Second)*, gives: Forward Movement Speed (Running) **2.25**, Backward
**2.00**, Side Strafe **2.00**. Two independent sources, two different games, identical numbers.
[VERIFIED — https://www.h2maps.net/editingkit/player%20statistics%20and%20metrics.html]

### 1.4 If you are not building a 7-foot Spartan

Halo's "feel" is partly a *scale* effect. 6.86 m/s is roughly Usain Bolt's average 100 m pace,
but on a 2.13 m body seen through a 70° lens it reads as a purposeful jog.

If you shrink the character to human height `k = H_new / 2.134`, the correct way to preserve
feel is **dynamic (Froude) similarity**: lengths × `k`, **times × √k**, speeds × `√k`,
**gravity unchanged**. For a 1.85 m protagonist (`k = 0.867`, `√k = 0.931`):

| | Spartan | 1.85 m human, similar feel |
|---|---|---|
| run speed | 6.86 m/s | 6.38 m/s |
| jump apex | 2.44 m | 2.11 m |
| time to apex | 0.693 s | 0.645 s |
| gravity | 10.14 m/s² | 10.14 m/s² |

Do **not** just shrink the character and keep the speeds — you get the "tiny sprinting gnome"
look. Do not just keep the character and shrink the jump — you get "heavy but can't climb
anything", which breaks the level metrics in §2.6.

---

## 2. (a) Ground movement, acceleration, air control, jump, gravity

### 2.1 The speed envelope is an ELLIPSE, not a circle

This is the single most commonly-missed detail and it is cross-verified.

Forward max is 2.25 wu/s, lateral max 2.00 wu/s. If you clamp the wish-velocity to a *circle*
you get the classic diagonal-speed bug or, if you normalise, you lose Halo's asymmetry. Halo
clamps to an ellipse:

```
v_max(θ) = 1 / sqrt( (cosθ / v_along)² + (sinθ / v_side)² )
   where v_along = V_FWD if cosθ > 0 else V_BACK
```

At θ = 45° (W+D): `1/sqrt((0.7071/2.25)² + (0.7071/2.00)²) = 2.114 wu/s`, i.e. **6.05 % slower
than straight forward**. The Halo speedrunning community independently measured *"moving
diagonally forward (W+A or W+D) is 5 % slower than walking forwards"* and *"strafing and
backpedalling are both 12 % slower"* (`1 − 2.00/2.25 = 11.1 %`). Model and measurement agree.
[VERIFIED (tag values) + corroborating measurement quoted from
https://halospeedruns.fandom.com/wiki/Game-Specific_Tricks — note: that wiki page returned
HTTP 402 on direct fetch; I have the quote only via search-engine snippet, so treat the 5 %/12 %
figures as second-hand.]

```js
function wishVelocity(inFwd, inRight, sMul) {          // inFwd/inRight in [-1,1]
  if (inFwd === 0 && inRight === 0) return [0, 0];
  const vf = (inFwd > 0 ? V_FWD : V_BACK) * sMul;
  const vs = V_SIDE * sMul;
  // scale the unit input vector out to the ellipse boundary
  const m  = Math.hypot(inFwd, inRight);
  const ux = inRight / m, uy = inFwd / m;
  const r  = 1 / Math.hypot(ux / vs, uy / vf);          // ellipse radius in this direction
  const mag = Math.min(m, 1) * r;                       // partial stick deflection scales it
  return [ux * mag, uy * mag];
}
```

### 2.2 Use velocity-targeted acceleration, NOT Quake's projected acceleration

Quake 3 accelerates by *projecting* current velocity onto the wish direction:

```c
currentspeed = DotProduct(velocity, wishdir);
addspeed     = wishspeed - currentspeed;
if (addspeed <= 0) return;
accelspeed   = accel * frametime * wishspeed;
if (accelspeed > addspeed) accelspeed = addspeed;
velocity += accelspeed * wishdir;
```
[VERIFIED — `PM_Accelerate`,
https://github.com/id-Software/Quake-III-Arena/blob/master/code/game/bg_pmove.c]

That is what makes strafe-jumping possible: because only the *projection* is capped, turning
while accelerating lets total speed exceed `wishspeed` without bound. **Halo has no
strafe-jumping**, so it cannot use this.

Delightfully, id shipped the correct version in the same function, `#if`-ed out, with the
comment:

```c
// proper way (avoids strafe jump maxspeed bug), but feels bad
VectorScale(wishdir, wishspeed, wishVelocity);
VectorSubtract(wishVelocity, velocity, pushDir);
pushLen = VectorNormalize(pushDir);
canPush = accel * frametime * wishspeed;
if (canPush > pushLen) canPush = pushLen;
VectorMA(velocity, canPush, pushDir, velocity);
```
[VERIFIED — same file, `#else` branch of `PM_Accelerate`]

"Feels bad" for an arena shooter is exactly what "feels grounded" means for Halo. Use it:

```js
function accelerateToward(v, wish, rate, dt) {   // v, wish are [x,z] horizontal
  const dx = wish[0] - v[0], dz = wish[1] - v[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return;
  const step = Math.min(rate * dt, len);
  v[0] += dx / len * step;
  v[1] += dz / len * step;
}
```

Note this unifies acceleration and braking: when `wish` is zero, the same code decelerates.
Halo's biped tag has **separate `acceleration` and `deceleration` fields (both wu/s²)**, so
select the rate:
[VERIFIED field names/units — https://c20.reclaimers.net/h1/tags/object/unit/biped/]

```js
const speedingUp = (wishMag > curMag + 1e-4);
const rate = grounded ? (speedingUp ? ACCEL : DECEL) : ACCEL_AIR;
```

**Do not use Quake/Source multiplicative friction** (`v *= 1 - friction*dt`) as your only brake.
It asymptotes and never reaches zero; that is the #1 cause of "the character slides". Q3 papers
over it with `pm_stopspeed = 100` (a floor on the friction "control" speed) and a
`if (speed < 1) velocity = 0` snap.
[VERIFIED — `PM_Friction`, same file; `pm_friction = 6.0f`, `pm_stopspeed = 100.0f`]

### 2.3 The acceleration value, and an honest warning about it

c20 lists `run acceleration = 0.32` and labels the field's unit "world units per second
squared". Taken literally that is 0.975 m/s², which would take **7.0 seconds** to reach 2.25
wu/s. That is flatly contradicted by the game. The value is almost certainly a per-tick
quantity in the same "wu/s" velocity space that the speed fields use:

```
a = 0.32 wu/s per tick × 30 tick/s = 9.6 wu/s² = 29.26 m/s²
time 0 → 6.858 m/s = 6.858 / 29.26 = 0.234 s ≈ 7 ticks
```

**Use 29.3 m/s².** [DERIVED — the ×30 is my inference; the raw 0.32 is [VERIFIED].]

Sanity-check against neighbours:
- Quake 3: `accelspeed = 10 × dt × 320` ⇒ 3200 u/s², 0 → 320 u/s in **0.10 s**. [VERIFIED]
- Source/HL2: `sv_accelerate 10`, `sv_maxspeed 320`; CS uses 7. [VERIFIED —
  https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/movevars_shared.cpp]

So Halo ramps in ~2.3× the time Quake does. That is a large part of the weight.

**Deceleration** is unpublished. Halo stops crisply — noticeably faster than it starts.
`DECEL = 1.5 × ACCEL = 44 m/s²` gives a 0.16 s stop and about **0.55 m of coast** from full
speed. [TUNED]

### 2.4 Air control

Halo's `globals` has a dedicated **`airborne acceleration` (wu/s²)** field, separate from
ground acceleration. Value unpublished.
[VERIFIED field exists — https://c20.reclaimers.net/h1/tags/globals/]

Halo's airborne behaviour is famously committed: you can nudge, you cannot re-aim a jump.
Reference points:

| Engine | ground accel | air accel | air speed cap |
|---|---|---|---|
| Quake 3 | `pm_accelerate 10` | `pm_airaccelerate 1` | none (⇒ strafe-jumping) [VERIFIED] |
| Source | `sv_accelerate 10` | `sv_airaccelerate 10` | `GetAirSpeedCap() = 30 u/s` [VERIFIED] |
| Halo | 9.6 wu/s² [DERIVED] | small | horizontal speed cannot exceed ground max [TUNED] |

Source's trick is the important one: it uses a *large* air accel but clamps `wishspeed` to
**30 units/s** before accelerating, so you can redirect but barely gain.
[VERIFIED — `CGameMovement::AirAccelerate` and `GetAirSpeedCap` in
https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/gamemovement.cpp
and `.../gamemovement.h`]

Recommended Halo rule [TUNED]:

```js
// Airborne: allow direction change, forbid speed gain.
const before = Math.hypot(v[0], v[1]);
accelerateToward(v, wish, ACCEL_AIR, dt);      // ACCEL_AIR ≈ 5.5 m/s²  (≈ 19 % of ground)
const after  = Math.hypot(v[0], v[1]);
const cap    = Math.max(before, V_FWD);        // never exceed max(entry speed, ground max)
if (after > cap) { v[0] *= cap / after; v[1] *= cap / after; }
```

`ACCEL_AIR / ACCEL ≈ 0.19` means a full-hang-time (1.39 s) jump lets you shift lateral velocity
by at most ~7.6 m/s if unclamped — the cap is what actually does the work.

### 2.5 Jump and gravity — the derivation

Bungie's Halo 2 editing-kit metrics, in 3ds Max units (10 units = 1 foot = 0.3048 m):

| Metric | Max units | Metres |
|---|---|---|
| Jump height, standing/running ("max height of an object a player can jump on or over") | 80 | **2.438** |
| Jump distance, standing/running ("max gap between geometry at the same height") | 312 | **9.510** |
| Crouch-jump height | 99 | 3.017 |
| Crouch-jump distance | 330 | 10.058 |
| Ground step height, standing | 12 | 0.366 |
| Ground step height, crouched | 8 | 0.244 |
| Ceiling clearance, standing / crouched | 70 / 50 | 2.134 / 1.524 |
| Min path width | 40 | 1.219 |
| Player bbox standing (L × W × H) | 18.418 × 29.828 × 70.127 | 0.561 × 0.909 × 2.137 |
| Player bbox crouched | 43.372 × 30.719 × 42.455 | 1.322 × 0.936 × 1.294 |
| Max walkable slope | — | **45°** |
| FOV | — | **70°** |

[VERIFIED — https://www.h2maps.net/editingkit/player%20statistics%20and%20metrics.html]

**Independent corroboration of the jump height.** 343's Halo Infinite Forge documentation
states *"Jump height without using clamber is 8 units. Comfortable clamber height is 12 units.
Grapple range is 80 units."* Infinite Forge units are feet (80 ft = 24.4 m matches the
grappleshot's stated ~25 m reach), so Infinite's jump-onto height is also **8 feet = 2.44 m** —
identical to Halo 2's 80 max-units. Two official sources, fifteen years apart.
[VERIFIED — https://support.halowaypoint.com/hc/en-us/articles/14796740242708]

Yes: **in Halo you can jump onto a ledge taller than the Master Chief.** That is not a mistake;
it is the entire reason Halo reads as "floaty but heavy".

Solve the parabola from those two numbers (flat ground, horizontal speed 6.858 m/s):

```
t_air   = range / v_horiz = 9.510 / 6.858        = 1.3866 s
t_apex  = t_air / 2                              = 0.6933 s
g       = 2h / t_apex²  = 2(2.438) / 0.4807      = 10.14 m/s²   = 3.327 wu/s²
v0      = 2h / t_apex   = 4.876 / 0.6933         =  7.03 m/s    = 2.307 wu/s
                                                                 = 0.0769 wu/tick
```
[DERIVED]

`g = 2h/t²`, `v0 = 2h/t` is Kyle Pittman's GDC 2016 parameterisation — pick the *height* and
the *time to apex* you want and let gravity fall out, rather than picking gravity first.
[VERIFIED as a method — "Math for Game Programmers: Building a Better Jump", GDC 2016,
https://gdcvault.com/play/1023559/Math-for-Game-Programmers-Building ; slides at
http://www.mathforgameprogrammers.com/gdc2016/GDC2016_Pittman_Kyle_BuildingABetterJump.pdf
(the PDF host refused TLS from this machine, so I am citing the talk, not quoting the slides)]

**Sensitivity of the derivation.** Both source metrics are "clearance" numbers and slightly
over-state the true ballistic arc (the capsule radius ~0.455 m lets you land with your centre
short of the far edge). Correcting the range to ~9.05 m gives `t_apex = 0.66 s`,
`g = 11.2 m/s²`, `v0 = 7.39 m/s`. So the honest answer is:

> **g ≈ 10–11 m/s², v0 ≈ 7.0–7.4 m/s, apex 2.4 m, time-to-apex 0.66–0.69 s, hang 1.32–1.39 s.**

Use `g = 10.14`, `v0 = 7.03` and tune from there.

### 2.6 Why shooters use higher-than-real gravity — and why Halo *doesn't*

The design constraint is **time-to-apex**, not gravity. A real standing vertical jump is
`v0 ≈ 2.5 m/s`, apex 0.32 m, hang 0.51 s. Games need an apex of 1–1.5 m (to reach ledges and
clear cover) — at real gravity that costs ~1 s of hang time, during which you cannot aim, cannot
change direction, and the horizon slowly rises and falls. Players call that "moon jumping".

The fix is to raise `g` so that a *tall* jump still has a *short* airtime:

| Game | gravity (native) | gravity (m/s², see note) | jump v0 | apex | time-to-apex |
|---|---|---|---|---|---|
| Quake 3 | `g_gravity 800` u/s² | ≈ 20.3 (2.07 g) | `JUMP_VELOCITY 270` | 45.6 u ≈ 1.16 m | **0.338 s** |
| Half-Life 2 | `sv_gravity 600` u/s² | ≈ 15.2 (1.55 g) | 160 u/s | `GAMEMOVEMENT_JUMP_HEIGHT 21` u ≈ 0.53 m | **0.267 s** |
| CS / Source MP | `sv_gravity 800` | ≈ 20.3 | 268.328 u/s | 45 u ≈ 1.14 m | **0.335 s** |
| **Halo** | — | **≈ 10.1 (1.03 g)** | 7.03 m/s | **2.44 m** | **0.693 s** |

[VERIFIED — Q3: `g_gravity "800"`, `g_speed "320"` in `g_main.c`; `JUMP_VELOCITY 270`,
`STEPSIZE 18`, `MIN_WALK_NORMAL 0.7f`, `TIMER_LAND 130` in `bg_local.h`.
Source: `GAMEMOVEMENT_JUMP_HEIGHT 21.0f`, `GAMEMOVEMENT_JUMP_TIME 510.0f` ms in
`gamemovement.h`; `flMul = 160.0f` with `Assert(GetCurrentGravity() == 600.0f)` for HL2 and
`flMul = 268.3281572999747f` with `Assert(... == 800.0f)` otherwise, in
`CGameMovement::CheckJumpButton`. Note on m/s²: id/Valve units are ambiguous; I converted at
1 unit = 1 inch = 0.0254 m, the most common convention. If you prefer the "16 units = 1 foot"
convention (1 u = 0.01905 m) divide those m/s² figures by 1.333.]

Halo is the outlier: **near-Earth gravity, enormous jump, long hang time.** Halo buys back the
"floaty" cost with (a) very restricted air control, so the long hang is *committed* rather than
*steerable*, and (b) a tall body and narrow FOV, so 2.44 m of rise reads as ~1.15 body-heights
rather than 1.4.

**If you want Halo's silhouette with less float**, the standard trick is asymmetric gravity:
rise at `g`, fall at `1.4–2.0 × g`. Apex height is preserved, hang time shrinks, and the landing
arrives with more authority. It is not what Halo does — flag it as a deliberate modernisation.

```js
const gNow = (vy > 0) ? GRAVITY : GRAVITY * GRAVITY_FALL_MUL;
```

### 2.7 Slopes

The biped tag models slopes with a falloff/cutoff pair per direction:
`maximum slope angle`, `downhill falloff angle`, `downhill cutoff angle`,
`downhill velocity scale`, `uphill falloff angle`, `uphill cutoff angle`,
`uphill velocity scale`.
[VERIFIED field names — https://c20.reclaimers.net/h1/tags/object/unit/biped/]

Semantics: below *falloff* the scale is 1.0; between *falloff* and *cutoff* it lerps to
*velocity scale*; above *cutoff* it stays there; above *maximum slope angle* (45°) you slide.
Suggested values [TUNED]: uphill falloff 15°, cutoff 45°, scale 0.65; downhill falloff 10°,
cutoff 40°, scale 1.15.

Visual tell that you got this wrong: running up a 30° ramp at unchanged speed makes the whole
level feel like a flat plane with painted-on relief.

---

## 3. (b) Camera dynamics

### 3.1 The most important structural decision: bob the WEAPON, not the head

Half-Life 2's player camera **does not bob at all**. All of the bob lives in the viewmodel:

```c
#define HL2_BOB_CYCLE_MIN 1.0f
#define HL2_BOB_CYCLE_MAX 0.45f      // seconds per vertical bob cycle at full speed
#define HL2_BOB           0.002f
#define HL2_BOB_UP        0.5f       // fraction of cycle spent on the up-stroke

speed      = clamp(|velocity.xy|, -320, 320);
bob_offset = RemapVal(speed, 0, 320, 0, 1);
bobtime   += dt * bob_offset;                    // cycle advances proportional to speed

cycle = fmod(bobtime, HL2_BOB_CYCLE_MAX) / HL2_BOB_CYCLE_MAX;
cycle = (cycle < HL2_BOB_UP)
      ? PI * cycle / HL2_BOB_UP
      : PI + PI * (cycle - HL2_BOB_UP) / (1 - HL2_BOB_UP);

verticalBob = speed * 0.005f;
verticalBob = verticalBob*0.3 + verticalBob*0.7*sin(cycle);
verticalBob = clamp(verticalBob, -7.0f, 4.0f);
// lateral bob: same, but over a cycle of HL2_BOB_CYCLE_MAX * 2  (one per stride)

// applied to the viewmodel only:
origin += forward * (verticalBob * 0.1f);
origin.z +=          verticalBob * 0.1f;
angles.roll  += verticalBob * 0.5f;
angles.pitch -= verticalBob * 0.4f;
```
[VERIFIED — `CBaseHLCombatWeapon::CalcViewmodelBob` / `AddViewmodelBob`,
https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/hl2/basehlcombatweapon_shared.cpp]

At HL2's normal walk speed of 190 u/s that is `verticalBob = 0.95` ⇒ viewmodel roll ±0.48°,
pitch ∓0.38°, z offset 0.095 units ≈ 2.4 mm. Essentially invisible as an image shift, but it is
what makes the gun feel carried.

Halo does the same thing. **The Halo CE biped tag contains no bob fields at all** — the only
camera fields are `standing camera height`, `crouching camera height`, `crouch transition time`,
`crouch camera velocity`, and the landing block. Whatever head motion exists in Halo comes from
the landing/crouch systems and the weapon animation, not from a bob oscillator.
[VERIFIED by absence — full field list at
https://c20.reclaimers.net/h1/tags/object/unit/biped/. I could **not** find a primary source
stating "Halo CE has no camera bob"; the tag-schema absence is strong but indirect evidence.]

**Recommendation:** put 80 % of your bob energy in the weapon and ≤20 % in the camera.

### 3.2 If you do bob the camera: Quake 3's exact model, and safe amplitudes

Q3's bob phase is an integer cycle counter advanced by a speed-independent rate, with the
*amplitude* scaled by speed:

```c
// simulation, bg_pmove.c :: PM_Footsteps
bobmove = 0.4f;               // running        (0.3f walking, 0.5f crouched — "bob much faster")
bobCycle = (int)(old + bobmove * msec) & 255;
// footstep event fires when ((old + 64) ^ (bobCycle + 64)) & 128   → twice per 256 counts

// render, cg_view.c :: CG_OffsetFirstPersonView
bobfracsin = fabs( sin( (bobCycle & 127) / 127.0 * M_PI ) );      // one hump per step
speed      = max(xyspeed, 200);                                    // visible even when slow

angles[PITCH] += bobfracsin * cg_bobpitch * speed;   // cg_bobpitch 0.002   (×3 if ducked)
angles[ROLL]  += ±bobfracsin * cg_bobroll * speed;   // cg_bobroll  0.002   (sign per step)
angles[PITCH] += dot(velocity, forward) * cg_runpitch; // cg_runpitch 0.002
angles[ROLL]  -= dot(velocity, right)   * cg_runroll;  // cg_runroll  0.005

bob = bobfracsin * xyspeed * cg_bobup;               // cg_bobup 0.005
if (bob > 6) bob = 6;                                 // hard clamp, 6 units
origin[2] += bob;
```
[VERIFIED — https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_view.c
and `.../code/game/bg_pmove.c`; cvar defaults `cg_bobup 0.005`, `cg_bobpitch 0.002`,
`cg_bobroll 0.002`, `cg_runpitch 0.002`, `cg_runroll 0.005` from `cg_main.c`]

Concrete Q3 magnitudes at 320 u/s: vertical bob peak 1.6 units (≈ 3.2 % of the 50-unit
eye-above-feet height), pitch bob ±0.64°, roll bob ±0.64°, strafe roll ±1.6°.
`bobmove = 0.4` ⇒ 256 counts in 640 ms ⇒ **3.125 steps/s**, one vertical hump per step.

**Halo-style recommendation** [TUNED]. Drive the phase from distance travelled, so the cadence
is automatically correct at every speed and never runs while airborne:

```js
// --- simulation tick ---
if (grounded) bobPhase += (speed / STRIDE) * dt * Math.PI;   // STRIDE ≈ 2.0 m per step
else          bobPhase += 0;                                  // freeze in air (see failure modes)
bobPhase %= Math.PI * 2;

// --- render ---
const t = Math.min(speed / V_FWD, 1);           // 0..1 amplitude scalar
const z    =  BOB_Z_AMP * t * Math.abs(Math.sin(bobPhase));       // 2 humps/stride
const x    =  BOB_X_AMP * t * Math.sin(bobPhase * 0.5);           // 1 sway/stride
const roll =  BOB_ROLL  * t * Math.sin(bobPhase * 0.5);
const pitch= -BOB_PITCH * t * Math.abs(Math.sin(bobPhase));
```

Ceilings before it becomes nausea (see §7): vertical amplitude **≤ 2 % of eye height**
(≤ 0.04 m at 1.98 m), roll **≤ 1.5°**, and the footstep sound **must** fire at the humps
(`sin` crossing) or the whole thing reads as a wobbling camera rather than a walking body.

### 3.3 Landing dip — Halo's two-tier model

Halo's landing is tag-driven and has a *soft* and a *hard* tier:

| biped field | unit |
|---|---|
| `minimum soft landing velocity` | wu/s |
| `minimum hard landing velocity` | wu/s |
| `maximum hard landing velocity` | wu/s |
| `death hard landing velocity` | wu/s |
| `maximum soft landing time` | seconds |
| `maximum hard landing time` | seconds |

[VERIFIED field names/units — https://c20.reclaimers.net/h1/tags/object/unit/biped/. **Values
unpublished.**]

Semantics: below `min soft` nothing happens. Between `min soft` and `min hard` you get a soft
landing whose magnitude scales 0→1 across that band and which recovers over
`maximum soft landing time`. Above `min hard` you get a hard landing (bigger dip, stagger
animation, brief movement lock) scaling to 1 at `maximum hard landing velocity`, recovering over
`maximum hard landing time`. Above `death hard landing velocity`, you die.

Reconstructed values, given that a plain jump lands at exactly `v0 = 7.03 m/s` [TUNED]:

| | wu/s | m/s | equivalent free-fall drop |
|---|---|---|---|
| min soft landing velocity | 1.5 | 4.6 | 1.0 m |
| min hard landing velocity | 3.0 | 9.1 | 4.1 m |
| max hard landing velocity | 5.0 | 15.2 | 11.4 m |
| death hard landing velocity | 6.5 | 19.8 | 19.4 m |
| max soft landing time | — | 0.30 s | |
| max hard landing time | — | 0.90 s | |

For comparison, Source's thresholds are published: `PLAYER_FALL_PUNCH_THRESHOLD 303.0f` in/s
(HL2) or `350` (HL1), `PLAYER_MAX_SAFE_FALL_SPEED 526.5f` ("approx 20 feet"),
`PLAYER_FATAL_FALL_SPEED 922.5f` ("approx 60 feet"), `PLAYER_MIN_BOUNCE_SPEED 173`.
[VERIFIED — https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/shareddefs.h]

**Dip magnitudes.** Quake 3 uses three fixed offsets and a linear down/up ramp:

```c
#define LAND_DEFLECT_TIME 150      // ms, view travels DOWN
#define LAND_RETURN_TIME  300      // ms, view travels back UP
cg.landChange = -8;    // EV_FALL_SHORT
cg.landChange = -16;   // EV_FALL_MEDIUM
cg.landChange = -24;   // EV_FALL_FAR

delta = cg.time - cg.landTime;
if (delta < LAND_DEFLECT_TIME)                          f = delta / LAND_DEFLECT_TIME;
else if (delta < LAND_DEFLECT_TIME + LAND_RETURN_TIME)  f = 1 - (delta - LAND_DEFLECT_TIME) / LAND_RETURN_TIME;
vieworg[2] += cg.landChange * f;
```
[VERIFIED — `cg_view.c` + `cg_event.c` + `cg_local.h` in the Q3 repo]

Q3's eye sits 50 units above the feet, so those dips are **16 % / 32 % / 48 % of eye height**.
Scaled to a 1.98 m eye that is 0.32 / 0.63 / 0.95 m — far too much for Halo. Halo's landing is
firm, not a full crouch.

**Recommended Halo values** [TUNED]: soft dip **0.06 m**, hard dip **0.20 m**, extreme
(near-death) **0.38 m** — i.e. 3 % / 10 % / 19 % of eye height.

**Use a damped spring, not a linear ramp.** A linear ramp has a velocity discontinuity at the
bottom and at the end; it reads as a "clunk". Source models view punch as a damped torsional
spring and the constants are published:

```c
#define PUNCH_DAMPING          9.0f    // bigger = more damped
#define PUNCH_SPRING_CONSTANT 65.0f    // bigger = faster correction

punchAngle    += punchAngleVel * dt;
damping        = max(0, 1 - PUNCH_DAMPING * dt);
punchAngleVel *= damping;
springForce    = clamp(PUNCH_SPRING_CONSTANT * dt, 0, 2);
punchAngleVel -= punchAngle * springForce;
```
[VERIFIED — `CGameMovement::DecayPunchAngle`,
https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/gamemovement.cpp]

Characterise it: `ω_n = √65 = 8.06 rad/s` (period 0.78 s), `ζ = 9 / (2·8.06) = 0.558`. That is
**under**damped — it overshoots by `exp(-πζ/√(1-ζ²)) ≈ 12 %` and settles in
`4/(ζω_n) ≈ 0.89 s`. That small bounce-back past zero is exactly the "weight settling" cue.

Source's landing also rolls the view: `punchAngle.roll = fallVelocity * 0.013` (pitch clamped
to 8°). At 300 in/s that is 3.9°; at 600 in/s, 7.8°.
[VERIFIED — `CGameMovement::PlayerRoughLandingEffects`, same file]

```js
// one damped-spring channel, use one per camera DOF you want to kick
class Spring1D {
  constructor(k = 65, c = 9) { this.x = 0; this.v = 0; this.k = k; this.c = c; }
  kick(impulse) { this.v += impulse; }
  step(dt) {
    this.x += this.v * dt;
    this.v *= Math.max(0, 1 - this.c * dt);
    this.v -= this.x * Math.min(this.k * dt, 2);
  }
}
// landing: dipSpring.kick(-landStrength * 3.0)   // m/s downward impulse
```

For a slower, heavier Halo landing, drop `k` to ~35 (`ω_n = 5.9`, period 1.06 s) and keep
`c = 9` (`ζ = 0.76`, ~2 % overshoot). [TUNED]

### 3.4 Step-up smoothing over terrain

When the capsule is teleported up a stair riser (up to `STEP_HEIGHT = 0.366 m` in one tick), the
camera must not follow instantly. Q3:

```c
#define STEP_TIME        200     // ms
#define MAX_STEP_CHANGE   32     // units, ≈ 1.78 × STEPSIZE(18)

// on a step event, accumulate onto any in-progress step:
delta   = cg.time - cg.stepTime;
oldStep = (delta < STEP_TIME) ? cg.stepChange * (STEP_TIME - delta) / STEP_TIME : 0;
cg.stepChange = min(oldStep + stepSize, MAX_STEP_CHANGE);
cg.stepTime   = cg.time;

// every frame:
if (timeDelta < STEP_TIME)
    vieworg[2] -= cg.stepChange * (STEP_TIME - timeDelta) / STEP_TIME;
```
[VERIFIED — `CG_StepOffset` in `cg_view.c`; `EV_STEP_4/8/12/16` handler in `cg_event.c`;
`STEP_TIME 200`, `MAX_STEP_CHANGE 32` in `cg_local.h`]

The accumulate-onto-in-progress behaviour is the part people forget: running up a staircase
fires a step event every ~0.15 s, and without accumulation each new step resets the offset and
the camera ratchets.

Recommendation [TUNED]: `STEP_SMOOTH_T = 0.18 s`, `STEP_SMOOTH_MAX = 0.75 m` (≈ 2 × step
height), and use **smoothstep** rather than Q3's linear decay so there is no velocity jump at
either end:

```js
// stepOffset is the (positive) amount the camera still lags behind the feet
const u = clamp((now - stepTime) / STEP_SMOOTH_T, 0, 1);
const s = 1 - (u * u * (3 - 2 * u));            // smoothstep, 1 → 0
eyeY -= stepOffset * s;
```

Also smooth **downward** steps (stepping off a kerb) — otherwise the camera drops instantly
while the body appears to walk off smoothly. Q3 only handles up.

### 3.5 Crouch transition

Halo has one field, `crouch transition time` (seconds), controlling standing↔crouch camera
travel, plus a cache-only `crouch camera velocity`.
[VERIFIED — https://c20.reclaimers.net/h1/tags/object/unit/biped/]

Source's values, for calibration: `TIME_TO_DUCK 0.4` s in singleplayer / `0.2` s in
multiplayer, `TIME_TO_UNDUCK 0.2` s, `GAMEMOVEMENT_DUCK_TIME 1000` ms, and the interpolation is
`SimpleSpline()` — i.e. **smoothstep**, not linear.
[VERIFIED — `TIME_TO_DUCK`/`TIME_TO_UNDUCK` in `shareddefs.h`; `SimpleSpline(flDuckFraction)`
in `CGameMovement::Duck`]

Q3 smooths duck height changes over `DUCK_TIME = 100` ms.
[VERIFIED — `cg_local.h`]

Recommend **0.25 s down, 0.20 s up, smoothstep**. Camera travel = `EYE_STAND - EYE_CROUCH`
= 0.82 m. [TUNED]

### 3.6 Camera height

`standing camera height` and `crouching camera height` are world-unit fields on the biped;
**values unpublished**. Standing capsule is 2.134 m. A 0.65 wu (1.98 m) eye is 93 % of body
height, which is where a helmeted eye sits.
[VERIFIED field exists; value [TUNED]]

### 3.7 Field of view

Halo CE ships at **70°**, and by default Halo *compresses vertical* FOV at wide aspect ratios
rather than extending horizontal (i.e. Vert−, not Hor+). MCC exposes a 70–120 slider.
[VERIFIED — Bungie H2EK metrics page states "Field of View: 70 degrees";
https://support.halowaypoint.com/hc/en-us/articles/360061543032 for the MCC slider;
https://www.pcgamingwiki.com/wiki/Halo:_Combat_Evolved for the Vert− behaviour]

70° horizontal at 4:3 is `2·atan(tan(35°)·0.75) = 55.4°` **vertical**. In three.js,
`PerspectiveCamera.fov` is vertical, so:

```js
// classic 4:3-equivalent look at any aspect (Hor+ so widescreen users see more, not less)
const H_FOV = 70 * Math.PI / 180;
camera.fov = 2 * Math.atan(Math.tan(H_FOV / 2) / (4 / 3)) * 180 / Math.PI;  // ≈ 55.4
// then keep `camera.fov` fixed and let aspect widen the horizontal — that's Hor+.
```

A narrow FOV is a *major* contributor to the "heavy" read: the same 6.86 m/s produces far less
peripheral optic flow at 70° than at 100°, so the character feels like it is carrying weight
rather than skating. If you ship a modern default of 90–100° horizontal, expect players to
report the movement as "faster and lighter than Halo" even with identical constants — you may
need to *reduce* speed ~10 % at wide FOV to preserve the felt pace. [TUNED]

---

## 4. (c) Where Halo's weightiness actually comes from

Ranked by how much each contributes, in my assessment.

1. **Velocity-targeted acceleration with a ~0.23 s ramp and no strafe-jump exploit** (§2.2–2.3).
   Quake reaches top speed in 0.10 s and lets you exceed it by turning. Halo does neither. This
   is the biggest single difference.

2. **Air control is a nudge, not a steering wheel** (§2.4). A 1.39 s hang time with genuine air
   control would feel like a jetpack. With a speed cap it feels like commitment — you *chose*
   that arc 0.7 s ago and now you live with it. This is why Halo's jump reads as heavy despite
   being enormous.

3. **Turn acceleration on the stick.** Halo's `globals` → `player control` block contains
   `look default pitch rate`, `look default yaw rate`, `look acceleration time` (seconds),
   `look acceleration scale`, and `look peg threshold`.
   [VERIFIED field names/units — https://c20.reclaimers.net/h1/tags/globals/]
   The model this describes: while the stick is deflected past `look peg threshold`, ramp the
   turn rate from the default up to `default × look acceleration scale` over
   `look acceleration time` seconds; reset when the stick drops back. Twitch shooters snap to
   max turn rate instantly. Halo winds up. See §5.2 for values.

4. **The narrow 70° FOV** (§3.7).

5. **Bob lives in the hands, not the head** (§3.1), and the weapon *lags* the camera. Add a
   first-order lag to the viewmodel's rotation with `τ ≈ 70 ms` and a clamp, so a fast turn
   visibly swings the gun and it settles after you stop:

   ```js
   const a = 1 - Math.exp(-dt / 0.07);        // frame-rate-independent lag
   gunYaw   += (camYaw   - gunYaw)   * a;
   gunPitch += (camPitch - gunPitch) * a;
   const lagYaw   = clamp(camYaw   - gunYaw,   -6 * DEG, 6 * DEG);
   const lagPitch = clamp(camPitch - gunPitch, -4 * DEG, 4 * DEG);
   ```
   [TUNED]

6. **The shield/health model deliberately does *not* punch the camera.** Halo signals damage
   through the shield flare shader, the directional damage arrows on the HUD, the shield-down
   alarm, and the low-health heartbeat — the view itself stays stable so you can keep shooting.
   Compare Source, which rolls the view on every hit. Copying Source here will make your game
   feel like HL2, not Halo. [TUNED, based on observed behaviour; I could not find a Bungie
   design document stating this.]

   What Halo *does* do is scale your movement: `globals` → `player information` has
   **`stun movement penalty`, `stun turning penalty`, `stun jumping penalty`,
   `minimum stun time` (s), `maximum stun time` (s)**.
   [VERIFIED field names/units — https://c20.reclaimers.net/h1/tags/globals/]
   Plasma weapons apply a stun; for its duration your movement speed, turn rate and jump
   velocity are multiplied down. *That* is the feel of being under fire in Halo — you get
   heavy, not shaken.

   Suggested [TUNED]: movement penalty 0.75, turning penalty 0.65, jumping penalty 0.85,
   stun time lerping 0.3 s → 1.0 s with damage magnitude.

7. **Two-tier landing with a movement lock on hard landings** (§3.3). A hard landing that
   briefly refuses input is the strongest "you have mass" signal available.

8. **Melee and weapon kick through the damped spring**, not an instant angular offset (§3.3).

**What Halo does NOT have** (do not add these or you will drift toward Call of Duty):
no camera roll on strafe worth mentioning, no sprint (CE), no slide, no clamber, no ADS
(Campaign Evolved adds sprint on L3 and a 1.4× smart-link zoom on all weapons; the PlayStation
Blog describes sprint as *"not drastically faster than the original movement speed"*, which
supports a modest ~1.2–1.35× multiplier).
[VERIFIED — https://blog.playstation.com/2026/07/23/13-ways-halo-campaign-evolved-modernizes-the-iconic-fps/]

---

## 5. (d) Sensitivity and turn-rate curves

### 5.1 Mouse

**Mouse input is displacement, not rate. Never multiply it by `dt`.** This is the single most
common bug in browser FPS code and it produces "my aim feels laggy and inconsistent".

The Quake/Source convention, inherited by nearly every FPS since:

```
degrees_turned = counts × sensitivity × m_yaw       with m_yaw = m_pitch = 0.022 (default)
```
[VERIFIED — `m_pitch = Cvar_Get("m_pitch", "0.022", ...)`, `m_yaw = Cvar_Get("m_yaw", "0.022", ...)`,
`sensitivity` default `"5"`, in
https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_main.c ; applied as
`cl.viewangles[YAW] -= m_yaw->value * mx` in `cl_input.c`]

The user-facing number should be **cm/360**, not "sensitivity":

```
cm_per_360 = 2.54 × 360 / (DPI × sensitivity × 0.022)
deg_per_count = 360 / (DPI × cm_per_360 / 2.54)
```

Typical competitive FPS range is 20–60 cm/360; a controller-Halo-equivalent pace is ~30–45.

```js
const DPI = 800, CM360 = 35;
const DEG_PER_COUNT = 360 / (DPI * CM360 / 2.54);   // ≈ 0.0327 °/count

let pendingDX = 0, pendingDY = 0;
addEventListener('mousemove', e => {
  // getCoalescedEvents recovers 1000 Hz mice that the browser batched into one event
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) { pendingDX += ev.movementX; pendingDY += ev.movementY; }
});

function applyMouse() {                        // call once per RENDER frame, not per tick
  yaw   -= pendingDX * DEG_PER_COUNT * DEG;
  pitch -= pendingDY * DEG_PER_COUNT * DEG;    // invert per user setting
  pitch  = Math.max(-89 * DEG, Math.min(89 * DEG, pitch));
  pendingDX = pendingDY = 0;
}
```

Mouse acceleration: Q3 has it and it defaults **off**
(`accelSensitivity = cl_sensitivity + rate * cl_mouseAccel`, `cl_mouseAccel` default 0).
Keep it off. [VERIFIED — `cl_input.c`, `CL_MouseMove`]

**Do not apply aim-assist magnetism to the mouse.** Halopedia is explicit that camera magnetism
"is only enabled for players using controllers — those on mouse and keyboard are not affected".
[VERIFIED — https://www.halopedia.org/Aim_assist]

### 5.2 Stick

Four stages, in order. The first three map exactly onto Halo Infinite's shipped settings, whose
official descriptions I quote below.

**Stage 1 — centre deadzone (scaled radial).** Josh Sutphin's canonical article:

```js
// Scaled Radial Dead Zone — preserves full 0..1 output range, no jump at the boundary
if (mag < deadzone) v = [0, 0];
else                v = normalize(v) * ((mag - deadzone) / (1 - deadzone));
```
[VERIFIED — https://joshsutphin.com/gamedev/doing-thumbstick-dead-zones-right.html ; the article
uses `0.25f` in its examples and notes real deadzones are "often somewhere between 0.1 to 0.2".
Also mirrored at https://www.gamedeveloper.com/business/doing-thumbstick-dead-zones-right]

343 calls this **Center Deadzone**: *"how far the move thumbstick is from center before the
minimum input registers."*

**Stage 2 — max input threshold.** 343: *"sets how far the thumbstick is from its maximum
movement in one direction before maximum input is registered … You want this to be a higher
value on your look stick, as you'll get more control through the entire range."*
[VERIFIED — https://support.halowaypoint.com/hc/en-us/articles/4407649252116 (descriptions also
summarised at https://www.gamesradar.com/halo-infinite-controller-settings/)]

Combine 1 and 2 into one remap:

```js
function stickShape(x, y, dz = 0.15, mit = 0.05) {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const t = Math.min((m - dz) / (1 - dz - mit), 1);      // 0..1 with a saturation shelf
  return [x / m * t, y / m * t];
}
```

**Stage 3 — response curve.** `rate = maxRate × pow(magnitude, k)`. `k = 1` is linear and feels
twitchy near centre; `k = 2` is the usual FPS default; `k = 3` gives very fine micro-aim at the
cost of a dead-feeling mid-range. Halo's `globals` → `player control` has a `look function`
sub-block with a `scale` float, which is where this curve lives; **the shape is not documented**.
[VERIFIED that the block exists — https://c20.reclaimers.net/h1/tags/globals/. Exponent
recommendation is [TUNED].]

**Stage 4 — turn acceleration (the Halo signature).** From `look peg threshold`,
`look acceleration time`, `look acceleration scale`:

```js
// pegRamp is state, persisted across ticks
const pegged = magnitude > LOOK_PEG_THRESHOLD;           // 0.90              [TUNED]
pegRamp = pegged
  ? Math.min(1, pegRamp + dt / LOOK_ACCEL_TIME)          // 0.35 s            [TUNED]
  : Math.max(0, pegRamp - dt / (LOOK_ACCEL_TIME * 0.5)); // release 2× faster [TUNED]

const rateMul = 1 + (LOOK_ACCEL_SCALE - 1) * pegRamp;    // LOOK_ACCEL_SCALE 2.5 [TUNED]
yaw   -= YAW_RATE   * rateMul * Math.pow(mx, 2) * dt;    // YAW_RATE   120 °/s [TUNED]
pitch -= PITCH_RATE * rateMul * Math.pow(my, 2) * dt;    // PITCH_RATE  90 °/s [TUNED]
```

So: 120 °/s at full stick, ramping to 300 °/s after 0.35 s of holding it pegged (3 s per 360°
becomes 1.2 s). Pitch at 0.75× yaw is the near-universal convention (your neck pitches less than
it yaws, and the vertical FOV is smaller).

**Stage 5 — aim assist, controller only.** Halo's three mechanisms, with the tag fields that
drive them:

| Mechanism | Tag field | Effect |
|---|---|---|
| Camera *friction* (slowdown) | `globals` → `player control` → `magnetism friction` | multiply turn rate by e.g. 0.55 while the reticle is inside `magnetism angle` of a target within `magnetism range` |
| Camera *adhesion* (tracking) | `globals` → `player control` → `magnetism adhesion` | add a turn rate that partially matches the target's angular velocity |
| Bullet magnetism / auto-aim | `weapon` → `autoaim angle` (deg), `autoaim range` (wu) | bend the fired ray toward the target's **autoaim pill** |

[VERIFIED field names — https://c20.reclaimers.net/h1/tags/globals/ and
https://c20.reclaimers.net/h1/tags/object/item/weapon/ ; the autoaim-pill mechanism is described
at https://c20.reclaimers.net/h1/tags/object/unit/biped/ . **No shipped values are published.**
Halopedia's overview: https://www.halopedia.org/Aim_assist]

Note that the autoaim pill is a *separate, larger* capsule from the collision model — Halo aims
at a fat forgiving volume but resolves hits against the real
`model_collision_geometry`. Suggested starting values [TUNED]: magnetism angle 5°, magnetism
range 25 m, friction 0.55, adhesion 0.35, autoaim angle 2.5°, autoaim range 30 m,
autoaim pill radius 1.6× the collision radius.

Also present and genuinely Halo: `look autolevelling scale` and `minimum autolevelling ticks` —
the pitch slowly returns toward the horizon while you are moving on a controller.
[VERIFIED field names — https://c20.reclaimers.net/h1/tags/globals/]. Suggested: after 12 ticks
(0.4 s) of no look input while moving, lerp pitch toward 0 at 8 °/s. [TUNED]

---

## 6. (e) Determinism under a fixed timestep

### 6.1 The loop

The canonical structure is Glenn Fiedler's "Fix Your Timestep!":

```cpp
double t = 0.0, dt = 0.01, currentTime = hires_time_in_seconds(), accumulator = 0.0;
while (!quit) {
    double newTime = time();
    double frameTime = newTime - currentTime;
    if (frameTime > 0.25) frameTime = 0.25;
    currentTime = newTime;
    accumulator += frameTime;
    while (accumulator >= dt) {
        previousState = currentState;
        integrate(currentState, t, dt);
        t += dt; accumulator -= dt;
    }
    const double alpha = accumulator / dt;
    State state = currentState * alpha + previousState * (1.0 - alpha);
    render(state);
}
```
[VERIFIED verbatim — https://gafferongames.com/post/fix_your_timestep/]

The JS version, with the FPS-specific modifications that matter:

```js
const DT        = 1 / 60;    // sim rate. 1/30 is Halo-native; 1/60 is safer in a browser.
const MAX_FRAME = 0.25;      // s — spiral-of-death guard
const MAX_STEPS = 8;

let acc = 0, prevT = performance.now() / 1000, tick = 0;
let prevState = snapshot(), curState = snapshot();

function frame(nowMs) {
  requestAnimationFrame(frame);
  const now = nowMs / 1000;
  let ft = now - prevT; prevT = now;
  if (ft > MAX_FRAME) ft = MAX_FRAME;
  acc += ft;

  // 1. VIEW ANGLES UPDATE AT RENDER RATE, from raw mouse displacement.
  //    Never inside the fixed tick — a 60 Hz tick would quantise a 144 Hz mouse.
  applyMouse();
  applyStick(ft);            // stick IS a rate, so it does take a dt — the render dt

  // 2. Fixed-step simulation. The tick reads the *current* view angles as its basis.
  let steps = 0;
  while (acc >= DT && steps < MAX_STEPS) {
    prevState = curState;
    simulate(DT, tick, buildUserCmd());
    curState = snapshot();
    acc -= DT; tick++; steps++;
  }
  if (steps === MAX_STEPS) acc = 0;      // give up catching up

  // 3. Interpolate position only. Angles come from step 1, already current.
  const alpha = acc / DT;
  const eye = lerpVec(prevState.eye, curState.eye, alpha);
  renderFrame(eye, yaw, pitch, alpha);
}
requestAnimationFrame(frame);
```

**Why angles are outside the tick.** If you integrate yaw/pitch inside a 60 Hz tick while
rendering at 144 Hz, one in every 2.4 frames shows no aim movement. Players report this as
"the mouse stutters" or "aim feels like it has input lag" even though latency is unchanged.
Q3 does the equivalent — it builds a `usercmd` per rendered frame carrying the already-updated
view angles.
[VERIFIED — `CL_MouseMove` writes `cl.viewangles` directly at client frame rate, `cl_input.c`]

### 6.2 Integration: use velocity-Verlet on the vertical axis

Semi-implicit (symplectic) Euler is the default advice and is fine for horizontal motion:

```js
v += a * dt;  p += v * dt;         // semi-implicit — stable, but apex is off
```

For the jump it matters, because your level metrics (§2.5) say a 2.44 m ledge must be reachable.
Semi-implicit Euler undershoots the analytic apex by roughly `v0·dt/2` = 7.03 × 0.0167 / 2
= **5.9 cm** at 60 Hz, and by 11.7 cm at 30 Hz — enough to make a ledge that "should" work fail
intermittently. Velocity-Verlet is exact for constant acceleration:

```js
p += v * dt + 0.5 * a * dt * dt;   // velocity-Verlet: apex is exactly v0²/(2g)
v += a * dt;
```

Pittman's GDC talk covers exactly this Euler-vs-Verlet apex discrepancy.
[VERIFIED as a topic of that talk — https://gdcvault.com/play/1023559/Math-for-Game-Programmers-Building]

Use Verlet for `y`, semi-implicit for `x`/`z` (horizontal has no constant acceleration term
anyway — it is a clamped chase toward a target).

### 6.3 Determinism checklist

- **Never call `performance.now()`, `Date.now()`, or `Math.random()` inside `simulate()`.**
  Pass `tick` in. Use a seeded PRNG:
  ```js
  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
  ```
- **Never write `x += (target - x) * 0.1`** — that is frame-rate dependent. Use
  `x += (target - x) * (1 - Math.exp(-dt / tau))`, which gives identical results at any `dt`
  for a first-order lag.
- **Store a `usercmd` per tick** (`{forward, right, buttons, yaw, pitch}` quantised to int8/int16
  the way Q3 does). If you can replay a recorded command stream and land in the same position,
  you are deterministic. This is also your regression test for movement changes.
- **Never let `dt` vary.** If you must support a 30 Hz sim on a 144 Hz display, that is what the
  accumulator + interpolation is for. Varying `dt` makes jump height frame-rate dependent — the
  original Halo's PAL bug in miniature (§1.2).
- **Order within the tick is part of the contract.** Fix it and document it:
  `read input → apply stun/slope modifiers → ground check → friction/accel → jump impulse →
  gravity → integrate → collide & slide → step-up → landing detection → camera state`.
  Applying gravity before vs after the jump impulse changes the apex by `g·dt²/2`.
- **Guard `normalize()` on zero-length vectors** — `[0/0, 0/0]` poisons the whole state with
  NaN and the player disappears. Every `Math.hypot` result needs an `< 1e-6` early-out.
- **Interpolation must not blend across teleports.** Carry a `snap` flag on the state; when set,
  `prevState = curState` before rendering.
- **Interpolate the camera's world position, but compute bob/dip/step offsets once, at render
  time**, from the interpolated clock (`tick*DT + alpha*DT`). If you simulate them in the tick
  *and* interpolate them you get double-smoothing and the dip loses its snap.
- Source's prediction-error smoothing (`cl_smooth 1`, `cl_smoothtime`) is the multiplayer analogue
  of the same idea, if you ever add networking.
  [VERIFIED — `c_baseplayer.cpp`]

---

## 7. (f) Failure modes, as a player would report them

Each entry: **what they say → what it is → how to see it in a screenshot or a 5-second capture.**

**"It feels floaty / like the moon."**
Hang time too long for the apex, or air control too permissive.
*Test:* record a jump at 60 fps and count frames from leaving ground to landing. Halo ≈ **83
frames (1.39 s)**. Quake 3 ≈ 40. Call of Duty ≈ 45. If you are over ~90 frames you are floaty
even by Halo standards. *Screenshot tell:* in a capture at apex, the horizon line sits
noticeably above the tops of chest-high cover for several consecutive frames — the camera
*hovers* rather than passing through the apex.
*Fix:* raise `GRAVITY_FALL_MUL` to 1.5–2.0 before you touch apex height; players read the
*descent* as the weight.

**"It feels sluggish / like walking through mud."**
Ramp-up time > ~0.35 s, or turn acceleration ramp > ~0.5 s, or input sampled at the sim rate.
*Test:* from standstill, how many frames until the speed readout hits 95 % of max? Halo ≈ 14
frames at 60 fps (0.23 s). Over 21 frames reads as sluggish.
*Screenshot tell:* nothing visible in a still — this one is only diagnosable from an on-screen
speed/accel debug readout. Ship one.

**"I slide like I'm on ice / the character doesn't stop."**
Deceleration too low, or you used multiplicative friction with no stop-speed floor so velocity
decays asymptotically and never reaches zero.
*Test:* run at full speed, release all input, measure the coast distance. Target **< 0.6 m**.
*Screenshot tell:* record the footstep-audio channel alongside video — footsteps continue for
several frames after the input released, or the weapon bob keeps cycling with no key down.
*Fix:* separate `DECEL` from `ACCEL`, and snap velocity to zero below ~0.15 m/s.

**"Diagonal movement is faster." / "Strafing is as fast as running."**
You clamped the wish velocity to a circle instead of the ellipse (§2.1), or you normalised the
input vector and multiplied by a single max speed.
*Test:* run a fixed 20 m course straight, then at 45°. Straight must win by ~6 %.

**"The bob makes me motion sick."**
Vertical camera bob amplitude > ~2 % of eye height, roll bob > ~1.5°, bob frequency not locked
to the footstep sound, or the bob continues while airborne.
*Test:* stand still, then strafe-run past a tall vertical pole or a doorframe at 3 m distance.
The vertical edge must stay visually vertical and must not visibly oscillate. If it wobbles, the
roll bob is too large.
*Screenshot tell:* compare two frames half a bob cycle apart — the horizon should shift by no
more than ~1 % of screen height.
*Fix:* move the bob to the viewmodel (§3.1). The gun can bob three times as hard as the camera
and nobody gets sick.

**"The camera keeps bouncing while I'm in the air."**
`bobPhase` advancing when `grounded === false`. HL2 deliberately *does* keep the cycle running
in air ("it snaps badly without it") but freezes the *amplitude* via speed. Freeze the phase and
fade the amplitude to zero over ~150 ms instead.

**"It micro-stutters even at 144 fps."**
No render interpolation — you are rendering the raw 60 Hz simulation state, so positions
advance in a 60 Hz staircase on a 144 Hz display.
*Screenshot tell:* pan slowly past a high-frequency texture (a grating, a brick wall). You will
see a repeating 2-frame / 3-frame beat pattern in the motion. It disappears the moment you add
`alpha` lerping.

**"My aim has input lag / the mouse feels rubbery."**
View angles integrated inside the fixed tick, or mouse delta multiplied by `dt`, or you smoothed
the mouse. All three. See §5.1 and §6.1.

**"The camera pops when I walk up steps."**
No step smoothing. Or, symmetrically: smoothing > ~250 ms, which players describe as *"the floor
feels spongy"* or *"I sink into the stairs"*.
*Screenshot tell:* run up a staircase and diff consecutive frames' horizon positions — an
unsmoothed step is a single-frame vertical jump of `STEP_HEIGHT`(0.366 m), roughly 6 % of screen
height at 55° vertical FOV. Very visible.

**"Landing has no impact."**
No dip, or a linear ramp with no overshoot.
*Fix:* the damped spring (§3.3) with `ζ ≈ 0.55–0.76` so it crosses zero once on the way back.
*Screenshot tell:* plot eye height vs time across a landing — it must dip, come back up *past*
the rest height by ~5–12 %, and settle. A pure exponential decay reads as a soft landing on a
mattress.

**"The gun is glued to the screen."**
No viewmodel lag (§4.5). *Test:* whip 90° in 200 ms — the gun should trail the reticle by
several degrees and settle over ~200 ms.

**"I can strafe-jump / bunny-hop to double my speed."**
You used Q3's projected `PM_Accelerate` in the air. Use the clamped wish-velocity form and the
speed cap (§2.2, §2.4). *Test:* jump repeatedly while circling the mouse; the speed readout must
not exceed `V_FWD`.

**"Jump height changes depending on my framerate."**
Variable `dt`, or gravity applied before the jump impulse in some frames and after in others.
*Test:* run the sim at 30, 60, 120, 144 Hz and log the apex. They must agree to < 1 mm with
Verlet, < 6 cm with semi-implicit Euler (§6.2).

**"Turning feels like I'm fighting the controller."**
Turn acceleration ramp too long, or `look peg threshold` too low so the ramp engages on partial
deflection, or a response-curve exponent of 3+ with no acceleration to compensate.

**"I can't get on that ledge the level obviously wants me on."**
Collision capsule, step height and jump apex are out of sync with the art. Bake §2.5's metrics
table into a test level: a staircase of ledges at 0.24, 0.37, 1.0, 2.44, 3.02 m and a series of
gaps at 3, 6, 9.5, 10.1 m. Every art asset should be authored against those numbers.

---

## 8. What I could not verify

Stated plainly, because an invented citation is worse than a gap.

1. **The `cyborg.biped` tag values themselves.** Bungie never published them and I found no
   public dump. Specifically unverified: `jump velocity`, `standing camera height`,
   `crouching camera height`, `crouch transition time`, `maximum soft/hard landing time`, the
   four landing velocity thresholds, `acceleration`, `deceleration`, `collision radius`,
   `autoaim width`, and every slope falloff/cutoff angle. I verified that each field **exists**
   and its **unit**, from c20's tag schema; the numbers I give for them are derived from
   Bungie's published level-design metrics or are my own tuning.

2. **Halo's gravity constant.** Nowhere published. My 10.14 m/s² is derived from the Halo 2
   editing-kit jump height (80 max units) and jump distance (312 max units) plus the verified
   2.25 wu/s run speed. HaloScript exposes `physics_set_gravity` "relative to Halo standard
   gravity" but c20 does not state what that standard is.

3. **The unit of `run acceleration = 0.32`.** c20 labels it wu/s²; taken literally it is
   physically implausible. My ×30 reinterpretation (9.6 wu/s²) is inference, not documentation.

4. **"Halo CE has no camera view bob."** I am confident from play, and the biped tag schema
   contains no bob fields, but I found no primary source asserting it.

5. **Halo's `look function` curve shape** and all `player control` values (`magnetism friction`,
   `magnetism adhesion`, `look default pitch/yaw rate`, `look acceleration time/scale`,
   `look peg threshold`, `look autolevelling scale`). Field names and the `look acceleration
   time` unit (seconds) are verified; every value is mine.

6. **The 5 % diagonal / 12 % strafe penalty figures.** These come from the Halo speedrunning
   wiki, which returned HTTP 402 to a direct fetch; I have them only via a search-engine
   snippet. They *do* match the ellipse model derived from verified tag values to within 1
   percentage point, which is why I trust them, but I did not read the page itself.

7. **Halo Infinite Forge unit = 1 foot.** Inferred from "grapple range is 80 units" against the
   commonly-cited ~25 m grappleshot range, and from agreement with Halo 2's 8-foot jump metric.
   343 does not define the unit on that page.

8. **Pittman's GDC 2016 slide equations.** The PDF host
   (`mathforgameprogrammers.com`) failed TLS negotiation from this machine, so I cite the talk
   and the standard `g = 2h/t²`, `v0 = 2h/t` result rather than quoting slides.

9. **Halo: Campaign Evolved's actual movement constants.** Nothing numeric is public. The only
   sourced statements are qualitative: sprint on L3, *"not drastically faster than the
   original"*, 1.4× smart-link zoom, regenerating health.

10. **Source engine unit → metre conversion** is genuinely ambiguous in Valve's own docs
    (1 unit = 1 inch vs 16 units = 1 foot). All Source/Quake m/s² figures in §2.6 carry that
    ±33 % uncertainty. The Halo figures do not — Halo's scale is pinned exactly.

---

## Appendix: source index

| Topic | URL |
|---|---|
| World-unit scale, JMS conversion | https://c20.reclaimers.net/general/scale/ |
| H1 biped tag: all fields, units, NTSC hard-coded speeds, autoaim pill | https://c20.reclaimers.net/h1/tags/object/unit/biped/ |
| H1 globals tag: player control, player information, falling damage | https://c20.reclaimers.net/h1/tags/globals/ |
| H1 weapon tag: autoaim/magnetism angle & range, error angle | https://c20.reclaimers.net/h1/tags/object/item/weapon/ |
| H1 physics tag: ground friction, ground normal k0/k1 | https://c20.reclaimers.net/h1/tags/physics/ |
| Bungie H2EK player metrics (speeds, jump, step, bbox, FOV, slope) | https://www.h2maps.net/editingkit/player%20statistics%20and%20metrics.html |
| Halo Infinite Forge player traversal metrics | https://support.halowaypoint.com/hc/en-us/articles/14796740242708 |
| Halo Infinite aim settings (deadzone, max input threshold, look accel) | https://support.halowaypoint.com/hc/en-us/articles/4407649252116 |
| Halo aim assist overview (controller-only magnetism) | https://www.halopedia.org/Aim_assist |
| Q3 movement: `PM_Accelerate`, `PM_Friction`, `PM_Footsteps`, `pm_*` consts | https://github.com/id-Software/Quake-III-Arena/blob/master/code/game/bg_pmove.c |
| Q3 `JUMP_VELOCITY 270`, `STEPSIZE 18`, `MIN_WALK_NORMAL 0.7`, `TIMER_LAND 130` | https://github.com/id-Software/Quake-III-Arena/blob/master/code/game/bg_local.h |
| Q3 camera: bob, land dip, step offset, damage kick | https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_view.c |
| Q3 timing consts `LAND_DEFLECT_TIME 150`, `LAND_RETURN_TIME 300`, `STEP_TIME 200`, `MAX_STEP_CHANGE 32`, `DUCK_TIME 100` | https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_local.h |
| Q3 `landChange` −8/−16/−24, `EV_STEP_*` accumulation | https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_event.c |
| Q3 `m_yaw`/`m_pitch` 0.022, `sensitivity` 5 | https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_main.c |
| Q3 mouse application, `cl_mouseAccel` | https://github.com/id-Software/Quake-III-Arena/blob/master/code/client/cl_input.c |
| Source movement, jump, `AirAccelerate`, `DecayPunchAngle`, landing roll | https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/gamemovement.cpp |
| Source `GAMEMOVEMENT_JUMP_HEIGHT 21`, `GetAirSpeedCap() 30` | https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/gamemovement.h |
| Source `sv_gravity/friction/accelerate/airaccelerate/stepsize/backspeed` defaults | https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/movevars_shared.cpp |
| Source fall thresholds, `TIME_TO_DUCK`, `TIME_TO_UNDUCK` | https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/shareddefs.h |
| HL2 viewmodel bob constants and formula | https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/shared/hl2/basehlcombatweapon_shared.cpp |
| HL2 `hl2_walkspeed 150`, `hl2_normspeed 190`, `hl2_sprintspeed 320` | https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/server/hl2/hl2_player.cpp |
| Fixed timestep + interpolation | https://gafferongames.com/post/fix_your_timestep/ |
| Building a Better Jump (GDC 2016, Kyle Pittman) | https://gdcvault.com/play/1023559/Math-for-Game-Programmers-Building |
| Thumbstick dead zones | https://joshsutphin.com/gamedev/doing-thumbstick-dead-zones-right.html |
| Halo tick rate 30 Hz → 60 Hz in MCC | https://github.com/Daylonz/MCCBounceEnable |
| Halo CE FOV / Vert− behaviour | https://www.pcgamingwiki.com/wiki/Halo:_Combat_Evolved |
| Campaign Evolved: sprint, controls, smart-link | https://blog.playstation.com/2026/07/23/13-ways-halo-campaign-evolved-modernizes-the-iconic-fps/ |
