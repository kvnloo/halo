# MA5B Assault Rifle — viewmodel specification

Derived from `ref/detail/weapon_4k.png` (a 1900×1080 crop of the native 4K reference
at frame 1500). Look at that image before building anything.

The viewmodel occupies roughly the bottom-right quarter of every frame in the clip. It
is on screen 100% of the time, so its quality is weighted far above its screen area.

## Measured signature

```
region 'weapon':  lum_mean 79.8   lum_std 49.4   sat_mean 73.5
                  lab_a +1.9  lab_b +0.05
                  lap_var 489   edge_density 0.089   local_contrast 0.178
                  spectral_slope -2.63
```

The gun is **26% darker than the frame average** and carries the **highest local
contrast in the image**. It is a dark, matte, near-neutral object with sharp specular
breakup on its chamfers — not a mid-grey prop lit to match the background.

## Silhouette and layout

The rifle is held low-right, canted, with the receiver running diagonally from bottom
-right to upper-left. Left gloved hand supports the fore-end at lower-left of the
viewmodel; the right hand is off-screen behind the grip.

```
                    ___
                   /   \  <- triangular ammo-counter housing, canted ~12deg left,
                  / [36]\    standing proud above the receiver
   __________────┴───────┴──────────
  |  ribbed shroud | flat top rail  |    <- receiver, runs to lower-right
  |________________|________________|
        ^ slotted cooling vent
     [gloved hand]
```

## Parts, from the reference

| part | detail |
|------|--------|
| ammo counter housing | Rounded-triangle shell, ~2.5 mm chamfer on every edge, catching a hard rim highlight. Screen inset ~3 mm with a dark bezel. |
| counter screen | Dark teal-black (#0b1c22) with cyan-white emissive elements: UNSC eagle/wing glyph at top, a circular "rotate/reload" glyph below it, then **36** in a large squarish digital face, then a short horizontal magazine bar at the bottom. Faint scanline and a subtle glass reflection over the whole panel. Emissive but LOW intensity — it does not light the gun. |
| receiver top rail | Flat, slightly brushed, with a milled recess running its length and a circular port near the rear. Engraved UNSC lettering and an eagle mark, very low contrast — visible only as a roughness/normal break, not as painted text. |
| barrel shroud | Ribbed heat shield: ~8 raised ribs, plus a long rectangular slotted vent on the left face showing dark interior. |
| carry handle / fore grip | Cylindrical ribbed grip below the barrel, ~14 fine annular ribs. |
| indicator | Small green LED (#7dff9a) with "PUSH" micro-text beside it, low on the receiver. |
| magazine | Rectangular, ahead of the trigger group, matte, slightly lighter than the receiver. |
| hands | Black tactical gloves: fabric weave normal detail, hard armoured knuckle/finger plates with a rubbery sheen, visible stitching. The MJOLNIR forearm plate is just in frame at the bottom-right corner. |

## Material

```
body       base colour ~#2b2d30 linear, roughness 0.40-0.62 varying,
           metalness 0.65 on machined surfaces / 0.0 on polymer panels
wear       edge-wear mask: exposed lighter metal (#6a6d72) on chamfers and
           high-traffic corners, driven by a curvature/AO mask, NOT painted by hand
scratches  fine anisotropic scratch normal detail aligned along the receiver
grime      subtle darkening in recesses; the gun is used, not filthy
glove      base #101114, roughness 0.72, weave normal at ~1 mm scale
```

## Motion — this is what separates a AAA viewmodel from a static prop

| motion | behaviour |
|--------|-----------|
| idle sway | Low-amplitude Perlin drift, ~0.35 deg, ~0.4 Hz, on pitch/yaw/roll. Never zero. |
| look lag | The weapon lags the camera on fast turns and settles with a critically-damped spring (~14 rad/s). This is the single most important cue. |
| walk bob | Figure-of-eight, coupled to the player's step phase from `player.viewBobOffset`. Vertical ~1.4 cm, lateral ~0.9 cm. Amplitude scales with speed; sprint is a distinct, larger, slower arc with the weapon canted down and in. |
| landing | Sharp downward dip with an overshoot on landing, proportional to impact velocity. |
| fire | Recoil impulse: backward translation, upward pitch kick, small random yaw, recovering on a spring. The counter decrements. Bolt/charging handle cycles. Muzzle flash lights the gun and the near world for 2 frames. Shell ejects to the right with physics. |
| reload | Full animation: magazine out, new magazine in, bolt release, counter resets to 60. Roughly 2.6 s. |
| ADS | Not a scope — the MA5B has no zoom in the clip. A modest raise/centre with a ~1.15× FOV pull is sufficient. |

## Rendering notes

- Draw on `LAYER.VIEWMODEL`, which the scene pass renders with its own camera
  (`pipe.viewCamera`, near 0.002) after clearing depth. That is what stops a 40 cm-long
  object from clipping into terrain.
- It still needs to be lit by the same sun, sky fill and warm sand bounce as the world,
  or it reads as pasted on. Register its materials with `lighting.registerMaterial`.
- It must write into the G-buffer with `MAT_ID.VIEWMODEL` so motion blur and TAA treat
  it correctly — a viewmodel that ghosts under TAA is an instant tell.
- Aerial perspective must be **off** for viewmodel materials (`aerial: false`).
