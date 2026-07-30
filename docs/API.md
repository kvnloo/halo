# Cross-module API contract

Modules never import each other. They find each other at runtime with
`ctx.get('name')` and call the methods listed here. **These signatures are frozen.**
If you own a module below, you must implement its interface exactly. If you consume
one, code against it — and always guard, because a module may not be loaded
(`?only=` isolation, or it simply has not landed yet):

```js
const terrain = ctx.get('terrain');
const y = terrain ? terrain.height(x, z) : 0;
```

---

## `time`  — already implemented

```js
time.sunDir        // THREE.Vector3, unit, points TOWARD the sun
time.sunColor      // THREE.Color, linear
time.skyColor      // THREE.Color, linear
time.wind          // THREE.Vector3, m/s, world space
time.state         // { azimuthDeg, elevationDeg, sunIntensity, sunAngularRadius,
                   //   turbidity, windDir, windSpeed, gust }
time.sunAltitudeFactor  // 0..1
```

## `lighting` — already implemented

```js
lighting.csm                 // the CSM instance
lighting.registerMaterial(m) // MUST be called for any material that receives sun
                             // shadows. applyWorldMaterial() does this for you.
```

## `sky`

```js
sky.radiance(dir: THREE.Vector3): THREE.Color   // linear radiance in a world direction
sky.envTexture: THREE.Texture | null            // equirect or cube, HDR, for PMREM
sky.uniforms: object                            // shared uniform block; ocean and
                                                // clouds sample the same atmosphere
sky.horizonColor: THREE.Color                   // used by aerial perspective + fog
sky.needsEnvUpdate: boolean                     // set true when the sky changes
```

## `clouds`

```js
clouds.buffer: THREE.Texture      // RGBA half-float: rgb = scattered radiance,
                                  // a = transmittance. Half resolution.
clouds.shadowTexture: THREE.Texture | null   // top-down cloud shadow map, or null
clouds.coverage: number           // 0..1, read by sky and by lighting for sun occlusion
```

## `env`

```js
env.probe: THREE.Texture          // PMREM-filtered environment for IBL
env.irradiance: THREE.Color[]     // SH9 or a small irradiance cube
env.refresh(ctx): void            // re-capture (expensive; call rarely)
```

## `terrain`  — **the most-consumed API in the project**

```js
terrain.height(x, z): number                 // world Y of the surface. Must be fast:
                                             // it is called thousands of times per frame
                                             // by vegetation scatter and physics.
terrain.normal(x, z, out?): THREE.Vector3    // unit surface normal
terrain.sample(x, z): {
  y: number,
  normal: THREE.Vector3,
  slope: number,      // 0 = flat, 1 = vertical
  wetness: number,    // 0 dry .. 1 submerged/saturated — drives foam, spray, footfall
  material: number,   // MAT_ID from src/gfx/GBufferMaterial.js
}
terrain.raycast(origin: Vector3, dir: Vector3, maxDist: number): {point, normal, t} | null
terrain.bounds: { minX, maxX, minZ, maxZ }
```

`height()` must be defined for **every** (x, z), including out past the sea stacks
(return the seafloor there) — callers do not bounds-check.

## `rocks`

```js
rocks.landmarks: Map<string, { object3D, center: Vector3, radius, topY }>
rocks.surfacePoint(landmarkId, u, v): { point, normal } | null   // for vine/moss scatter
rocks.colliders: Array<{ type, ... }>   // handed to physics
```

## `structures`

```js
structures.bridge: THREE.Object3D
structures.deckY: number                 // 21.5
structures.colliders: Array<...>
structures.walkableSurfaces: Array<...>  // for AI navigation
```

## `ocean`

```js
ocean.level: number                                  // 0
ocean.heightAt(x, z, t): number                      // displaced wave height
ocean.normalAt(x, z, t, out?): THREE.Vector3
ocean.depthAt(x, z): number                          // level - terrain.height(x,z)
ocean.isSubmerged(p: Vector3): boolean
ocean.foamAt(x, z, t): number                        // 0..1, for spray spawning
```

## `physics`

```js
physics.raycast(origin, dir, maxDist, mask?): { point, normal, t, body } | null
physics.sphereCast(origin, dir, radius, maxDist, mask?): hit | null
physics.addStatic(collider): id
physics.addBody(desc): body            // { position, velocity, mass, restitution, ... }
physics.removeBody(id): void
physics.step(dt): void                 // called from update(); fixed substeps internally
physics.overlapSphere(center, radius, mask?): body[]
physics.MASK: { WORLD, CHARACTER, PROJECTILE, DEBRIS, ALL }
```

## `player`

```js
player.position: THREE.Vector3     // feet
player.eye: THREE.Vector3          // camera position
player.velocity: THREE.Vector3
player.yaw: number                 // radians
player.pitch: number
player.grounded: boolean
player.crouching: boolean
player.sprinting: boolean
player.health: number              // 0..1
player.shield: number              // 0..1
player.damage(amount, direction): void
player.applyRecoil(pitch, yaw): void
player.viewBobOffset: THREE.Vector3   // read by weapons for viewmodel sway
```

## `weapons`

```js
weapons.current: { id, name, ammo, reserve, magSize, rpm, spread, ... }
weapons.isFiring: boolean
weapons.isReloading: boolean
weapons.adsAmount: number          // 0..1
weapons.fire(): void
weapons.reload(): void
weapons.switchTo(id): void
weapons.muzzleWorldPosition: THREE.Vector3
```

## `ai`

```js
ai.actors: Array<{ id, type, position, health, alive, faction }>
ai.spawn(type, position): actor
ai.damage(actorId, amount, hitPoint, direction): void
ai.nearestTo(point, faction?): actor | null
```

## `hud`

```js
hud.setHitMarker(kind): void       // 'hit' | 'shield' | 'kill'
hud.showPickup(text): void
hud.flashDamage(direction): void
```

## `audio`

```js
audio.play(id, opts?): handle          // opts: { position, volume, pitch, loop }
audio.stop(handle): void
audio.setListener(position, quaternion, velocity): void
audio.ambience(id, volume): void
```

---

## Events on the bus

```js
ctx.emit('weapon:fired',   { weapon, origin, direction })
ctx.emit('weapon:impact',  { point, normal, material, surface })
ctx.emit('actor:damaged',  { actor, amount, point })
ctx.emit('actor:killed',   { actor, point })
ctx.emit('player:damaged', { amount, direction })
ctx.emit('player:footstep',{ position, material, running })
ctx.emit('camera:teleport',{ pos, rot })
ctx.emit('engine:ready')
ctx.emit('engine:resize',  { w, h })
```

Emit these even if nothing listens yet. Consumers subscribe defensively.
