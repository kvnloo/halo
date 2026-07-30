import * as THREE from 'three';
import { Pass, fsMaterial, makeRT, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `cloudComposite` — resolves `clouds.buffer` onto the HDR chain.
 *
 * The clouds module raymarches at half resolution into an RGBA half-float buffer with
 * `rgb` = in-scattered radiance and `a` = transmittance (docs/API.md). Compositing that is
 * one line — `scene * a + rgb`. Upsampling it correctly is not.
 *
 * ## Why a bilateral and not a bilinear
 *
 * A cloud raymarch terminates at scene depth, so its buffer is *discontinuous across every
 * silhouette*: the texel that landed on a sea stack marched 300 m and came back opaque and
 * dark, the texel 1 px away marched to the cloud deck and came back bright. A bilinear
 * upsample blends the two and paints a half-resolution-wide bright fringe around every
 * stack, mast and cliff edge — the single most recognisable "this is a half-res effect"
 * artefact there is, and it is at its worst exactly where this scene puts its hero
 * geometry: hard rock against bright sky.
 *
 * The fix is to weight the four low-resolution taps by how well each one's *own* scene
 * depth matches this pixel's, and that requires knowing which depth each tap used. Rather
 * than asking the clouds module to publish a depth buffer (it is not in the frozen API and
 * it is being written concurrently), the reference depth for a tap is fetched from the
 * full-resolution depth texture at the tap's own centre. `pipe.depthTex` is NearestFilter,
 * so that is a well-defined single texel and it is the same texel a half-resolution pass
 * would have read. Taps that ran on sky are recognised as sky; taps that ran on rock are
 * recognised as rock; neither contaminates the other.
 *
 * When all four taps disagree with the centre pixel — a one-pixel-wide silhouette, a thin
 * mast, a foam edge — the weighted average is meaningless, so the nearest-depth tap is
 * taken whole. That is the standard nearest-depth fallback and it is what keeps thin
 * geometry from getting a halo of its own.
 *
 * ## Ordering
 *
 * This runs **before** `volumetricFog` (see PASS_MANIFEST). Sun shafts are integrated over
 * the scene colour that this pass produces, so the shafts attenuate a cloudy sky rather
 * than a clear one, and the fog's transmittance dims cloud radiance at distance the same
 * way it dims everything else.
 *
 * ## Absent dependency
 *
 * `clouds` is a separate module on a separate schedule; `ctx.get('clouds')` may be null,
 * may be a half-built object, and `clouds.buffer` may be null for many frames after that.
 * Every one of those cases is a straight pass-through. The copy is not free (~0.05 ms at
 * 1080p) and cannot be skipped: the chain swaps read/write around this pass whether or not
 * it had anything to say, so `out` must be written.
 *
 * ## ctx.config knobs
 * ```
 * clouds            true   master enable for the composite
 * cloudStrength     1.0    0 = clouds invisible, 1 = as the clouds module rendered them
 * cloudDepthTol     1.0    scale on the bilateral depth tolerance
 * ```
 */

const FRAG = /* glsl */`
in vec2 vUv;

uniform sampler2D tSrc;
uniform sampler2D tCloud;
uniform sampler2D tDepth;

uniform vec2  uLowRes;
uniform vec2  uInvLowRes;
uniform float uNear, uFar;
uniform float uStrength;
uniform float uTolScale;

out vec4 oCol;

float linZ(float d){
  float n = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / max(uFar + uNear - n * (uFar - uNear), 1e-6);
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;

  float zc = linZ(texture(tDepth, vUv).r);

  vec2 c = vUv * uLowRes - 0.5;
  vec2 base = floor(c);
  vec2 f = c - base;

  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  vec4 bestTap = vec4(0.0, 0.0, 0.0, 1.0);
  float bestErr = 1e30;

  // Relative, because depth precision and the depth *range* a cloud march cares about
  // both scale with distance: 2 m of disagreement is a silhouette at 20 m and noise at
  // 4 km. The additive term keeps the near field from becoming infinitely picky.
  float tol = uTolScale * (0.04 * zc + 0.25);

  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i & 1), float(i >> 1));
    vec2 uvL = clamp((base + o + 0.5) * uInvLowRes, uInvLowRes * 0.5, 1.0 - uInvLowRes * 0.5);
    float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);

    float zi = linZ(texture(tDepth, uvL).r);
    vec4 s = texture(tCloud, uvL);

    float err = abs(zi - zc);
    if (err < bestErr) { bestErr = err; bestTap = s; }

    float w = bw * exp(-err / tol);
    acc += s * w;
    wsum += w;
  }

  vec4 cl = (wsum > 1e-4) ? acc / wsum : bestTap;

  // NaN-safe: a half-built raymarch that divides by a zero optical depth writes NaN, and
  // a NaN here is a permanent black pixel once TAA gets hold of it.
  cl = mix(vec4(0.0, 0.0, 0.0, 1.0), cl, vec4(equal(cl, cl)));

  vec3 rad = max(cl.rgb, vec3(0.0)) * uStrength;
  float trans = mix(1.0, clamp(cl.a, 0.0, 1.0), uStrength);

  oCol = vec4(src * trans + rad, 1.0);
}
`;

export function create(opts = {}) {
  const p = new Pass('cloudComposite');

  const cfg = Object.assign({
    strength: 1.0,
    tolScale: 1.0,
  }, opts.cloudComposite || {});

  let quad = null, mat = null;

  p.init = (ctx, pipe) => {
    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      tCloud: { value: null },
      tDepth: { value: null },
      uLowRes: { value: new THREE.Vector2(1, 1) },
      uInvLowRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.06 },
      uFar: { value: 12000 },
      uStrength: { value: cfg.strength },
      uTolScale: { value: cfg.tolScale },
    });
    mat.blending = THREE.NoBlending;
    quad = new FullScreenQuad(mat);
  };

  p.render = (ctx, pipe, out) => {
    const r = ctx.renderer;
    const c = ctx.config || {};

    const clouds = ctx.get('clouds');
    const buf = clouds && clouds.enabled !== false ? clouds.buffer : null;
    const tex = buf && buf.isTexture ? buf : null;

    // Nothing to composite (module absent, still initialising, or switched off).
    if (!tex || c.clouds === false || !mat) { pipe.blit(pipe.read.texture, out); return; }

    // The contract says half resolution; trust the texture over the contract, because a
    // module that changes its internal scale should not silently break this upsample.
    const lw = Math.max(1, tex.image?.width || Math.round(pipe.w * 0.5));
    const lh = Math.max(1, tex.image?.height || Math.round(pipe.h * 0.5));

    const u = mat.uniforms;
    u.tSrc.value = pipe.read.texture;
    u.tCloud.value = tex;
    u.tDepth.value = pipe.depthTex;
    u.uLowRes.value.set(lw, lh);
    u.uInvLowRes.value.set(1 / lw, 1 / lh);
    u.uNear.value = ctx.camera.near;
    u.uFar.value = ctx.camera.far;
    u.uStrength.value = THREE.MathUtils.clamp(c.cloudStrength ?? cfg.strength, 0, 1);
    u.uTolScale.value = Math.max(c.cloudDepthTol ?? cfg.tolScale, 0.01);

    r.setRenderTarget(out);
    quad.render(r);
  };

  p.setSize = () => {};
  p.dispose = () => quad?.dispose();

  return p;
}
