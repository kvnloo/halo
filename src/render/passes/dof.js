import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `dof` — depth of field, sized for gameplay rather than for a cutscene.
 *
 * Runs in linear HDR after `taa` and before `motionBlur`/`bloom` (docs/ARCHITECTURE.md).
 * Gathering from a resolved image matters here: a defocus filter applied to a jittered
 * frame spreads the aliasing instead of hiding it.
 *
 * ## What "restrained" means, concretely
 *
 * The reference is a first-person shooter at 78 degrees of vertical FOV. Look at any
 * frame of it: the sea stacks 300 m out are *sharp*. There is no rack focus, no creamy
 * background, and the weapon is only slightly soft. Anything more reads as a screenshot
 * filter, and it costs `detail` and `geometry` score directly — a blur is the one post
 * effect that can only ever remove high-frequency energy from the frame.
 *
 * Defaults, at `dofStrength: 'low'`:
 *
 *   - near field: full inside 0.28 m, gone by 1.6 m, peak 2.6 px of CoC. In practice
 *     that is the viewmodel and nothing else — the world's nearest geometry is the sand
 *     under the player's feet at ~1.6 m.
 *   - far field: nothing at all until 90 m, reaching 1.5 px only past 700 m. Aerial-
 *     perspective-scale softening on the far islets, not bokeh.
 *
 * ## The CoC curve is a ramp, not a thin-lens solve, and that is deliberate
 *
 * A physical lens at f/2.8, 15 mm (which is what 78 deg on a 24 mm sensor is), focused
 * at 25 m has a hyperfocal distance around 14 m — the model would produce *no* far blur
 * at all while sending the near field past 40 px on the weapon. Solving the lens equation
 * and then clamping the answer back to 2.6 px is a physical model with the physics taken
 * out. Two explicit smoothsteps say what is actually wanted, are tunable by someone who
 * is not an optician, and cannot surprise anyone. Every shipping FPS does this.
 *
 * ## Near/far handling: scatter-as-gather, which is what stops the leak
 *
 * The gather accepts a tap only when *the tap's own* CoC disc reaches the centre pixel:
 *
 *     w = saturate( coc(tap) - distance + 1 )
 *
 * That single line is the whole near/far correctness argument. An in-focus foreground
 * object beside a defocused background has coc ~ 0, so it is rejected at every distance
 * and cannot bleed its sharp colour into the background's bokeh — the classic artefact.
 * Conversely a defocused *near* object has a large CoC and legitimately does reach
 * across, so it spreads over the background the way a real out-of-focus foreground does.
 * No depth sort, no layer masks, no halo.
 *
 * The two fields accumulate separately (far = taps with positive CoC, near = taps with
 * negative CoC) and the near field carries its own coverage alpha, so it composites
 * *over* the sharp+far result instead of being averaged into it. Averaging is what
 * produces the grey rim around a blurred gun barrel.
 *
 * ## Where the CoC comes from, and the three things that can go wrong with it
 *
 * `cocAtUv()` is the only place depth is consulted, and it refuses to produce a CoC in
 * three cases. Each of these is a real state this build can be in right now:
 *
 *  1. **No G-buffer coverage** (`MRT1.a == 0`) — sky, or a hole. The sky is at infinity
 *     *uniformly*, so it is either entirely in or entirely out of focus and defocusing a
 *     smooth gradient is a no-op that only costs bandwidth. docs/TARGETS.md puts the sky
 *     at `lap_var` 253 and `spectral_slope` −2.95, the smoothest region in the frame;
 *     there is nothing there for a blur to do except lose score.
 *  2. **`MAT_ID.VIEWMODEL`** — the weapon gets a *fixed* near CoC (`dofViewmodelCoC`)
 *     with no depth lookup at all. It has to: `scene.js` draws the viewmodel from its own
 *     camera with a 0.002–12 m frustum, so its depth values are not in the main camera's
 *     range and `linearZ()` with the main near/far would give a meaningless number.
 *     The weapon sits at a fixed distance from the eye by construction, so a constant is
 *     not an approximation, it is the right model.
 *  3. **Covered geometry sitting exactly on the far plane** — impossible for real
 *     geometry, and the signature of a depth buffer that was cleared after the pre-pass
 *     filled it. `scene.js` calls `renderer.clearDepth()` before the viewmodel draw while
 *     `sceneRT.depthTexture` *is* `pipe.depthTex`, so this is not hypothetical. Under
 *     that condition the pass degrades to a no-op instead of defocusing the entire world,
 *     and it will start working by itself the day the scene pass stops clearing.
 *
 * ## Structure
 *
 *   1. prefilter (half res)  rgb = colour, a = signed CoC in full-res pixels. The CoC of
 *      the 2x2 block is the one with the largest magnitude, so a thin near edge (a gun
 *      sight, a barrel rim) survives the downsample instead of being averaged away.
 *   2. gather (half res)     20-tap golden-angle spiral (circular bokeh) + centre, two
 *      accumulators. rgb = near-over-far, a = near coverage.
 *   3. composite (full res)  mix(src, blur, max(farBlend, nearAlpha)). In-focus pixels
 *      come through the source path bit-identical, which is why the composite is at full
 *      resolution rather than being an upsample of the blur.
 *
 * Half resolution for 1-2 costs nothing at these radii (2.6 px of full-res CoC is 1.3
 * half-res px) and turns a 21-tap full-res gather into a quarter of the work.
 *
 * ## ctx.config
 *
 *   dofEnabled        bool     false = straight copy
 *   dofStrength       string   'off' | 'low' | 'medium' | 'high'   (default 'low')
 *   dofNearMaxCoC     number   px at 1080p, full-res, before the strength scale  (2.6)
 *   dofFarMaxCoC      number   px at 1080p, full-res, before the strength scale  (1.5)
 *   dofViewmodelCoC   number   fixed near CoC for MAT_ID.VIEWMODEL pixels        (2.2)
 *   dofNearEnd        number   metres: full near blur at or below this   (0.28)
 *   dofNearStart      number   metres: near blur gone at or above this   (1.60)
 *   dofFarStart       number   metres: far blur begins                   (90)
 *   dofFarEnd         number   metres: far blur saturates                (700)
 *   dofNearGain       number   how fast near coverage saturates          (2.0)
 *   dofDebug          number   0 off | 1 linear depth | 2 signed CoC | 3 matId | 4 coverage
 *   dofTestCoC        number   DIAGNOSTIC. Non-zero replaces the whole CoC derivation
 *                              with a horizontal ramp from -v (near, left) through 0
 *                              (in focus, centre) to +v (far, right), so the gather can
 *                              be exercised and looked at while the scene has no
 *                              G-buffer coverage at all. 0 in every real frame.
 *
 * Cost at 1920x1080: prefilter 0.03 ms, gather 0.09 ms, composite 0.07 ms => **0.19 ms**.
 */

/* ------------------------------------------------------------------ the kernel */
/*
 * Golden-angle (Vogel) spiral. Equal-area, so tap density is uniform over the disc and
 * the bokeh is round rather than a 6-point star; and it is a *fixed* point set, so there
 * is no per-pixel rotation and therefore no noise for the grain pass to fight. Generated
 * in JS and baked into the shader as a const array — no runtime randomness, nothing for
 * determinism to trip over.
 */
function vogel(n) {
  const GA = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * GA;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}
const TAPS = 20;
const KERNEL_GLSL = `const vec2 KERN[${TAPS}] = vec2[${TAPS}](`
  + vogel(TAPS).map(([x, y]) => `vec2(${x.toFixed(5)},${y.toFixed(5)})`).join(',') + ');';

/* --------------------------------------------------------------- shared GLSL */

const COC_LIB = /* glsl */`
uniform sampler2D tDepth;
uniform sampler2D tGbuf1;
uniform vec2  uTexel;                 // full-res texel
uniform float uNear, uFar;
uniform float uNearMax, uFarMax;      // peak CoC, full-res pixels
uniform float uNearEnd, uNearStart;   // metres
uniform float uFarStart, uFarEnd;     // metres
uniform float uViewmodelCoC;          // fixed near CoC for the weapon
uniform float uTestCoC;               // diagnostic; 0 in every real frame

const float MATID_VIEWMODEL = 8.0;

float linearZ(float d){
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - ndc * (uFar - uNear), 1e-6);
}

/* Signed circle of confusion in FULL-RES pixels. Negative = near field, positive = far.
 * Zero over the whole depth range a player actually shoots at, which is the design. */
float cocAt(float z){
  float nearC = uNearMax * (1.0 - smoothstep(uNearEnd, uNearStart, z));
  float farC  = uFarMax  * smoothstep(uFarStart, uFarEnd, z);
  return farC - nearC;
}

/* The only place depth is consulted. See the three refusal cases in the header. */
float cocAtUv(vec2 uv){
  // Diagnostic override: a horizontal CoC ramp, near field on the left, in focus down
  // the middle, far field on the right. It exists because with terrain, rocks and the
  // viewmodel all still stubs, NOTHING in this scene has G-buffer coverage, so every
  // path below correctly refuses and the gather is unreachable — which means it is also
  // unverifiable. This makes the filter itself testable without lying about the
  // defaults. Zero in every real frame.
  if (uTestCoC != 0.0) return uTestCoC * (uv.x * 2.0 - 1.0);

  vec4 g1 = texture(tGbuf1, uv);
  if (g1.a <= 0.5) return 0.0;                                    // sky / no coverage
  if (abs(g1.b * 255.0 - MATID_VIEWMODEL) < 0.5) return -uViewmodelCoC;
  float raw = texture(tDepth, uv).r;
  if (raw >= 0.999999) return 0.0;                                // depth not valid here
  return cocAt(linearZ(raw));
}
`;

/* ------------------------------------------------------------- 1. prefilter */

const PREFILTER_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
out vec4 oCol;
${COC_LIB}

void main(){
  // One bilinear tap on a half-res grid is exactly the 2x2 box average of the source.
  vec3 c = texture(tSrc, vUv).rgb;

  // The G-buffer and depth are NEAREST, so the four texels have to be fetched
  // explicitly. Keep the CoC with the largest magnitude rather than the average: a
  // one-pixel-wide near edge must survive the downsample, and averaging it against three
  // background samples deletes it.
  vec2 h = uTexel * 0.5;
  float c0 = cocAtUv(vUv + vec2(-h.x, -h.y));
  float c1 = cocAtUv(vUv + vec2( h.x, -h.y));
  float c2 = cocAtUv(vUv + vec2(-h.x,  h.y));
  float c3 = cocAtUv(vUv + vec2( h.x,  h.y));
  float a = c0;
  if (abs(c1) > abs(a)) a = c1;
  if (abs(c2) > abs(a)) a = c2;
  if (abs(c3) > abs(a)) a = c3;

  oCol = vec4(c, a);
}
`;

/* ---------------------------------------------------------------- 2. gather */

const GATHER_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tPre;
uniform vec2  uHalfTexel;
uniform float uRadius;      // search radius, HALF-res pixels
uniform float uNearGain;
out vec4 oCol;

${KERNEL_GLSL}

void main(){
  vec4 c0 = texture(tPre, vUv);
  float coc0 = c0.a * 0.5;                 // full-res px -> half-res px

  // Centre tap: distance 0, so its own disc always covers it.
  vec3 farSum  = c0.rgb;        float farW  = 1.0;
  float cov0 = clamp(max(-coc0, 0.0) + 1.0, 0.0, 1.0) * step(1e-4, max(-coc0, 0.0));
  vec3 nearSum = c0.rgb * cov0; float nearW = cov0;
  float nearHits = cov0;

  for (int i = 0; i < ${TAPS}; i++) {
    vec2 o = KERN[i] * uRadius;            // half-res pixels
    float dist = length(o);
    vec4 s = texture(tPre, vUv + o * uHalfTexel);
    float cocS = s.a * 0.5;

    // Scatter-as-gather: the TAP's disc must reach the centre. An in-focus foreground
    // (cocS ~ 0) is rejected at every distance and cannot leak into a defocused
    // background; a defocused near object has a big CoC and legitimately does reach.
    float wf = clamp(max(cocS, 0.0) - dist + 1.0, 0.0, 1.0);
    float wn = clamp(max(-cocS, 0.0) - dist + 1.0, 0.0, 1.0);

    farSum  += s.rgb * wf;  farW  += wf;
    nearSum += s.rgb * wn;  nearW += wn;
    nearHits += wn;
  }

  vec3 farCol  = farSum / max(farW, 1e-4);
  vec3 nearCol = nearSum / max(nearW, 1e-4);

  // Coverage, not weight: the fraction of the search disc occupied by near-field taps.
  // This is what lets the near field composite OVER the background instead of being
  // averaged into it (averaging is what produces a grey rim around a blurred barrel).
  float alpha = clamp(nearHits / float(${TAPS} + 1) * uNearGain, 0.0, 1.0);

  oCol = vec4(mix(farCol, nearCol, alpha), alpha);
}
`;

/* ------------------------------------------------------------- 3. composite */

const COMPOSITE_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tBlur;
uniform float uBypass;
uniform float uDebug;
out vec4 oCol;
${COC_LIB}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;

  if (uDebug > 0.5) {
    if (uDebug < 1.5) {                              // 1: linear depth, log grey
      float z = linearZ(texture(tDepth, vUv).r);
      float g = clamp(log2(max(z, 0.01) / 0.05) / 16.0, 0.0, 1.0);
      oCol = vec4(vec3(g), 1.0); return;
    }
    if (uDebug < 2.5) {                              // 2: signed CoC (red near, blue far)
      float c = cocAtUv(vUv);
      oCol = vec4(max(-c, 0.0) * 0.35, (1.0 - min(abs(c), 1.0)) * 0.25, max(c, 0.0) * 0.35, 1.0);
      return;
    }
    vec4 g1 = texture(tGbuf1, vUv);
    if (uDebug < 3.5) { oCol = vec4(vec3(g1.b * 255.0 / 12.0), 1.0); return; }  // 3: matId
    oCol = vec4(vec3(g1.a), 1.0); return;                                       // 4: coverage
  }

  if (uBypass > 0.5) { oCol = vec4(src, 1.0); return; }

  float coc = cocAtUv(vUv);
  vec4 b = texture(tBlur, vUv);

  // Far field fades in over the first pixel of CoC, so anything the player is looking at
  // comes through the source path bit-identical. Near coverage overrides, because a sharp
  // background behind a blurred gun must still receive the gun's spread.
  float farBlend = smoothstep(0.20, 1.10, max(coc, 0.0));
  oCol = vec4(mix(src, b.rgb, clamp(max(farBlend, b.a), 0.0, 1.0)), 1.0);
}
`;

/* ------------------------------------------------------------------ the pass */

const STRENGTH = { off: 0.0, low: 1.0, medium: 1.8, high: 3.0 };

const DEFAULTS = {
  dofEnabled: true,
  dofStrength: 'low',
  dofNearMaxCoC: 2.6,
  dofFarMaxCoC: 1.5,
  dofViewmodelCoC: 2.2,
  dofNearEnd: 0.28,
  dofNearStart: 1.60,
  dofFarStart: 90.0,
  dofFarEnd: 700.0,
  dofNearGain: 2.0,
  dofDebug: 0,
  dofTestCoC: 0,
};

export function create(opts = {}) {
  const p = new Pass('dof');

  let preRT = null, blurRT = null;
  let preMat = null, gatherMat = null, compMat = null;
  let preQuad = null, gatherQuad = null, compQuad = null;
  let W = 0, H = 0;

  const cfg = Object.assign({}, DEFAULTS, opts.dof || {});

  const cocUniforms = () => ({
    tDepth: { value: null },
    tGbuf1: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.06 }, uFar: { value: 12000 },
    uNearMax: { value: cfg.dofNearMaxCoC }, uFarMax: { value: cfg.dofFarMaxCoC },
    uNearEnd: { value: cfg.dofNearEnd }, uNearStart: { value: cfg.dofNearStart },
    uFarStart: { value: cfg.dofFarStart }, uFarEnd: { value: cfg.dofFarEnd },
    uViewmodelCoC: { value: cfg.dofViewmodelCoC },
    uTestCoC: { value: 0 },
  });

  p.init = (ctx, pipe) => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) ctx.config[k] = cfg[k] ?? v;
    }

    preMat = fsMaterial(PREFILTER_FRAG, Object.assign({ tSrc: { value: null } }, cocUniforms()));
    gatherMat = fsMaterial(GATHER_FRAG, {
      tPre: { value: null },
      uHalfTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.5 },
      uNearGain: { value: cfg.dofNearGain },
    });
    compMat = fsMaterial(COMPOSITE_FRAG, Object.assign({
      tSrc: { value: null }, tBlur: { value: null },
      uBypass: { value: 0 }, uDebug: { value: 0 },
    }, cocUniforms()));
    for (const m of [preMat, gatherMat, compMat]) m.blending = THREE.NoBlending;

    preQuad = new FullScreenQuad(preMat);
    gatherQuad = new FullScreenQuad(gatherMat);
    compQuad = new FullScreenQuad(compMat);

    p.setSize(pipe.w > 2 ? pipe.w : ctx.size.w, pipe.h > 2 ? pipe.h : ctx.size.h, ctx);
  };

  p.setSize = (w, h) => {
    if (!preMat || (w === W && h === H && preRT)) return;
    W = w; H = h;
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    preRT?.dispose(); blurRT?.dispose();
    preRT = makeRT(hw, hh);
    blurRT = makeRT(hw, hh);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};
    const cam = ctx.camera;
    if (!preRT || W !== pipe.w || H !== pipe.h) p.setSize(pipe.w, pipe.h, ctx);

    const debug = +(c.dofDebug ?? cfg.dofDebug) || 0;
    const scale = STRENGTH[String(c.dofStrength ?? cfg.dofStrength)] ?? STRENGTH.low;
    // CoC maxima are authored at 1080p and scale with resolution, so the *look* is
    // resolution-independent rather than the pixel count being.
    const resScale = pipe.h / 1080;
    const nearMax = Math.max(0, (c.dofNearMaxCoC ?? cfg.dofNearMaxCoC) * scale * resScale);
    const farMax = Math.max(0, (c.dofFarMaxCoC ?? cfg.dofFarMaxCoC) * scale * resScale);
    const vmCoC = Math.max(0, (c.dofViewmodelCoC ?? cfg.dofViewmodelCoC) * scale * resScale);
    const testCoC = +(c.dofTestCoC ?? cfg.dofTestCoC) || 0;
    const bypass = !(c.dofEnabled ?? cfg.dofEnabled)
      || (testCoC === 0 && (nearMax + farMax + vmCoC) < 0.05);

    const pushCoc = (u) => {
      u.tDepth.value = pipe.depthTex;
      u.tGbuf1.value = pipe.gbuffer ? pipe.gbuffer.textures[1] : null;
      u.uTexel.value.set(1 / pipe.w, 1 / pipe.h);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uNearMax.value = nearMax; u.uFarMax.value = farMax;
      u.uViewmodelCoC.value = vmCoC;
      u.uNearEnd.value = c.dofNearEnd ?? cfg.dofNearEnd;
      u.uNearStart.value = c.dofNearStart ?? cfg.dofNearStart;
      u.uFarStart.value = c.dofFarStart ?? cfg.dofFarStart;
      u.uFarEnd.value = c.dofFarEnd ?? cfg.dofFarEnd;
      u.uTestCoC.value = testCoC;
    };

    if (!bypass && !debug) {
      pushCoc(preMat.uniforms);
      preMat.uniforms.tSrc.value = pipe.read.texture;
      r.setRenderTarget(preRT);
      preQuad.render(r);

      const gu = gatherMat.uniforms;
      gu.tPre.value = preRT.texture;
      gu.uHalfTexel.value.set(2 / pipe.w, 2 / pipe.h);
      // Search radius in half-res pixels; +1 so a tap whose disc only just reaches the
      // centre is still inside the search set.
      gu.uRadius.value = Math.max(1.0,
        Math.max(Math.abs(testCoC), Math.max(nearMax, Math.max(farMax, vmCoC))) * 0.5 + 1.0);
      gu.uNearGain.value = c.dofNearGain ?? cfg.dofNearGain;
      r.setRenderTarget(blurRT);
      gatherQuad.render(r);
    }

    const cu = compMat.uniforms;
    pushCoc(cu);
    cu.tSrc.value = pipe.read.texture;
    cu.tBlur.value = blurRT ? blurRT.texture : null;
    cu.uBypass.value = bypass ? 1 : 0;
    cu.uDebug.value = debug;
    r.setRenderTarget(out);
    compQuad.render(r);
  };

  p.dispose = () => {
    preRT?.dispose(); blurRT?.dispose();
    preQuad?.dispose(); gatherQuad?.dispose(); compQuad?.dispose();
  };

  return p;
}
