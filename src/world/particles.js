import * as THREE from 'three';
import { LAYER, FullScreenQuad, fsMaterial, makeRT } from '../render/RenderPipeline.js';
import { HASH_GLSL, GRAD_NOISE_GLSL } from '../gfx/glsl/noise.js';

/**
 * `particles` — the fine-motion layer: wind-blown sand, sea spray, dust motes in the
 * shafts under the bridge, pollen over the dune grass, birds circling the stacks, and
 * every gameplay impact / muzzle / footstep / explosion effect, plus projected decals.
 *
 * ## Design
 *
 * One GPU-driven system, used twice:
 *
 *   - `ambient`  256x64 = 16384 particles, self-respawning entirely on the GPU.
 *                Rows partition the texture by emitter class so each class can be
 *                drawn with its own material in one instanced draw call:
 *                  rows  0..27  sand      (7168)
 *                  rows 28..47  sea spray (5120)
 *                  rows 48..55  dust motes(2048)
 *                  rows 56..63  pollen    (2048)
 *   - `fx`       128x48 = 6144 particles, spawned from the event bus. Rows 0..23 are
 *                the alpha-blended half (smoke, grit, droplets, chips), rows 24..47 the
 *                additive half (sparks, plasma, fire, shockwaves, methane).
 *
 * State lives in three FloatType MRT attachments, ping-ponged:
 *     0: xyz = world position, w = age (s)
 *     1: xyz = velocity,       w = life (s)
 *     2: x = subtype, y = size (m), z = seed, w = respawn cycle / growth rate
 *
 * Simulation is a full-screen fragment pass. Spawning writes single texels with a
 * `GL_POINTS` pass so no CPU readback or per-frame texture upload is ever needed.
 * Drawing is one `InstancedBufferGeometry` per material; the vertex shader
 * `texelFetch`es its own state and builds a view-space billboard.
 *
 * ## Soft particles and decals need a depth *copy*
 *
 * `pipe.depthTex` is attached to `pipe.sceneRT`, so sampling it while the EFFECTS layer
 * draws into that same target is a rendering feedback loop (INVALID_OPERATION under
 * ANGLE, not merely undefined). So the first EFFECTS-layer object is an invisible probe
 * whose `onBeforeRender` blits depth into a private R32F target — the same trick
 * three's own Reflector/Refractor use — and everything downstream samples that copy.
 * Decals are projected onto it: a box is rasterised, the fragment reconstructs the
 * world position of whatever the depth buffer says is visible, and discards outside the
 * box. No decal geometry is ever added to the world.
 *
 * ## Determinism
 *
 * The simulation is iterative, so it is only reproducible if the *frame sequence* is.
 * It is: every value comes from `pipe.frameIndex`, `ctx.clock.t`, a fixed `dt`, and
 * `ctx.rand.fork()`. `camera:teleport` re-seeds the ambient field around the new camera
 * (the capture harness poses the camera then advances a fixed number of frames), so
 * two captures of the same pose run identical instruction streams.
 */

/* ------------------------------------------------------------------ constants */

const AMB_W = 256, AMB_H = 64;
const ROW_SAND = 28, ROW_SPRAY = 48, ROW_DUST = 56, ROW_POLLEN = 64;

const FX_W = 128, FX_H = 48;
const FX_SPLIT = 24;               // rows [0,24) alpha-blended, [24,48) additive
const FX_MAX_SPAWN = 900;          // texels writable in one frame

const DECAL_MAX = 64;
const DEBRIS_MAX = 48;
const BIRD_COUNT = 18;
const SHORE_PROBES = 64;

// Baked ground field. Covers the whole playable box from docs/WORLD.md with margin.
const G_N = 192;
const G_MIN_X = -240, G_MAX_X = 240, G_MIN_Z = -320, G_MAX_Z = 180;

/** Sea stacks from docs/WORLD.md — the fallback while `rocks` has not landed. */
const STACK_FALLBACK = [
  { x: -38, z: -92, r: 15, top: 38 },
  { x: 34, z: -70, r: 17, top: 41 },
  { x: -96, z: -140, r: 19, top: 44 },
  { x: -128, z: -172, r: 13, top: 33 },
  { x: 120, z: -210, r: 16, top: 36 },
  { x: 156, z: -246, r: 12, top: 30 },
];

/** Bridge run from docs/WORLD.md: anchor (54,60) in the cliff -> tip (-34,-4). */
const BRIDGE_FALLBACK = { ax: 54, az: 60, bx: -34, bz: -4, deckY: 21.5 };

/** Beach cross-section at X = 0 (docs/WORLD.md), used only when `terrain` is absent. */
const PROFILE = [
  [-420, -30], [-340, -26], [-180, -11], [-70, -4.2], [-26, -1.15],
  [-6.5, 0], [0, 0.35], [9, 1.3], [22, 2.75], [38, 5.4],
  [48, 9], [58, 26], [72, 58], [200, 62],
];

function profileY(z) {
  if (z <= PROFILE[0][0]) return PROFILE[0][1];
  const n = PROFILE.length;
  if (z >= PROFILE[n - 1][0]) return PROFILE[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (z <= PROFILE[i][0]) {
      const [z0, y0] = PROFILE[i - 1], [z1, y1] = PROFILE[i];
      return y0 + (y1 - y0) * ((z - z0) / (z1 - z0));
    }
  }
  return 0;
}

/** Beach is widest near X=-20 and pinches against the headland at X=+95. */
function fallbackHeight(x, z) {
  const zoff = -8 + 16 * Math.min(1, Math.max(0, (x + 20) / 115));
  return profileY(z + zoff);
}

/* ---------------------------------------------------------------- GLSL shared */

const SIM_COMMON = /* glsl */`
${HASH_GLSL}
${GRAD_NOISE_GLSL}

uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAux;
uniform sampler2D uGroundTex;
uniform vec2  uGroundMin;
uniform vec2  uGroundSize;
uniform float uDt;
uniform float uTime;
uniform vec3  uWind;
uniform vec3  uCamPos;
uniform float uGust;

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oAux;

/** R = height, G = wetness, B = slope, A = material id / 255. */
vec4 groundAt(vec2 xz){
  vec2 g = (xz - uGroundMin) / uGroundSize;
  if (any(lessThan(g, vec2(0.0))) || any(greaterThan(g, vec2(1.0)))) return vec4(-30.0, 1.0, 0.0, 0.0);
  return texture(uGroundTex, g);
}

vec3 turbulence(vec3 p, float t){
  vec3 q = p * 0.085 + vec3(0.0, t * 0.21, 0.0);
  return vec3(gnoise3(q), gnoise3(q + 19.7), gnoise3(q + 43.1));
}
`;

/* ------------------------------------------------------- ambient simulation */

const AMBIENT_SIM = SIM_COMMON + /* glsl */`
uniform sampler2D uShoreTex;      // ${SHORE_PROBES}x1 : x, z, foam, phase
uniform vec4  uStacks[8];         // xz centre, z radius, w top y
uniform float uStackCount;
uniform vec4  uBridge;            // anchor xz -> tip xz
uniform float uDeckY;
uniform vec4  uRows;              // row boundaries: sand, spray, dust, pollen

void respawn(int type, vec2 tc, float cyc, out vec4 P, out vec4 V, out vec4 A){
  vec3 r1 = hash33(vec3(tc.x * 0.7310, tc.y * 1.1170, cyc * 2.3170 + 0.5));
  vec3 r2 = hash33(vec3(tc.y * 0.9130 + 11.0, cyc * 1.7710 + 3.0, tc.x * 0.5770));
  vec3 r3 = hash33(vec3(cyc * 0.4310 + 7.0, tc.x * 1.3310, tc.y * 0.2590 + 5.0));

  P = vec4(0.0); V = vec4(0.0, 0.0, 0.0, 1.0); A = vec4(0.0, 0.0, r1.x, cyc);

  if (type == 0) {
    // ---- wind-blown sand: sheets and grit streaming off the dry beach -------
    vec2 wdir = normalize(uWind.xz + vec2(1e-4, 1e-4));
    vec2 p = uCamPos.xz + (r1.xy * 2.0 - 1.0) * 62.0 - wdir * 22.0;
    vec4 g = groundAt(p);
    float dry  = 1.0 - smoothstep(0.15, 0.55, g.y);
    float high = smoothstep(0.20, 1.30, g.x);
    float level = 1.0 - smoothstep(0.35, 0.70, g.z);
    float live = step(r2.x, 0.10 + 0.90 * uGust) * dry * high * level;
    float sheet = step(0.84, r3.y);
    P.xyz = vec3(p.x, g.x + 0.015 + r1.z * r1.z * 1.15, p.y);
    V.xyz = uWind * (0.68 + 0.55 * r2.y) + (r3.xyz - vec3(0.5, 0.28, 0.5)) * 1.5;
    V.w   = 1.9 + 2.7 * r2.z;
    A.x   = sheet;
    A.y   = live * mix(0.035 + 0.085 * r3.x, 0.40 + 0.75 * r3.x, sheet);
  } else if (type == 1) {
    // ---- sea spray: shoreline foam plus wave strike on the stacks -----------
    float useStack = step(r2.x, 0.42) * step(1.0, uStackCount);
    if (useStack > 0.5) {
      int si = int(min(uStackCount - 1.0, floor(r2.y * uStackCount)));
      vec4 S = uStacks[si];
      float ang = (r3.x * 2.0 - 1.0) * 1.45;
      vec2 d = vec2(sin(ang), -cos(ang));                 // seaward-facing arc
      vec2 p = S.xy + d * (S.z * (0.92 + 0.16 * r3.y));
      // waves arrive in sets; a stack only throws spray on the beat
      float beat = step(0.42, fract(uTime * 0.27 + float(si) * 0.41));
      P.xyz = vec3(p.x, 0.15 + 3.4 * r3.z * r3.z, p.y);
      V.xyz = vec3(d.x, 0.0, d.y) * (1.6 + 5.0 * r1.x)
            + vec3(0.0, 4.5 + 7.0 * r1.y, 0.0) + uWind * 0.35;
      V.w   = 1.5 + 1.8 * r1.z;
      A.x   = step(0.55, r2.z);
      A.y   = beat * mix(0.030 + 0.10 * r3.x, 0.35 + 0.60 * r3.x, A.x);
    } else {
      int pi = int(floor(r2.y * ${SHORE_PROBES}.0));
      vec4 sp = texelFetch(uShoreTex, ivec2(pi, 0), 0);
      vec2 p = sp.xy + (r3.xy * 2.0 - 1.0) * vec2(4.0, 1.8);
      float foam = smoothstep(0.10, 0.45, sp.z);
      P.xyz = vec3(p.x, 0.04 + 0.55 * r3.z, p.y);
      V.xyz = vec3((r1.x - 0.5) * 1.4, 1.7 + 3.4 * r1.y, -(0.7 + 2.4 * r1.z)) + uWind * 0.30;
      V.w   = 1.2 + 1.5 * r2.z;
      A.x   = step(0.62, r2.z);
      A.y   = foam * mix(0.026 + 0.075 * r3.x, 0.28 + 0.45 * r3.x, A.x);
    }
  } else if (type == 2) {
    // ---- dust motes hanging in the light shafts under the bridge deck -------
    float t = r1.x;
    vec2 run = uBridge.zw - uBridge.xy;
    vec2 perp = normalize(vec2(-run.y, run.x));
    vec2 p = mix(uBridge.xy, uBridge.zw, t) + perp * (r1.y * 2.0 - 1.0) * 9.5;
    // the coffered underside cuts the sun into bands; motes only glint in them
    float shaft = smoothstep(0.45, 0.95, sin(dot(p, perp) * 1.9 + t * 5.0) * 0.5 + 0.5);
    float gy = max(groundAt(p).x, 0.15);
    P.xyz = vec3(p.x, mix(gy + 0.4, uDeckY - 1.2, r1.z), p.y);
    V.xyz = uWind * 0.10 + (r2.xyz - vec3(0.5, 0.35, 0.5)) * 0.42;
    V.w   = 6.0 + 9.0 * r3.x;
    A.y   = shaft * (0.011 + 0.030 * r3.y);
  } else {
    // ---- pollen drifting off the back-beach dune grass ----------------------
    vec2 p = uCamPos.xz + (r1.xy * 2.0 - 1.0) * 40.0;
    vec4 g = groundAt(p);
    float band = smoothstep(3.4, 5.2, g.x) * (1.0 - smoothstep(10.0, 17.0, g.x));
    P.xyz = vec3(p.x, g.x + 0.25 + r1.z * 2.4, p.y);
    V.xyz = uWind * 0.18 + (r2.xyz - 0.5) * 0.5;
    V.w   = 5.0 + 6.5 * r3.x;
    A.y   = band * (0.010 + 0.020 * r3.y);
  }
}

void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2  tf = vec2(tc);
  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  vec4 A = texelFetch(tAux, tc, 0);

  float row = tf.y;
  int type = row < uRows.x ? 0 : (row < uRows.y ? 1 : (row < uRows.z ? 2 : 3));

#ifdef INIT
  respawn(type, tf, 0.0, P, V, A);
  // stagger the initial ages so the field does not pulse in unison
  P.w = hash12(tf * 0.371 + 3.7) * V.w;
#else
  float dt = uDt;
  P.w += dt;

  float grav  = type == 0 ? 6.5 : (type == 1 ? 9.2 : (type == 2 ? 0.05 : 0.09));
  float drag  = type == 0 ? 1.7 : (type == 1 ? 0.85 : (type == 2 ? 0.55 : 0.85));
  float wsc   = type == 0 ? 1.0 : (type == 1 ? 0.55 : (type == 2 ? 0.12 : 0.30));
  float turb  = type == 0 ? 2.6 : (type == 1 ? 1.6 : (type == 2 ? 0.30 : 0.55));

  vec3 acc = vec3(0.0, -grav, 0.0);
  acc += (uWind * wsc - V.xyz) * drag;
  acc += turbulence(P.xyz, uTime) * turb;
  V.xyz += acc * dt;
  P.xyz += V.xyz * dt;

  float gy = groundAt(P.xz).x;
  if (P.y < gy) {
    if (type == 0) {                       // grit skitters along the surface
      P.y = gy + 0.01;
      V.y = abs(V.y) * 0.28;
      P.w += dt * 1.6;
    } else if (type == 1) {                // droplets are absorbed
      P.w = V.w;
    } else {
      P.y = gy + 0.05; V.y = abs(V.y) * 0.2;
    }
  }

  if (P.w >= V.w) respawn(type, tf, A.w + 1.0, P, V, A);
#endif

  oPos = P; oVel = V; oAux = A;
}
`;

/* ------------------------------------------------------ gameplay simulation */

const FX_SIM = SIM_COMMON + /* glsl */`
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  vec4 A = texelFetch(tAux, tc, 0);

#ifdef INIT
  oPos = vec4(0.0); oVel = vec4(0.0, 0.0, 0.0, 1.0); oAux = vec4(0.0, 0.0, 0.0, 0.0);
  oPos.w = 2.0;                                   // born dead
  return;
#endif

  if (P.w < V.w) {
    float dt = uDt;
    int s = int(A.x + 0.5);
    P.w += dt;

    //             smoke grit  drop  chip  spark plasma fire  ring  methane
    float grav = s == 0 ? -1.4 : s == 1 ? 17.0 : s == 2 ? 15.0 : s == 3 ? 18.0
               : s == 4 ? 12.0 : s == 5 ? 1.2  : s == 6 ? -3.4 : s == 7 ? 0.0 : -1.0;
    float drag = s == 0 ? 1.9  : s == 1 ? 1.1  : s == 2 ? 0.9  : s == 3 ? 0.5
               : s == 4 ? 2.2  : s == 5 ? 2.6  : s == 6 ? 2.4  : s == 7 ? 3.4 : 1.5;
    float wsc  = s == 0 ? 0.85 : s == 6 ? 0.7 : s == 8 ? 0.5 : 0.18;
    float turb = s == 0 ? 1.5  : s == 6 ? 2.4 : s == 8 ? 1.2 : 0.35;

    vec3 acc = vec3(0.0, -grav, 0.0);
    acc += (uWind * wsc - V.xyz) * drag;
    acc += turbulence(P.xyz, uTime) * turb;
    V.xyz += acc * dt;
    P.xyz += V.xyz * dt;
    A.y = max(0.0, A.y + A.w * dt);               // growth (smoke, fire, rings)

    float gy = groundAt(P.xz).x;
    if (P.y < gy) {
      if (s == 1 || s == 3 || s == 4) {           // grit, chips, sparks bounce
        P.y = gy + 0.005;
        V.y = abs(V.y) * (s == 3 ? 0.34 : 0.18);
        V.xz *= 0.65;
        P.w += dt * (s == 4 ? 6.0 : 1.5);
      } else if (s == 2) {
        P.w = V.w;                                // droplets land
      } else {
        P.y = gy + 0.02; V.y = max(V.y, 0.0);     // smoke rolls out along the ground
        V.xz *= 1.02;
      }
    }
  }

  oPos = P; oVel = V; oAux = A;
}
`;

/* ------------------------------------------------------------- spawn (points) */

const SPAWN_VERT = /* glsl */`
precision highp float;
in float aSlot;
in vec3  position;
in vec3  aVel;
in vec4  aAux;
uniform vec2 uTexSize;
out vec3 vP; out vec3 vV; out vec4 vA;
void main(){
  float x = mod(aSlot, uTexSize.x) + 0.5;
  float y = floor(aSlot / uTexSize.x) + 0.5;
  vP = position; vV = aVel; vA = aAux;
  gl_PointSize = 1.0;
  gl_Position = vec4((x / uTexSize.x) * 2.0 - 1.0, (y / uTexSize.y) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPAWN_FRAG = /* glsl */`
precision highp float;
${HASH_GLSL}
in vec3 vP; in vec3 vV; in vec4 vA;   // vA = life, subtype, size, growth
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oAux;
void main(){
  oPos = vec4(vP, 0.0);
  oVel = vec4(vV, vA.x);
  oAux = vec4(vA.y, vA.z, hash12(gl_FragCoord.xy * 0.371 + vA.x * 13.7), vA.w);
}
`;

/* ------------------------------------------------------------- particle draw */

const DRAW_VERT = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

in vec3  position;
in vec2  uv;
in float aIndex;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAux;
uniform vec2  uTexSize;
uniform float uRowOffset;
uniform float uKind;
uniform vec3  uCamPos;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform float uProjScaleY;
uniform float uGust;
uniform float uDensity;

out vec2  vUv;
out vec4  vCol;
out float vViewZ;
out float vShape;

/** Henyey-Greenstein. Backlit spray and dust glow because of this term. */
float hgP(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

void main(){
  int tx = int(mod(aIndex, uTexSize.x));
  int ty = int(floor(aIndex / uTexSize.x) + uRowOffset);
  ivec2 tc = ivec2(tx, ty);

  vec4 P = texelFetch(tPos, tc, 0);
  vec4 V = texelFetch(tVel, tc, 0);
  vec4 A = texelFetch(tAux, tc, 0);

  vUv = uv; vShape = 0.0; vCol = vec4(0.0); vViewZ = -1.0;

  float life = max(V.w, 1e-3);
  float ag   = P.w / life;
  float size = A.y;
  if (ag >= 1.0 || size <= 1e-5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec3  vp   = (viewMatrix * vec4(P.xyz, 1.0)).xyz;
  float dist = max(-vp.z, 0.01);
  float hg   = hgP(dot(normalize(P.xyz - uCamPos), uSunDir), 0.60);

  float lifeFade = smoothstep(0.0, 0.07, ag) * (1.0 - smoothstep(0.55, 1.0, ag));

  vec3  col = vec3(1.0);
  float alp = 1.0;
  float stretch = 0.0;
  int kind = int(uKind + 0.5);
  int sub  = int(A.x + 0.5);

  if (kind == 0) {                              // wind-blown sand
    col = vec3(0.80, 0.69, 0.50) * (uSkyColor * 0.45 + uSunColor * (0.42 + hg * 1.15));
    alp = mix(0.34, 0.11, A.x) * (0.30 + 0.90 * uGust);
    vShape = 1.0; stretch = 1.0;
  } else if (kind == 1) {                       // sea spray
    col = vec3(0.90, 0.95, 1.00) * (uSkyColor * 0.55 + uSunColor * (0.45 + hg * 3.4));
    alp = mix(0.60, 0.24, A.x);
    vShape = A.x > 0.5 ? 0.0 : 1.0; stretch = mix(0.95, 0.25, A.x);
  } else if (kind == 2) {                       // dust motes in the shafts
    col = vec3(1.00, 0.93, 0.80) * uSunColor * (0.45 + hg * 3.2);
    alp = 0.60;
  } else if (kind == 3) {                       // pollen
    col = vec3(1.00, 0.95, 0.72) * uSunColor * (0.40 + hg * 2.4);
    alp = 0.50;
  } else if (sub == 0) {                        // smoke / sand puff
    col = mix(vec3(0.62, 0.56, 0.47), vec3(0.20, 0.19, 0.18), ag)
        * (uSkyColor * 0.70 + uSunColor * (0.50 + hg * 0.9));
    alp = 0.50;
  } else if (sub == 1) {                        // thrown grit
    col = vec3(0.74, 0.63, 0.45) * (uSkyColor * 0.40 + uSunColor * (0.55 + hg * 0.9));
    alp = 0.85; vShape = 1.0; stretch = 0.8;
  } else if (sub == 2) {                        // water droplet
    col = vec3(0.86, 0.94, 1.00) * (uSkyColor * 0.60 + uSunColor * (0.50 + hg * 3.0));
    alp = 0.75; vShape = 1.0; stretch = 0.9;
  } else if (sub == 3) {                        // rock chip
    col = vec3(0.44, 0.41, 0.37) * (uSkyColor * 0.45 + uSunColor * 0.75);
    alp = 0.95; vShape = 1.0; stretch = 0.5;
  } else if (sub == 4) {                        // spark
    col = mix(vec3(4.2, 2.4, 0.70), vec3(1.30, 0.34, 0.05), ag * ag);
    alp = 1.0; vShape = 1.0; stretch = 2.4;
  } else if (sub == 5) {                        // plasma splash
    col = mix(vec3(0.60, 2.20, 3.20), vec3(0.10, 0.55, 1.10), ag);
    alp = 0.9;
  } else if (sub == 6) {                        // fireball
    col = mix(vec3(5.0, 2.10, 0.45), vec3(0.80, 0.22, 0.04), ag * ag);
    alp = 0.85;
  } else if (sub == 7) {                        // shockwave ring
    col = vec3(1.50, 1.35, 1.10);
    alp = 0.55; vShape = 2.0;
  } else {                                      // grunt methane jet
    col = mix(vec3(0.55, 2.00, 1.15), vec3(0.15, 0.60, 0.40), ag);
    alp = 0.8;
  }

  // Sub-pixel particles alias and crawl under TAA. Grow them to ~1.5 px and take the
  // energy back out of alpha, which is stable and preserves total scattered light.
  float px = size * uProjScaleY / dist;
  float k  = max(1.0, 1.5 / max(px, 1e-4));
  size *= k;
  alp  /= (k * k);

  alp *= lifeFade * uDensity;
  alp *= 1.0 - smoothstep(150.0, 340.0, dist);
  if (alp <= 0.0015) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // view-space billboard, stretched along the projected velocity
  vec3  vv  = (viewMatrix * vec4(V.xyz, 0.0)).xyz;
  float sp  = length(vv.xy);
  vec2  dir = sp > 0.05 ? vv.xy / sp : vec2(0.0, 1.0);
  float el  = 1.0 + stretch * min(sp, 14.0) * 0.10;
  vec2  pl  = position.xy;
  if (stretch <= 0.001) {
    float r = A.z * 6.2831853, c = cos(r), s = sin(r);
    pl = vec2(pl.x * c - pl.y * s, pl.x * s + pl.y * c);
  }
  vp.xy += (vec2(dir.y, -dir.x) * pl.x + dir * (pl.y * el)) * size;

  vCol = vec4(col, alp);
  vViewZ = vp.z;
  gl_Position = projectionMatrix * vec4(vp, 1.0);
}
`;

const DRAW_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;

in vec2  vUv;
in vec4  vCol;
in float vViewZ;
in float vShape;

uniform sampler2D uDepth;
uniform vec2  uRes;
uniform float uNear;
uniform float uFar;
uniform float uSoft;

layout(location = 0) out vec4 oCol;

void main(){
  vec2  q  = vUv * 2.0 - 1.0;
  float r2 = dot(q, q);
  float r  = sqrt(r2);
  float a;
  // NB: smoothstep(e0, e1, x) is undefined for e0 >= e1 and returns 0 under
  // ANGLE/Vulkan — always write the increasing form and invert.
  if (vShape < 0.5)      a = exp(-r2 * 2.8) * (1.0 - smoothstep(0.55, 1.05, r));
  else if (vShape < 1.5) a = exp(-r2 * 2.2);
  else { float d = abs(r - 0.80); a = exp(-d * d * 120.0); }
  a *= vCol.a;
  if (a <= 0.002) discard;

  // Soft particles: fade where the billboard would otherwise cut a hard line into
  // whatever geometry it intersects. Reads a *copy* of the depth buffer (see header).
  float d = texture(uDepth, gl_FragCoord.xy / uRes).x;
  float sceneDist = -((uNear * uFar) / ((uFar - uNear) * d - uFar));
  float pDist = -vViewZ;
  a *= clamp((sceneDist - pDist) / uSoft, 0.0, 1.0);
  a *= clamp((pDist - 0.25) / 0.45, 0.0, 1.0);
  if (a <= 0.002) discard;

  oCol = vec4(vCol.rgb * a, a);        // premultiplied
}
`;

/* ---------------------------------------------------------------- decals */

const DECAL_VERT = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

in vec3  position;
in float aIndex;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform sampler2D uDecalTex;

out vec3  vCentre;
out vec4  vQuat;
out vec3  vHalf;
out vec4  vParam;

vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

void main(){
  int i = int(aIndex);
  vec4 D0 = texelFetch(uDecalTex, ivec2(i, 0), 0);   // centre.xyz, halfXZ
  vec4 D1 = texelFetch(uDecalTex, ivec2(i, 1), 0);   // orientation quaternion
  vec4 D2 = texelFetch(uDecalTex, ivec2(i, 2), 0);   // kind, age, life, halfY
  vCentre = D0.xyz; vQuat = D1; vParam = D2;
  vHalf = vec3(D0.w, max(D2.w, 0.02), D0.w);
  if (D2.z <= 0.0 || D2.y >= D2.z || D0.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 wp = vCentre + qrot(vQuat, position * vHalf * 2.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const DECAL_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
` + HASH_GLSL + /* glsl */`

in vec3  vCentre;
in vec4  vQuat;
in vec3  vHalf;
in vec4  vParam;

uniform sampler2D uDepth;
uniform sampler2D uGbuf1;
uniform sampler2D uGbuf0;
uniform mat4  uInvViewProj;
uniform mat4  uInvView;
uniform vec2  uRes;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;

layout(location = 0) out vec4 oCol;

vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 qrotInv(vec4 q, vec3 v){ return v + 2.0 * cross(-q.xyz, cross(-q.xyz, v) + q.w * v); }

void main(){
  vec2 suv = gl_FragCoord.xy / uRes;
  float d = texture(uDepth, suv).x;
  if (d >= 0.999995) discard;                          // sky

  vec4 wp = uInvViewProj * vec4(suv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  wp /= wp.w;

  vec3 lp = qrotInv(vQuat, wp.xyz - vCentre) / vHalf;
  if (any(greaterThan(abs(lp), vec3(1.0)))) discard;

  // Reject surfaces facing away from the projector, so a crater does not smear
  // down a cliff face. Skipped where the G-buffer has nothing (water, transparent).
  vec4 g1 = texture(uGbuf1, suv);
  if (g1.a > 0.5) {
    vec3 nView  = normalize(texture(uGbuf0, suv).xyz * 2.0 - 1.0);
    vec3 nWorld = normalize((uInvView * vec4(nView, 0.0)).xyz);
    vec3 dUp    = normalize(qrot(vQuat, vec3(0.0, 1.0, 0.0)));
    if (dot(nWorld, dUp) < 0.12) discard;
  }

  int kind = int(vParam.x + 0.5);
  float ag = clamp(vParam.y / max(vParam.z, 1e-3), 0.0, 1.0);
  vec2 duv = lp.xz;
  float rr = length(duv);
  float edge = 1.0 - smoothstep(0.62, 1.0, rr);
  float sideFade = 1.0 - smoothstep(0.55, 1.0, abs(lp.y));

  vec3 col; float a;
  if (kind == 0) {
    // sand crater: dark bowl, bright rim of displaced dry sand
    float bowl = 1.0 - smoothstep(0.0, 0.55, rr);
    float rim  = exp(-pow((rr - 0.66) * 5.2, 2.0));
    float grain = hash12(duv * 43.0 + vCentre.xz) * 0.35 + 0.82;
    col = mix(vec3(0.30, 0.25, 0.18), vec3(0.92, 0.83, 0.64), rim) * grain;
    col *= (uSkyColor * 0.45 + uSunColor * 0.55);
    a = (bowl * 0.75 + rim * 0.85) * edge;
  } else if (kind == 1) {
    // scorch on Forerunner alloy: sooty core, brief incandescent rim
    float core = 1.0 - smoothstep(0.15, 0.85, rr);
    float ring = exp(-pow((rr - 0.55) * 6.0, 2.0)) * (1.0 - smoothstep(0.0, 0.25, ag));
    float soot = hash12(duv * 27.0 + vCentre.xy) * 0.4 + 0.7;
    col = mix(vec3(0.035, 0.030, 0.028) * soot, vec3(3.0, 0.9, 0.18), ring);
    a = clamp(core * 0.9 + ring, 0.0, 1.0) * edge;
  } else if (kind == 2) {
    // expanding ripple: a thin bright ring that opens and fades
    float rad = mix(0.12, 0.95, sqrt(ag));
    float w = 0.09 + 0.10 * ag;
    float ring = exp(-pow((rr - rad) / w, 2.0));
    col = vec3(1.05, 1.10, 1.15) * (uSkyColor * 0.7 + uSunColor * 0.5);
    a = ring * 0.55 * edge;
  } else {
    // plasma scald
    float core = 1.0 - smoothstep(0.10, 0.90, rr);
    float sp = hash12(duv * 11.0 + vCentre.zx);
    col = mix(vec3(0.10, 0.45, 0.85), vec3(0.55, 1.60, 2.20), core * sp);
    a = core * 0.7 * edge;
  }

  a *= sideFade * (1.0 - smoothstep(0.55, 1.0, ag));
  if (a <= 0.003) discard;
  oCol = vec4(col * a, a);
}
`;

/* ----------------------------------------------------------------- birds */

const BIRD_VERT = /* glsl */`
precision highp float;
${HASH_GLSL}

in vec3  position;
in vec2  uv;
in float aIndex;

uniform mat4  projectionMatrix;
uniform mat4  viewMatrix;
uniform vec4  uStacks[8];
uniform float uStackCount;
uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform float uSize;

out vec2  vUv;
out float vFlap;
out vec4  vCol;

void main(){
  float i = aIndex;
  float s1 = hash11(i * 1.37 + 0.13);
  float s2 = hash11(i * 2.71 + 4.10);
  float s3 = hash11(i * 3.11 + 8.70);
  float s4 = hash11(i * 5.19 + 1.90);

  int si = int(mod(i, max(uStackCount, 1.0)));
  vec4 S = uStacks[si];

  float rad = S.z * (1.15 + 1.05 * s1);
  float hgt = max(S.w, 8.0) * (0.55 + 0.55 * s2);
  float spd = (0.13 + 0.13 * s3) * (s4 > 0.5 ? 1.0 : -1.0);
  float ph  = s4 * 6.2831853;
  float a   = uTime * spd + ph;

  vec3 wp = vec3(S.x + cos(a) * rad, hgt + sin(a * 1.73 + ph) * 2.6, S.y + sin(a) * rad);

  vFlap = sin(uTime * (4.2 + 2.6 * s1) + ph * 3.0);

  vec3  vp   = (viewMatrix * vec4(wp, 1.0)).xyz;
  float dist = max(-vp.z, 0.01);

  // Silhouettes at range: the haze that swallows the stacks swallows these too.
  // Gulls read as dark marks against a bright sky; the haze only lifts them a
  // little, or they invert into pale specks and stop looking like birds.
  float t = 1.0 - exp(-dist * 0.0038);
  vec3 col = mix(vec3(0.085, 0.080, 0.075) * (uSunColor * 0.55 + uSkyColor * 0.8), uSkyColor * 1.25, t);
  vCol = vec4(col, 1.0 - 0.30 * t);

  vp.xy += position.xy * uSize;
  vUv = uv;
  gl_Position = projectionMatrix * vec4(vp, 1.0);
}
`;

const BIRD_FRAG = /* glsl */`
precision highp float;
in vec2  vUv;
in float vFlap;
in vec4  vCol;
layout(location = 0) out vec4 oCol;
void main(){
  vec2 q = vUv * 2.0 - 1.0;
  float ax = abs(q.x);
  // A gull is ~14 px across at these ranges, so the wing has to be a real fraction of
  // the sprite: a thin analytic line disappears below one pixel and the bird vanishes.
  float wy = vFlap * 0.52 * ax;                            // dihedral rises with span
  float th = 0.34 * (1.0 - ax * 0.72);                     // half-thickness, tapering
  float wing = (1.0 - smoothstep(th * 0.35, th, abs(q.y - wy))) * (1.0 - smoothstep(0.84, 1.0, ax));
  float body = 1.0 - smoothstep(0.13, 0.36, length(q * vec2(1.0, 2.2)));
  float a = max(wing, body) * vCol.a;
  if (a <= 0.01) discard;
  oCol = vec4(vCol.rgb * a, a);
}
`;

/* --------------------------------------------------------- heat shimmer */

const SHIMMER_VERT = /* glsl */`
precision highp float;
in vec3  position;
in vec2  uv;
in float aIndex;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec4 uShim[4];        // xyz = world position, w = strength
uniform vec2 uShimSize[4];    // x = width, y = height
out vec2  vUv;
out float vStr;
void main(){
  int i = int(aIndex);
  vec4 S = uShim[i];
  vUv = uv; vStr = S.w;
  if (S.w <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 vp = (viewMatrix * vec4(S.xyz, 1.0)).xyz;
  vp.xy += position.xy * uShimSize[i];
  gl_Position = projectionMatrix * vec4(vp, 1.0);
}
`;

const SHIMMER_FRAG = /* glsl */`
precision highp float;
` + HASH_GLSL + /* glsl */`
in vec2  vUv;
in float vStr;
uniform sampler2D uOpaque;
uniform vec2  uRes;
uniform float uTime;
layout(location = 0) out vec4 oCol;
void main(){
  vec2 q = vUv * 2.0 - 1.0;
  float m = exp(-dot(q, q) * 2.2) * vStr;
  if (m <= 0.004) discard;
  vec2 suv = gl_FragCoord.xy / uRes;
  float n1 = hash12(floor(vUv * 24.0) + floor(uTime * 22.0) * 0.37);
  float n2 = hash12(floor(vUv * 19.0 + 7.0) - floor(uTime * 18.0) * 0.51);
  vec2 warp = (vec2(n1, n2) - 0.5) * (2.6 / uRes.y) * m * 26.0;
  vec3 c = texture(uOpaque, clamp(suv + warp, vec2(0.0), vec2(1.0))).rgb;
  oCol = vec4(c * m, m);
}
`;

const DEPTH_COPY_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tDepth;
out vec4 oCol;
void main(){ oCol = vec4(texture(tDepth, vUv).x, 0.0, 0.0, 1.0); }
`;

/* ---------------------------------------------------------------- helpers */

function makeStateRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count: 3,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
  return rt;
}

const _quadBase = new THREE.PlaneGeometry(1, 1);

/** A unit quad drawn `count` times, each instance carrying its own particle index. */
function instancedQuad(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = _quadBase.index;
  g.setAttribute('position', _quadBase.attributes.position);
  g.setAttribute('uv', _quadBase.attributes.uv);
  const ids = new Float32Array(count);
  for (let i = 0; i < count; i++) ids[i] = i;
  g.setAttribute('aIndex', new THREE.InstancedBufferAttribute(ids, 1));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

/**
 * One ping-ponged particle state pair plus its simulation and spawn passes.
 * `sim()` advances every texel; `spawn()` overwrites individual texels from the
 * CPU-side burst list without any readback.
 */
class GpuSystem {
  constructor(w, h, simSource, uniforms, withSpawn) {
    this.w = w; this.h = h;
    this.rt = [makeStateRT(w, h), makeStateRT(w, h)];
    this.cur = 0;

    this.uPos = { value: null };
    this.uVel = { value: null };
    this.uAux = { value: null };
    const u = Object.assign({ tPos: this.uPos, tVel: this.uVel, tAux: this.uAux }, uniforms);

    this.simMat = fsMaterial(simSource, u);
    this.initMat = fsMaterial(simSource, u, { INIT: '' });
    // These write raw state into float targets — any blending corrupts the sim.
    this.simMat.blending = THREE.NoBlending;
    this.initMat.blending = THREE.NoBlending;
    this.quad = new FullScreenQuad(this.simMat);

    if (withSpawn) {
      this.spawnScene = new THREE.Scene();
      this.spawnCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const g = new THREE.BufferGeometry();
      this.aSlot = new THREE.BufferAttribute(new Float32Array(FX_MAX_SPAWN), 1);
      this.aPos = new THREE.BufferAttribute(new Float32Array(FX_MAX_SPAWN * 3), 3);
      this.aVel = new THREE.BufferAttribute(new Float32Array(FX_MAX_SPAWN * 3), 3);
      this.aAux = new THREE.BufferAttribute(new Float32Array(FX_MAX_SPAWN * 4), 4);
      for (const a of [this.aSlot, this.aPos, this.aVel, this.aAux]) a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aSlot', this.aSlot);
      g.setAttribute('position', this.aPos);
      g.setAttribute('aVel', this.aVel);
      g.setAttribute('aAux', this.aAux);
      g.setDrawRange(0, 0);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      this.spawnGeom = g;
      this.spawnMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: SPAWN_VERT,
        fragmentShader: SPAWN_FRAG,
        uniforms: { uTexSize: { value: new THREE.Vector2(w, h) } },
        depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      });
      const pts = new THREE.Points(g, this.spawnMat);
      pts.frustumCulled = false;
      this.spawnScene.add(pts);
      this.pending = 0;
    }
  }

  bindRead() {
    const src = this.rt[this.cur];
    this.uPos.value = src.textures[0];
    this.uVel.value = src.textures[1];
    this.uAux.value = src.textures[2];
  }

  /** Fill both buffers with the shader's INIT branch. Deterministic. */
  reset(renderer) {
    this.quad.material = this.initMat;
    for (let i = 0; i < 2; i++) {
      // INIT ignores the inputs, but binding the target we are about to draw into
      // is still a feedback loop — point the samplers at the other buffer.
      const src = this.rt[1 - i];
      this.uPos.value = src.textures[0];
      this.uVel.value = src.textures[1];
      this.uAux.value = src.textures[2];
      renderer.setRenderTarget(this.rt[i]);
      this.quad.render(renderer);
    }
    this.cur = 0;
    this.quad.material = this.simMat;
    this.bindRead();
  }

  step(renderer) {
    const dst = 1 - this.cur;
    this.bindRead();
    this.quad.material = this.simMat;
    renderer.setRenderTarget(this.rt[dst]);
    this.quad.render(renderer);

    if (this.pending > 0) {
      this.spawnGeom.setDrawRange(0, this.pending);
      for (const a of [this.aSlot, this.aPos, this.aVel, this.aAux]) a.needsUpdate = true;
      renderer.setRenderTarget(this.rt[dst]);
      renderer.render(this.spawnScene, this.spawnCam);
      this.pending = 0;
    }
    this.cur = dst;
    this.bindRead();
  }

  /** Queue one particle. aux = [life, subtype, size, growth]. */
  push(slot, px, py, pz, vx, vy, vz, life, subtype, size, growth) {
    if (this.pending >= FX_MAX_SPAWN) return;
    const i = this.pending++;
    this.aSlot.array[i] = slot;
    this.aPos.array[i * 3] = px; this.aPos.array[i * 3 + 1] = py; this.aPos.array[i * 3 + 2] = pz;
    this.aVel.array[i * 3] = vx; this.aVel.array[i * 3 + 1] = vy; this.aVel.array[i * 3 + 2] = vz;
    const o = i * 4;
    this.aAux.array[o] = life; this.aAux.array[o + 1] = subtype;
    this.aAux.array[o + 2] = size; this.aAux.array[o + 3] = growth;
  }

  dispose() {
    for (const rt of this.rt) rt.dispose();
    this.simMat.dispose(); this.initMat.dispose();
    this.spawnMat?.dispose(); this.spawnGeom?.dispose();
  }
}

/* ------------------------------------------------------------------ module */

export function create(opts = {}) {
  const group = new THREE.Group();
  group.name = 'particles';
  group.frustumCulled = false;

  let ctx = null, pipe = null, renderer = null;
  let amb = null, fx = null;
  let ready = false;
  let needsReseed = true;

  const rnd = { r: null, next: () => (rnd.r ? rnd.r.next() : 0.5) };

  /* -------- shared uniform block (identity-shared across every material) --- */
  const U = {
    uCamPos:     { value: new THREE.Vector3() },
    uSunDir:     { value: new THREE.Vector3(0, 1, 0) },
    uSunColor:   { value: new THREE.Color(1, 0.96, 0.9) },
    uSkyColor:   { value: new THREE.Color(0.42, 0.58, 0.9) },
    uWind:       { value: new THREE.Vector3() },
    uGust:       { value: 0.62 },
    uTime:       { value: 0 },
    uDt:         { value: 1 / 60 },
    uDepth:      { value: null },
    uRes:        { value: new THREE.Vector2(1920, 1080) },
    uNear:       { value: 0.06 },
    uFar:        { value: 12000 },
    uProjScaleY: { value: 540 },
    uDensity:    { value: 1 },
    uGroundTex:  { value: null },
    uGroundMin:  { value: new THREE.Vector2(G_MIN_X, G_MIN_Z) },
    uGroundSize: { value: new THREE.Vector2(G_MAX_X - G_MIN_X, G_MAX_Z - G_MIN_Z) },
    uShoreTex:   { value: null },
    uStacks:     { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uStackCount: { value: 0 },
    uBridge:     { value: new THREE.Vector4(BRIDGE_FALLBACK.ax, BRIDGE_FALLBACK.az, BRIDGE_FALLBACK.bx, BRIDGE_FALLBACK.bz) },
    uDeckY:      { value: BRIDGE_FALLBACK.deckY },
    uRows:       { value: new THREE.Vector4(ROW_SAND, ROW_SPRAY, ROW_DUST, ROW_POLLEN) },
    uInvViewProj:{ value: new THREE.Matrix4() },
    uInvView:    { value: new THREE.Matrix4() },
    uOpaque:     { value: null },
    uGbuf0:      { value: null },
    uGbuf1:      { value: null },
  };

  /* ---------------------------------------------------- baked ground field */
  const groundData = new Float32Array(G_N * G_N * 4);
  const groundTex = new THREE.DataTexture(groundData, G_N, G_N, THREE.RGBAFormat, THREE.FloatType);
  groundTex.wrapS = groundTex.wrapT = THREE.ClampToEdgeWrapping;
  groundTex.generateMipmaps = false;
  U.uGroundTex.value = groundTex;

  /** Waterline Z per X sample, used to place shoreline spray probes. */
  const SHORE_N = 128;
  const shoreZ = new Float32Array(SHORE_N);

  function bakeGround() {
    const terrain = ctx.get('terrain');
    let sample = null, height = null;
    try {
      if (terrain && typeof terrain.sample === 'function') { terrain.sample(0, 0); sample = terrain.sample.bind(terrain); }
      else if (terrain && typeof terrain.height === 'function') { terrain.height(0, 0); height = terrain.height.bind(terrain); }
    } catch { sample = null; height = null; }

    for (let j = 0; j < G_N; j++) {
      const z = G_MIN_Z + ((j + 0.5) / G_N) * (G_MAX_Z - G_MIN_Z);
      for (let i = 0; i < G_N; i++) {
        const x = G_MIN_X + ((i + 0.5) / G_N) * (G_MAX_X - G_MIN_X);
        let y, wet, slope = 0, mat = 1;
        if (sample) {
          const s = sample(x, z);
          y = s?.y ?? 0; wet = s?.wetness ?? 0; slope = s?.slope ?? 0; mat = s?.material ?? 1;
        } else if (height) {
          y = height(x, z); wet = 1 - Math.min(1, Math.max(0, (y - 0.1) / 1.4));
        } else {
          y = fallbackHeight(x, z); wet = 1 - Math.min(1, Math.max(0, (y - 0.1) / 1.4));
        }
        const o = (j * G_N + i) * 4;
        groundData[o] = y; groundData[o + 1] = wet; groundData[o + 2] = slope; groundData[o + 3] = mat / 255;
      }
    }
    groundTex.needsUpdate = true;

    // waterline: first crossing of y = 0 scanning landward
    for (let i = 0; i < SHORE_N; i++) {
      const x = G_MIN_X + ((i + 0.5) / SHORE_N) * (G_MAX_X - G_MIN_X);
      let found = -6.5;
      let prevY = groundAtCPU(x, -90);
      for (let z = -88; z <= 60; z += 1.5) {
        const y = groundAtCPU(x, z);
        if (prevY < 0 && y >= 0) { found = z - 1.5 * (y / Math.max(y - prevY, 1e-4)); break; }
        prevY = y;
      }
      shoreZ[i] = found;
    }
  }

  function groundAtCPU(x, z) {
    const u = (x - G_MIN_X) / (G_MAX_X - G_MIN_X);
    const v = (z - G_MIN_Z) / (G_MAX_Z - G_MIN_Z);
    if (u < 0 || u > 1 || v < 0 || v > 1) return -30;
    const i = Math.min(G_N - 1, Math.max(0, Math.round(u * G_N - 0.5)));
    const j = Math.min(G_N - 1, Math.max(0, Math.round(v * G_N - 0.5)));
    return groundData[(j * G_N + i) * 4];
  }

  function shoreZAt(x) {
    const t = ((x - G_MIN_X) / (G_MAX_X - G_MIN_X)) * SHORE_N - 0.5;
    const i = Math.min(SHORE_N - 2, Math.max(0, Math.floor(t)));
    const f = Math.min(1, Math.max(0, t - i));
    return shoreZ[i] * (1 - f) + shoreZ[i + 1] * f;
  }

  /* ------------------------------------------- shoreline foam probe texture */
  const shoreData = new Float32Array(SHORE_PROBES * 4);
  const shoreTex = new THREE.DataTexture(shoreData, SHORE_PROBES, 1, THREE.RGBAFormat, THREE.FloatType);
  shoreTex.minFilter = shoreTex.magFilter = THREE.NearestFilter;
  shoreTex.generateMipmaps = false;
  U.uShoreTex.value = shoreTex;

  function updateShoreProbes(t) {
    const ocean = ctx.get('ocean');
    const cx = ctx.camera.position.x;
    for (let i = 0; i < SHORE_PROBES; i++) {
      const x = cx + ((i + 0.5) / SHORE_PROBES - 0.5) * 190;
      const z = shoreZAt(x);
      let foam = 0;
      if (ocean && typeof ocean.foamAt === 'function') {
        try { foam = ocean.foamAt(x, z, t) || 0; } catch { foam = 0; }
      } else {
        // Stand-in swash while `ocean` is a stub: sets of breakers running along the
        // beach so spray still reads correctly. Replaced the moment foamAt() exists.
        const a = Math.sin(x * 0.085 + t * 1.55) * Math.sin(x * 0.031 - t * 0.72 + 1.3);
        foam = Math.max(0, a) * (0.55 + 0.45 * Math.sin(t * 0.41 + x * 0.006));
      }
      const o = i * 4;
      shoreData[o] = x; shoreData[o + 1] = z; shoreData[o + 2] = foam; shoreData[o + 3] = 0;
    }
    shoreTex.needsUpdate = true;
  }

  /* --------------------------------------------------- landmark uniforms */
  function refreshLandmarks() {
    const rocks = ctx.get('rocks');
    const list = [];
    const lm = rocks?.landmarks;
    if (lm && typeof lm.forEach === 'function') {
      lm.forEach((v, k) => {
        if (list.length >= 8 || !v) return;
        if (typeof k === 'string' && !/stack|islet/.test(k)) return;
        const c = v.center;
        if (!c) return;
        list.push({ x: c.x, z: c.z, r: v.radius ?? 14, top: v.topY ?? 30 });
      });
    }
    const src = list.length ? list : STACK_FALLBACK;
    U.uStackCount.value = Math.min(8, src.length);
    for (let i = 0; i < 8; i++) {
      const s = src[Math.min(i, src.length - 1)];
      U.uStacks.value[i].set(s.x, s.z, s.r, s.top);
    }

    const st = ctx.get('structures');
    if (typeof st?.deckY === 'number') U.uDeckY.value = st.deckY;
    if (st?.bridge) {
      try {
        const box = new THREE.Box3().setFromObject(st.bridge);
        if (isFinite(box.min.x) && box.max.x > box.min.x) {
          U.uBridge.value.set(box.max.x, box.max.z, box.min.x, box.min.z);
        }
      } catch { /* keep the WORLD.md run */ }
    }
  }

  /* ------------------------------------------------------ depth copy probe */
  let depthCopyRT = null;
  const depthCopyMat = fsMaterial(DEPTH_COPY_FRAG, { tDepth: { value: null } });
  depthCopyMat.blending = THREE.NoBlending;
  const depthQuad = new FullScreenQuad(depthCopyMat);
  const _m4 = new THREE.Matrix4();

  const probeMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'precision highp float;\nin vec3 position;\nvoid main(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }',
    fragmentShader: 'precision highp float;\nout vec4 oCol;\nvoid main(){ oCol = vec4(0.0); }',
    depthTest: false, depthWrite: false, colorWrite: false,
  });
  const probe = new THREE.Mesh(_quadBase, probeMat);
  probe.frustumCulled = false;
  probe.renderOrder = -1000000;
  probe.layers.set(LAYER.EFFECTS);
  probe.onBeforeRender = (r, _scene, camera) => {
    if (!pipe?.depthTex || !depthCopyRT) return;
    const prev = r.getRenderTarget();
    depthCopyMat.uniforms.tDepth.value = pipe.depthTex;
    depthQuad.material = depthCopyMat;
    r.setRenderTarget(depthCopyRT);
    depthQuad.render(r);
    r.setRenderTarget(prev);
    // Depth was rasterised with the JITTERED projection, so the inverse must be too.
    _m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    U.uInvViewProj.value.copy(_m4).invert();
    U.uInvView.value.copy(camera.matrixWorld);
  };
  group.add(probe);

  /* ------------------------------------------------------------- particle draws */
  function drawMaterial(sys, rowOffset, kind, additive, soft) {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: DRAW_VERT,
      fragmentShader: DRAW_FRAG,
      uniforms: {
        tPos: sys.uPos, tVel: sys.uVel, tAux: sys.uAux,
        uTexSize: { value: new THREE.Vector2(sys.w, sys.h) },
        uRowOffset: { value: rowOffset },
        uKind: { value: kind },
        uSoft: { value: soft },
        uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunColor: U.uSunColor, uSkyColor: U.uSkyColor,
        uProjScaleY: U.uProjScaleY, uGust: U.uGust, uDensity: U.uDensity,
        uDepth: U.uDepth, uRes: U.uRes, uNear: U.uNear, uFar: U.uFar,
      },
      transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    });
  }

  const draws = [];
  function addDraw(sys, rowOffset, rows, texW, kind, additive, soft, order) {
    const count = rows * texW;
    const mesh = new THREE.Mesh(instancedQuad(count), drawMaterial(sys, rowOffset, kind, additive, soft));
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.layers.set(LAYER.EFFECTS);
    group.add(mesh);
    draws.push(mesh);
    return mesh;
  }

  /* -------------------------------------------------------------- decals */
  const decalData = new Float32Array(DECAL_MAX * 3 * 4);
  const decalTex = new THREE.DataTexture(decalData, DECAL_MAX, 3, THREE.RGBAFormat, THREE.FloatType);
  decalTex.minFilter = decalTex.magFilter = THREE.NearestFilter;
  decalTex.generateMipmaps = false;
  let decalCursor = 0;
  let decalsLive = 0;

  const _boxBase = new THREE.BoxGeometry(1, 1, 1);
  const decalGeom = new THREE.InstancedBufferGeometry();
  decalGeom.index = _boxBase.index;
  decalGeom.setAttribute('position', _boxBase.attributes.position);
  {
    const ids = new Float32Array(DECAL_MAX);
    for (let i = 0; i < DECAL_MAX; i++) ids[i] = i;
    decalGeom.setAttribute('aIndex', new THREE.InstancedBufferAttribute(ids, 1));
  }
  decalGeom.instanceCount = DECAL_MAX;
  decalGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const decalMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    uniforms: {
      uDecalTex: { value: decalTex },
      uDepth: U.uDepth, uGbuf0: U.uGbuf0, uGbuf1: U.uGbuf1,
      uInvViewProj: U.uInvViewProj, uInvView: U.uInvView,
      uRes: U.uRes, uSunColor: U.uSunColor, uSkyColor: U.uSkyColor,
    },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const decalMesh = new THREE.Mesh(decalGeom, decalMat);
  decalMesh.frustumCulled = false;
  decalMesh.renderOrder = -50;
  decalMesh.layers.set(LAYER.EFFECTS);
  group.add(decalMesh);

  const UP = new THREE.Vector3(0, 1, 0);
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _n = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();

  /** Project a decal onto whatever the depth buffer shows inside its box. */
  function addDecal(point, normal, kind, radius, life, depth = 0.6) {
    const i = decalCursor; decalCursor = (decalCursor + 1) % DECAL_MAX;
    _n.copy(normal); if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0); else _n.normalize();
    _q.setFromUnitVectors(UP, _n);
    _q2.setFromAxisAngle(_n, rnd.next() * Math.PI * 2);
    _q.premultiply(_q2);
    const a = i * 4, b = (DECAL_MAX + i) * 4, c = (DECAL_MAX * 2 + i) * 4;
    decalData[a] = point.x; decalData[a + 1] = point.y; decalData[a + 2] = point.z; decalData[a + 3] = radius;
    decalData[b] = _q.x; decalData[b + 1] = _q.y; decalData[b + 2] = _q.z; decalData[b + 3] = _q.w;
    decalData[c] = kind; decalData[c + 1] = 0; decalData[c + 2] = life; decalData[c + 3] = depth;
    decalTex.needsUpdate = true;
    decalsLive = Math.min(DECAL_MAX, decalsLive + 1);
  }

  function ageDecals(dt) {
    if (dt <= 0) return;
    let live = 0;
    for (let i = 0; i < DECAL_MAX; i++) {
      const c = (DECAL_MAX * 2 + i) * 4;
      if (decalData[c + 2] <= 0) continue;
      decalData[c + 1] += dt;
      if (decalData[c + 1] >= decalData[c + 2]) { decalData[c + 2] = 0; decalData[i * 4 + 3] = 0; }
      else live++;
    }
    decalsLive = live;
    decalTex.needsUpdate = true;
  }

  /* --------------------------------------------------------------- birds */
  const birdMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BIRD_VERT,
    fragmentShader: BIRD_FRAG,
    uniforms: {
      uStacks: U.uStacks, uStackCount: U.uStackCount, uTime: U.uTime,
      uCamPos: U.uCamPos, uSunColor: U.uSunColor, uSkyColor: U.uSkyColor,
      uSize: { value: 2.10 },
    },
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const birds = new THREE.Mesh(instancedQuad(BIRD_COUNT), birdMat);
  birds.frustumCulled = false;
  birds.renderOrder = -30;
  birds.layers.set(LAYER.EFFECTS);
  group.add(birds);

  /* ------------------------------------------------------- heat shimmer */
  const shimSlots = Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, 0));
  const shimSizes = Array.from({ length: 4 }, () => new THREE.Vector2(0.3, 0.3));
  const shimmerMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SHIMMER_VERT,
    fragmentShader: SHIMMER_FRAG,
    uniforms: {
      uShim: { value: shimSlots }, uShimSize: { value: shimSizes },
      uOpaque: U.uOpaque, uRes: U.uRes, uTime: U.uTime,
    },
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const shimmer = new THREE.Mesh(instancedQuad(4), shimmerMat);
  shimmer.frustumCulled = false;
  shimmer.renderOrder = 6;
  shimmer.layers.set(LAYER.EFFECTS);
  group.add(shimmer);

  /* ------------------------------------------------------------- debris */
  const debrisMat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: U.uSunDir, uSunColor: U.uSunColor, uSkyColor: U.uSkyColor },
    vertexShader: `
      varying vec3 vN;
      void main(){
        vec4 mp = instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * mp;
      }`,
    fragmentShader: `
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyColor;
      varying vec3 vN;
      void main(){
        vec3 n = normalize(vN);
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 c = vec3(0.36, 0.31, 0.25) * (uSunColor * ndl * 1.4 + uSkyColor * (0.30 + 0.35 * n.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const debrisMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), debrisMat, DEBRIS_MAX);
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.count = 0;
  debrisMesh.frustumCulled = false;
  debrisMesh.renderOrder = -60;
  debrisMesh.layers.set(LAYER.EFFECTS);
  group.add(debrisMesh);

  const debris = [];
  const _dm = new THREE.Matrix4(), _ds = new THREE.Vector3(), _dq = new THREE.Quaternion();

  /* --------------------------------------------------------- fx emitters */
  const A_COUNT = FX_SPLIT * FX_W;
  const B_BASE = FX_SPLIT * FX_W, B_COUNT = (FX_H - FX_SPLIT) * FX_W;
  let slotA = 0, slotB = 0;
  const allocA = () => { const s = slotA; slotA = (slotA + 1) % A_COUNT; return s; };
  const allocB = () => { const s = slotB; slotB = (slotB + 1) % B_COUNT; return B_BASE + s; };

  const emitA = (p, v, sub, size, growth, life) =>
    fx && fx.push(allocA(), p.x, p.y, p.z, v.x, v.y, v.z, life, sub, size, growth);
  const emitB = (p, v, sub, size, growth, life) =>
    fx && fx.push(allocB(), p.x, p.y, p.z, v.x, v.y, v.z, life, sub, size, growth);

  const R = () => rnd.next();
  const RS = () => rnd.next() * 2 - 1;

  /** Random direction inside a cone about `n`; `spread` 0 = pencil, 1 = hemisphere. */
  function cone(n, spread, out) {
    out.set(RS(), RS(), RS());
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize().multiplyScalar(spread).add(n).normalize();
  }

  function impactSand(point, n, wet) {
    for (let i = 0; i < 12; i++) {
      cone(n, 0.85, _d).multiplyScalar(1.0 + R() * 2.4);
      _d.y += 0.7;
      emitA(point, _d, 0, 0.16 + R() * 0.24, 0.55 + R() * 0.5, 0.55 + R() * 0.55);
    }
    for (let i = 0; i < 20; i++) {
      cone(n, 0.5, _d).multiplyScalar(3.5 + R() * 7.5);
      emitA(point, _d, wet ? 2 : 1, 0.018 + R() * 0.030, 0, 0.45 + R() * 0.55);
    }
    addDecal(point, n, 0, 0.30 + R() * 0.16, 9.0, 0.5);
  }

  function impactWater(point, n) {
    for (let i = 0; i < 26; i++) {
      cone(UP, 0.45, _d).multiplyScalar(3.0 + R() * 7.0);
      emitA(point, _d, 2, 0.020 + R() * 0.045, 0, 0.5 + R() * 0.6);
    }
    for (let i = 0; i < 8; i++) {
      cone(UP, 0.30, _d).multiplyScalar(0.8 + R() * 2.0);
      emitB(point, _d, 5, 0.10 + R() * 0.18, 0.5, 0.35 + R() * 0.3);
    }
    addDecal(point, UP, 2, 0.55 + R() * 0.35, 1.6, 0.35);
  }

  function impactRock(point, n) {
    for (let i = 0; i < 14; i++) {
      cone(n, 0.55, _d).multiplyScalar(4.0 + R() * 9.0);
      emitA(point, _d, 3, 0.014 + R() * 0.030, 0, 0.7 + R() * 0.9);
    }
    for (let i = 0; i < 8; i++) {
      cone(n, 0.9, _d).multiplyScalar(0.8 + R() * 2.0);
      emitA(point, _d, 0, 0.12 + R() * 0.20, 0.7, 0.5 + R() * 0.6);
    }
    for (let i = 0; i < 5; i++) {
      cone(n, 0.4, _d).multiplyScalar(5.0 + R() * 10.0);
      emitB(point, _d, 4, 0.010 + R() * 0.014, 0, 0.16 + R() * 0.16);
    }
    addDecal(point, n, 1, 0.16 + R() * 0.10, 12.0, 0.35);
  }

  function impactAlloy(point, n) {
    for (let i = 0; i < 22; i++) {
      cone(n, 0.55, _d).multiplyScalar(7.0 + R() * 16.0);
      emitB(point, _d, 4, 0.009 + R() * 0.013, 0, 0.18 + R() * 0.28);
    }
    for (let i = 0; i < 5; i++) {
      cone(n, 0.8, _d).multiplyScalar(0.6 + R() * 1.4);
      emitA(point, _d, 0, 0.10 + R() * 0.14, 0.5, 0.35 + R() * 0.35);
    }
    addDecal(point, n, 1, 0.13 + R() * 0.08, 14.0, 0.30);
  }

  function impactFlesh(point, n) {
    for (let i = 0; i < 16; i++) {
      cone(n, 0.7, _d).multiplyScalar(1.6 + R() * 4.0);
      emitB(point, _d, 5, 0.05 + R() * 0.11, 0.25, 0.3 + R() * 0.45);
    }
    addDecal(point, n, 3, 0.22 + R() * 0.14, 10.0, 0.4);
  }

  function matName(id) {
    switch (id | 0) {
      case 6: return 'water';
      case 4: return 'forerunner';
      case 9: return 'metal';
      case 3: return 'rock';
      case 2: return 'wetsand';
      case 7: return 'flesh';
      default: return 'sand';
    }
  }

  function impact(point, normal, surface) {
    if (!point || !ready) return;
    _n.copy(normal || UP);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0); else _n.normalize();
    const s = String(surface || 'sand').toLowerCase();
    if (s.includes('water') || s.includes('ocean')) impactWater(point, _n);
    else if (s.includes('forerunner') || s.includes('alloy') || s.includes('metal')) impactAlloy(point, _n);
    else if (s.includes('rock') || s.includes('cliff') || s.includes('stone')) impactRock(point, _n);
    else if (s.includes('flesh') || s.includes('skin') || s.includes('actor')) impactFlesh(point, _n);
    else impactSand(point, _n, s.includes('wet'));
  }

  function muzzle(e) {
    if (!ready) return;
    const o = e?.origin || ctx.get('weapons')?.muzzleWorldPosition;
    if (!o) return;
    const dir = _n.copy(e?.direction || _n.set(0, 0, -1)).normalize();
    for (let i = 0; i < 7; i++) {
      cone(dir, 0.35, _d).multiplyScalar(1.2 + R() * 3.4);
      emitA(o, _d, 0, 0.035 + R() * 0.070, 0.55, 0.28 + R() * 0.35);
    }
    for (let i = 0; i < 4; i++) {
      cone(dir, 0.5, _d).multiplyScalar(2.5 + R() * 6.0);
      emitB(o, _d, 4, 0.008 + R() * 0.010, 0, 0.10 + R() * 0.10);
    }
    // barrel heat: a shimmer lobe just ahead of the muzzle that decays between shots
    shimSlots[0].set(o.x + dir.x * 0.16, o.y + dir.y * 0.16, o.z + dir.z * 0.16, 1.0);
    shimSizes[0].set(0.16, 0.20);
  }

  function footstep(e) {
    if (!ready) return;
    const p = e?.position;
    if (!p) return;
    const wet = /wet|water/.test(String(e?.material || ''));
    const n = e?.running ? 1.6 : 1.0;
    for (let i = 0; i < Math.round(7 * n); i++) {
      cone(UP, 0.85, _d).multiplyScalar(0.5 + R() * 1.6 * n);
      emitA(p, _d, wet ? 2 : 1, 0.014 + R() * 0.026, 0, 0.35 + R() * 0.45);
    }
    for (let i = 0; i < 3; i++) {
      cone(UP, 1.0, _d).multiplyScalar(0.3 + R() * 0.9);
      emitA(p, _d, 0, 0.10 + R() * 0.16, 0.45, 0.4 + R() * 0.4);
    }
    if (wet) addDecal(p, UP, 2, 0.35 + R() * 0.2, 1.4, 0.3);
  }

  function actorKilled(e) {
    if (!ready) return;
    const p = e?.point || e?.actor?.position;
    if (!p) return;
    for (let i = 0; i < 30; i++) {                         // plasma dissipation
      cone(UP, 1.0, _d).multiplyScalar(0.5 + R() * 2.6);
      emitB(p, _d, 5, 0.06 + R() * 0.16, 0.10, 0.6 + R() * 0.9);
    }
    if (/grunt|unggoy/i.test(String(e?.actor?.type || ''))) {
      for (let i = 0; i < 34; i++) {                       // methane tank jet
        cone(UP, 0.22, _d).multiplyScalar(5.0 + R() * 13.0);
        emitB(p, _d, 8, 0.05 + R() * 0.11, 0.30, 0.5 + R() * 0.8);
      }
    }
  }

  function explosion(point, radius = 3.0) {
    if (!ready || !point) return;
    for (let i = 0; i < 34; i++) {                         // fireball
      cone(UP, 1.0, _d).multiplyScalar(2.0 + R() * 9.0);
      emitB(point, _d, 6, 0.28 + R() * 0.55, 1.4, 0.35 + R() * 0.45);
    }
    for (let i = 0; i < 26; i++) {                         // smoke column
      cone(UP, 0.9, _d).multiplyScalar(1.2 + R() * 4.5);
      emitA(point, _d, 0, 0.35 + R() * 0.7, 1.5, 1.3 + R() * 1.4);
    }
    for (let i = 0; i < 40; i++) {                         // thrown sand
      cone(UP, 0.8, _d).multiplyScalar(6.0 + R() * 17.0);
      emitA(point, _d, 1, 0.02 + R() * 0.05, 0, 0.8 + R() * 1.0);
    }
    for (let i = 0; i < 3; i++) {                          // shockwave ring
      _d.set(0, 0, 0);
      emitB(point, _d, 7, radius * (0.30 + i * 0.10), radius * 3.4, 0.30 + i * 0.06);
    }
    spawnDebris(point, radius);
    addDecal(point, UP, 1, radius * 0.55, 18.0, 0.8);
  }

  /* -------- debris: real bodies when `physics` is up, plain ballistics if not */
  function spawnDebris(point, radius) {
    const phys = ctx.get('physics');
    const n = Math.min(10, DEBRIS_MAX - debris.length);
    for (let i = 0; i < n; i++) {
      cone(UP, 0.85, _d).multiplyScalar(4.0 + R() * 12.0);
      const size = 0.05 + R() * 0.11;
      const d = {
        pos: new THREE.Vector3(point.x, point.y + 0.1, point.z),
        vel: _d.clone(),
        quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(R() * 6.28, R() * 6.28, R() * 6.28)),
        spin: new THREE.Vector3(RS() * 9, RS() * 9, RS() * 9),
        size, life: 3.0 + R() * 2.5, body: null,
      };
      if (phys && typeof phys.addBody === 'function') {
        try {
          d.body = phys.addBody({
            position: d.pos.clone(), velocity: d.vel.clone(), radius: size,
            mass: size * 8, restitution: 0.3, friction: 0.7, drag: 0.06,
            life: d.life, mask: phys.MASK?.DEBRIS,
          });
        } catch { d.body = null; }
      }
      debris.push(d);
    }
  }

  function stepDebris(dt) {
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        if (d.body) ctx.get('physics')?.removeBody?.(d.body.id);
        debris.splice(i, 1);
        continue;
      }
      if (d.body) {
        d.pos.copy(d.body.position);
        if (d.body.quaternion) d.quat.copy(d.body.quaternion);
      } else if (dt > 0) {
        d.vel.y -= 19.6 * dt;
        d.pos.addScaledVector(d.vel, dt);
        const gy = groundAtCPU(d.pos.x, d.pos.z) + d.size;
        if (d.pos.y < gy) { d.pos.y = gy; d.vel.y = Math.abs(d.vel.y) * 0.3; d.vel.x *= 0.6; d.vel.z *= 0.6; }
      }
      if (dt > 0 && d.spin.lengthSq() > 1e-6) {
        _dq.setFromAxisAngle(_ds.copy(d.spin).normalize(), d.spin.length() * dt);
        d.quat.premultiply(_dq);
      }
    }
    debrisMesh.count = debris.length;
    debrisMesh.visible = debris.length > 0;
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i];
      _dm.compose(d.pos, d.quat, _ds.set(d.size, d.size * 0.8, d.size * 1.1));
      debrisMesh.setMatrixAt(i, _dm);
    }
    if (debris.length) debrisMesh.instanceMatrix.needsUpdate = true;
  }

  /* --------------------------------------------------------------- module */
  const api = {
    name: 'particles',
    order: 60,
    enabled: true,

    /** Public FX API (not in docs/API.md — consumers should feature-detect). */
    impact, explosion, addDecal,
    get liveDecals() { return decalsLive; },
    get debrisCount() { return debris.length; },

    async init(c) {
      ctx = c;
      renderer = c.renderer;
      rnd.r = c.rand.fork(0x9a17c1);

      if (!c.caps.floatRender) {
        console.warn('[particles] EXT_color_buffer_float missing — particle system disabled');
        return;
      }
      groundTex.minFilter = groundTex.magFilter =
        c.caps.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;

      bakeGround();
      refreshLandmarks();

      const simU = {
        uGroundTex: U.uGroundTex, uGroundMin: U.uGroundMin, uGroundSize: U.uGroundSize,
        uDt: U.uDt, uTime: U.uTime, uWind: U.uWind, uCamPos: U.uCamPos, uGust: U.uGust,
      };
      amb = new GpuSystem(AMB_W, AMB_H, AMBIENT_SIM, Object.assign({
        uShoreTex: U.uShoreTex, uStacks: U.uStacks, uStackCount: U.uStackCount,
        uBridge: U.uBridge, uDeckY: U.uDeckY, uRows: U.uRows,
      }, simU), false);
      fx = new GpuSystem(FX_W, FX_H, FX_SIM, simU, true);

      addDraw(amb, 0,         ROW_SAND,               AMB_W, 0, false, 0.40, -10);
      addDraw(amb, ROW_SAND,  ROW_SPRAY - ROW_SAND,   AMB_W, 1, true,  0.50, -8);
      addDraw(amb, ROW_SPRAY, ROW_DUST - ROW_SPRAY,   AMB_W, 2, true,  0.35, -6);
      addDraw(amb, ROW_DUST,  ROW_POLLEN - ROW_DUST,  AMB_W, 3, true,  0.35, -4);
      addDraw(fx,  0,         FX_SPLIT,               FX_W,  4, false, 1.20, 0);
      addDraw(fx,  FX_SPLIT,  FX_H - FX_SPLIT,        FX_W,  5, true,  0.85, 2);

      c.scene.add(group);

      c.on('engine:ready', () => { bakeGround(); refreshLandmarks(); needsReseed = true; });
      c.on('camera:teleport', () => { needsReseed = true; });
      c.on('weapon:impact', (e) => impact(e?.point, e?.normal, e?.surface ?? matName(e?.material)));
      c.on('weapon:fired', muzzle);
      c.on('player:footstep', footstep);
      c.on('actor:damaged', (e) => { if (e?.point) impactFlesh(e.point, UP); });
      c.on('actor:killed', actorKilled);
      for (const evt of ['weapon:explosion', 'grenade:explode', 'explosion']) {
        c.on(evt, (e) => explosion(e?.point || e?.position, e?.radius ?? 3.0));
      }

      ready = true;
    },

    update(dt, c) {
      if (!ready) return;
      group.visible = api.enabled !== false;
      if (!group.visible) return;

      const frozen = !!c.config.frozen;
      const sdt = frozen ? 0 : Math.min(dt, 1 / 20);
      U.uDt.value = sdt;
      U.uTime.value = c.clock.t;
      U.uCamPos.value.copy(c.camera.position);
      U.uDensity.value = c.config.particleDensity ?? 1;

      const time = c.get('time');
      if (time) {
        U.uWind.value.copy(time.wind);
        U.uGust.value = time.state?.gust ?? 0.62;
        U.uSunDir.value.copy(time.sunDir);
        // `lighting` drives a DirectionalLight of intensity sunIntensity and a
        // HemisphereLight of ~1.35; dividing by pi converts those to the outgoing
        // radiance a diffuse scatterer would emit, which is the same scale the world
        // materials land on. Particles must share it or they float in the exposure.
        U.uSunColor.value.copy(time.sunColor).multiplyScalar((time.state?.sunIntensity ?? 6.2) / Math.PI);
        U.uSkyColor.value.copy(time.skyColor).multiplyScalar(1.35 / Math.PI);
      }

      updateShoreProbes(c.clock.t);
      ageDecals(sdt);
      stepDebris(sdt);
      for (const s of shimSlots) s.w = Math.max(0, s.w - sdt * 5.5);
    },

    prerender(c) {
      if (!ready || !group.visible) return;
      const pl = c.get('pipeline');
      pipe = pl?.pipe || null;

      const cam = c.camera;
      U.uNear.value = cam.near;
      U.uFar.value = cam.far;
      U.uProjScaleY.value = 0.5 * U.uRes.value.y / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
      U.uOpaque.value = pipe?.opaqueRT?.texture || null;
      U.uGbuf0.value = pipe?.gbuffer?.textures?.[0] || null;
      U.uGbuf1.value = pipe?.gbuffer?.textures?.[1] || null;
      // Without a pipeline the copy never gets written; binding an uninitialised float
      // target would make the soft-particle fade read garbage. Fall back to "no depth",
      // which three binds as white => scene at the far plane => no fade.
      U.uDepth.value = (pipe && depthCopyRT) ? depthCopyRT.texture : null;
      decalMesh.visible = !!(pipe && depthCopyRT && decalsLive > 0);
      shimmer.visible = !!U.uOpaque.value;

      const prev = renderer.getRenderTarget();
      if (needsReseed) { amb.reset(renderer); fx.reset(renderer); needsReseed = false; }
      else { amb.step(renderer); fx.step(renderer); }
      renderer.setRenderTarget(prev);
    },

    resize(w, h) {
      U.uRes.value.set(w, h);
      if (depthCopyRT) depthCopyRT.dispose();
      depthCopyRT = makeRT(w, h, {
        type: THREE.FloatType, format: THREE.RedFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      U.uDepth.value = depthCopyRT.texture;
    },

    dispose(c) {
      c?.scene.remove(group);
      amb?.dispose(); fx?.dispose();
      depthCopyRT?.dispose(); depthQuad.dispose();
      for (const m of draws) { m.geometry.dispose(); m.material.dispose(); }
      decalGeom.dispose(); decalMat.dispose(); decalTex.dispose();
      birds.geometry.dispose(); birdMat.dispose();
      shimmer.geometry.dispose(); shimmerMat.dispose();
      debrisMesh.geometry.dispose(); debrisMat.dispose();
      groundTex.dispose(); shoreTex.dispose(); probeMat.dispose();
      ready = false;
    },
  };

  return api;
}
