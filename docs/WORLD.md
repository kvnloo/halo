# Silent Cartographer — world layout

All units are metres. This is the shared coordinate contract: terrain, rocks,
structures, vegetation, ocean, physics and the camera poses all depend on these
numbers. **Do not move a landmark without updating this file and re-tuning poses.**

## Axes

```
+X  east (along the beach, to the player's right at spawn)
+Y  up
+Z  inland / south         -Z  seaward / north
```

Sea level is `y = 0`. The camera looks down `-Z` at yaw 0 (three.js convention),
so yaw is measured counter-clockwise from north.

## Elevation profile (the beach cross-section at X = 0)

| Z      | y      | surface                                            |
|--------|--------|----------------------------------------------------|
| −340   | −26    | open ocean floor, out of sight                     |
| −180   | −11.0  | deep shelf, water reads dark blue                  |
| −70    | −4.2   | mid shelf, teal                                    |
| −26    | −1.15  | sandbar shallows, pale turquoise, caustics visible |
| −6.5   | 0.00   | mean waterline — swash zone                        |
| 0      | +0.35  | wet sand, mirror-ish, dark cobbles                 |
| +9     | +1.30  | damp sand, ripple texture                          |
| +22    | +2.75  | dry sand, wind ripples, footprint-scale relief     |
| +38    | +5.40  | back-beach berm, dune grass begins                 |
| +48    | +9.0   | talus slope, boulders                              |
| +58    | +26    | cliff face begins                                  |
| +72    | +58    | cliff top, grass / low scrub                       |

The profile is modulated along X: the beach is widest near `X = −20` and pinches
against a rock headland at `X = +95`. Tide pools sit in a shallow rock shelf at
`X ∈ [−70, −18], Z ∈ [−14, −2]`.

## Landmarks

| id            | kind                | centre (x, z) | base y | top y | radius | notes |
|---------------|---------------------|---------------|--------|-------|--------|-------|
| `cliff_main`  | cliff wall          | runs X −150…+190 at Z ≈ +62 | 8 | 52–66 | — | undercut base, hanging vines, grass crown |
| `bridge`      | Forerunner span     | anchor (+54, +60) → tip (−34, −4) | — | deck 21.5 | — | see below |
| `stack_hero`  | sea stack + tree    | (−38, −92)    | −4.0   | +38   | 15   | flat-crowned tree on top, the hero silhouette |
| `stack_arch`  | sea stack, undercut | (+34, −70)    | −3.4   | +41   | 17   | deep wave-cut notch at y ≈ 2 |
| `stack_twin_a`| sea stack           | (−96, −140)   | −7.5   | +44   | 19   | moss crown, hanging vine curtain |
| `stack_twin_b`| sea stack           | (−128, −172)  | −9.0   | +33   | 13   | |
| `stack_far_a` | sea stack           | (+120, −210)  | −12    | +36   | 16   | aerial-perspective heavy |
| `stack_far_b` | sea stack           | (+156, −246)  | −13    | +30   | 12   | |
| `headland`    | rock headland       | (+108, +20)   | 0      | +34   | 40   | closes the beach to the east |
| `islet_field` | distant islands     | Z < −620      | —      | 10–40 | —    | pure silhouette + haze, no detail |

### `bridge` — the Forerunner span

The dominant man-made silhouette. A single cantilevered deck emerging from the cliff
and reaching out over the beach, cut off at the tip (it is a ruin).

```
deck:      21.5 m above sea level, 15.5 m wide, 2.6 m thick
run:       from (54, 60) in the cliff face to (−34, −4) over the shallows
underside: coffered — recessed panels with a 0.35 m rib grid
struts:    two raked A-frames, feet at (6, 30, y 2.4) and (−26, 2, y 0.6),
           each a pair of tapered blades meeting the deck at ~62°
edge:      chamfered rail 0.9 m tall with a continuous recessed channel
emissive:  pale cyan (#7fd8ff) light strips in the channel and at the strut joints,
           low intensity — they read as accents in daylight, not as light sources
material:  weathered forerunner alloy — desaturated warm grey, roughness 0.35–0.62,
           faint anisotropic brush along the run direction, subtle vertical streaking
```

## Sky

| feature      | placement |
|--------------|-----------|
| sun          | azimuth 118° (from +X, slightly seaward), elevation 41°, angular diameter 0.54° |
| Halo ring    | band crossing the sky; near edge rises from the horizon at azimuth ≈ 300°, apparent width 3.4°, sweeping overhead. Inner surface faintly shows landmass banding. Translucent, additive over sky |
| Threshold    | gas giant, azimuth 342°, elevation 22°, angular diameter 26°. Banded ochre/mauve, terminator toward the sun, very soft limb |
| clouds       | cumulus congestus, base 900 m, top 2600 m, coverage 0.52, strongly lit tops, flat shadowed bases |
| horizon haze | dense — the reference dissolves distant stacks into a pale warm band. Aerial perspective must be aggressive |

## Lighting reference (measured from the clip)

```
sun colour        warm white, ~5600 K at 41° elevation
sky ambient       strong blue bounce into shadows — shadows are never black
                  (reference shadow_frac = 0.050, p01 = 17 — nothing crushes)
bounce            sand throws a noticeable warm bounce up onto rock undersides
                  and onto the weapon; without it the viewmodel reads pasted-on
exposure          keyed so wet sand highlights sit ~215, sun glints clip briefly only
```

## Player

```
spawn        (6, 1.72, 16), yaw 288°   (looking WNW down the beach at the bridge)
eye height   1.72 standing, 1.05 crouched
radius       0.42, step height 0.55
walk 3.6 m/s   sprint 6.4 m/s   crouch 1.9 m/s
gravity 19.6 m/s²   jump apex 1.05 m
```

## Named capture poses

`src/world/poses.js` holds camera poses matched to specific frames of
`reference.mp4`. Each is keyed `ref_NNNNN` where NNNNN is the source frame index,
matching `ref/keyframes/kf_NNNNN.png`. These numbers are the substrate of every
recorded score — treat them as immutable unless you are explicitly running a
pose-refit task.
