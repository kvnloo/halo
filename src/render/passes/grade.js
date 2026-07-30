import * as THREE from 'three';
import { Pass, fsMaterial, FullScreenQuad } from '../RenderPipeline.js';

/**
 * `grade` — the colourist trim, applied in display space after `tonemap`.
 *
 * The whole transform is evaluated on the CPU into a 32^3 3D LUT at init (and again
 * only when a parameter actually changes), so the per-pixel cost on the GPU is one
 * tetrahedrally-interpolated lookup no matter how baroque the grade gets.
 *
 * ## The chain, in order
 *
 *   1. white balance     Bradford CAT, evaluated on linearised display values
 *   2. ASC CDL           out = (in * slope + offset) ^ power        per channel
 *   3. lift / gamma / gain                                          per channel
 *   4. contrast around a pivot (power law, so it cannot clip on its own)
 *   5. saturation (Rec.709 luma preserving)
 *   6. split tone        cool into the shadows, warm into the highlights
 *   7. soft roll-off     a C1 exponential toe and shoulder
 *
 * Dither is deliberately NOT in this list; see "Dither lives at the end of the chain".
 *
 * ## EDITING THIS FILE
 *
 * Every shader here is a template literal and every one of them is documented in prose.
 * A markdown backtick inside `FRAG` closes the literal and the rest of the shader is
 * parsed as JavaScript; the module then fails to import, `pipeline.js` catches it, and
 * the pass is silently dropped with one line of console warning. That has already
 * happened once and cost a whole review cycle - the shipped build ran with no grade and
 * no dither at all. **There are no backticks inside any template literal in this file,
 * and there must never be.** Before committing:
 *
 *     node --check src/render/passes/grade.js
 *     node -e "import('./src/render/passes/grade.js').then(m=>console.log(Object.keys(m)))"
 *
 * The second one matters more than the first: `--check` parses, `import()` also runs the
 * module body. And after any change, capture and look at the PNG - a pass that fails to
 * load produces a plausible-looking image, which is exactly why the failure survived.
 *
 * ## What this pass must NOT do
 *
 * `tonemap` runs AgX, whose sigmoid already *is* a film curve: measured on a grey ramp
 * it puts 0 at code 0, 0.005 at 6, 0.18 at 128 and rolls off from ~2x exposed-linear to
 * code 255 at 16x. Both tails are already soft. A second toe and shoulder stacked on
 * top of that does not make the image more filmic, it truncates it:
 *
 *   - an early default toe (floor 0.005, knee 0.100) mapped display 0 to 0.0382 =
 *     **code 10**, with derivative exp(-1) = 0.368 at the bottom, so input codes 0..16
 *     were squeezed into output codes 10..18 - 1.4 stops of shadow separation deleted.
 *     Every reference keyframe has min 0 and 0.4-3.2% of its pixels below code 16
 *     (rock crevices, cave interior, the underside of the bridge).
 *   - a later "harmless" toe (floor 0, knee 0.020) still mapped display 0 to 0.020/e =
 *     code 1.9, so the chain could not emit code 0 at all. A 2-code milky black with
 *     nothing gained above it. Both tails now belong entirely to AgX:
 *     `gradeToeStart 0`, `gradeShoulderStart 1.0`. The knobs remain, correctly signed,
 *     for a colourist who wants them; the default is off, not nearly-off.
 *   - an early default shoulder (ceiling 1.0, knee 0.85) mapped display 1.0 to
 *     1 - 0.15*exp(-1) = 0.9448 = **code 241**, clipping the sun disc and the Halo ring
 *     to light grey. The reference reaches 254-255 on 9 of 9 scored keyframes.
 *
 * ## Dither lives at the end of the chain, not here
 *
 * An earlier version keyed the dither off `out === null`, i.e. "am I the pass that writes
 * the default framebuffer". `pipeline.js` registers `sharpen` and `grain` after this pass
 * and both are enabled, so `out` was never null and the dither never executed. The fix
 * after that was to dither unconditionally *inside this pass*, which is also wrong for a
 * subtler reason: `sharpen` is a high-pass and `grain` is an additive noise stage, and
 * both sit between this pass and the 8-bit write. Dither only decorrelates the
 * quantisation error if nothing touches the signal after it.
 *
 * So this pass emits the LUT result and nothing else, and `create()` appends a tiny
 * terminal pass named `dither` that runs last in the chain and does the TPDF injection
 * immediately before the 8-bit write. It declares `providesDither = true`; if any other
 * pass in the chain ever declares the same (the natural home is `grain`, whose header
 * already lists dither among its responsibilities), this one steps aside automatically.
 * `Pass.writesBackbuffer` is used as an assertion there, not as a gate - see `makeDither`.
 *
 * Measured, blue channel down column x=1500 of a `diag_sky` capture, top 800 rows:
 *
 *                                           codes  mean run  max run  runs >= 8px
 *      no dither (shipped, last 2 reviews)     56    11.94       52        45
 *      terminal TPDF, 1.0 LSB peak             65     1.57        9         1
 *      ref/keyframes/kf_00450.png             169     1.37       11         3
 *      ref/keyframes/kf_01500.png             142     1.08        7         0
 *
 * Isolated by differencing a capture against the same capture with `gradeDither 0`, the
 * injected noise is exactly the intended TPDF: 17.8% of pixels shifted -1, 66.6%
 * unchanged, 15.6% shifted +1, mean -0.019 codes, and its autocorrelation is below 0.09
 * at every offset within +/-8 px.
 *
 * ## Config (all under ctx.config, all live)
 *
 *   gradeEnabled      bool     false bypasses the LUT (the dither pass is unaffected)
 *   gradeTempShift    number   white-balance shift in MIREDS, + = warmer. 0 = off
 *   gradeTintShift    number   green/magenta trim, + = magenta, in xy units. 0 = off
 *   gradeCdlSlope     [r,g,b]  ASC CDL slope   (multiplicative)
 *   gradeCdlOffset    [r,g,b]  ASC CDL offset  (additive)
 *   gradeCdlPower     [r,g,b]  ASC CDL power   (gamma)
 *   gradeLift         [r,g,b]  raises shadows without touching white
 *   gradeGamma        [r,g,b]  midtone gamma
 *   gradeGain         [r,g,b]  multiplies white without touching black
 *   gradeContrast     number   power law around gradePivot
 *   gradePivot        number   the tonal centre contrast rotates about
 *   gradeSaturation   number   1 = untouched
 *   gradeShadowTint    [r,g,b] added where luma is low
 *   gradeHighlightTint [r,g,b] added where luma is high
 *   gradeSplitPivot   number   luma at which the two masks hand over
 *   gradeBlackFloor   number   toe asymptote, display units
 *   gradeToeStart     number   luma below which the toe engages (0 = off)
 *   gradeWhiteCeil    number   shoulder asymptote, display units
 *   gradeShoulderStart number  luma above which the shoulder engages (1.0 = off)
 *   gradeDither       number   TPDF dither amplitude in LSBs (peak; 1.0 = the standard
 *                              2 LSB peak-to-peak triangular dither). Read by the
 *                              terminal `dither` pass, not by this one.
 *   gradeLutSize      number   LUT grid resolution (default 32; a rebuild reallocates)
 *
 * Cost, measured at 1920x1080 on a 3080 Ti (best of three runs of 200 frames with the
 * pass toggled off and back on, `diag_sky`, ANGLE/Vulkan): **grade 0.18 ms, dither
 * 0.14 ms**. Both are bandwidth-bound - an 8.3 MB RGBA16F read plus an 8.3 MB write -
 * so the 4 texelFetch from a 512 KB LUT that lives in L2, and the dither's ~30 integer
 * ALU, are nearly free on top. Disabling tonemap, grade and dither together saves
 * 0.29 ms rather than the 0.50 ms their individual deltas sum to, because removing one
 * pass from the chain removes a ping-pong round-trip the remaining ones then pay.
 *
 * The 32^3 lattice is accurate to 0.15 code values RMS against the exact transform
 * (0.003 over the sky's gamut), and the rebuild is ~10 ms of CPU that only runs when a
 * parameter actually changes.
 */

/* --------------------------------------------------------------- the defaults */
/*
 * Calibration, and how to falsify it
 * ----------------------------------
 * Provenance rule for this block: a number appears here only if it came out of
 * `tools/metrics.py` (or the mask script it wraps) run on a PNG written by
 * `tools/capture.mjs`, or out of `ref/keyframes/*.png` directly. Nothing here is derived
 * by pushing reference frames backwards through the transform. An earlier version of
 * this file was calibrated by inverting AgX on `ref/keyframes/*.png` and optimising the
 * grade against the result - that makes the *reference clip* the input distribution and
 * guarantees a perfect-looking report about a build that does not exist.
 *
 * Input distribution (the grade's actual input):
 *
 *     CFG='{"gradeEnabled":false}' node tools/_cap_cfg.mjs --all \
 *         --only time,lighting,sky,pipeline --outdir shots/ungraded_sky --settle 40
 *
 * Masked-clear-sky rule, applied identically to render and reference: OpenCV HSV
 * hue 95..125, s >= 55, v >= 40.
 *
 * The confound, and the one pose that is free of it
 * -------------------------------------------------
 * Terrain, rocks and structures are stubs, so at eight of the nine scored poses the
 * render's sky mask covers two to four times the area of the reference's - our sky
 * fills the frame where the reference has beach and rock. A sky mask on a
 * mostly-beach frame samples only the near-horizon sky, which in the *reference* is
 * itself 10 lab_b units less blue than its own zenith (kf_00600, by elevation band:
 * -30.9 at the top, -19.2 just above the horizon). So the naive all-pose mean compares
 * our zenith against their horizon and reports a colour error that is really a
 * geometry deficit. That is worth 4 of the 6.6 lab_b units it appears to show:
 *
 *      masked sky, 6 poses, mean       lab_a   lab_b     sat     lum     G/R
 *      render (ungraded)               +4.68  -30.53   121.5   116.5   1.314
 *      reference keyframes             +2.74  -23.92   106.3   112.3   1.257
 *      naive delta                     +1.93   -6.61   +15.2    +4.2  +0.057
 *
 * `ref_00600` is the exception: the camera looks up, the reference frame is 67.8% sky
 * and ours was 73.4%, so the two masks sample the same part of the sky and the
 * comparison is honest. It is the calibration anchor.
 *
 * Why the white-balance knob ships at zero
 * ----------------------------------------
 * It was fitted, it worked, and then the thing it was correcting inverted underneath it.
 * Both states are recorded here because the pair is the argument.
 *
 *      anchor: ref_00600 masked sky vs kf_00600     lab_a   lab_b     sat     lum    G/R
 *      reference                                    +4.78  -29.44   132.1    95.7  1.383
 *      render, sky.js at the previous review        +6.04  -32.00   135.9   103.5  1.370
 *          -> 2.6 lab_b too blue. +12 mired of Bradford CAT lands it at
 *             +5.21 / -29.64 / 129.7, i.e. lab_b to within 0.2 of the reference.
 *      render, sky.js rev 2 (same day)              +3.93  -21.01    80.3   124.2  1.123
 *          -> 8.4 lab_b too *little* blue, 52 saturation points flat, 28 luma hot.
 *      render, sky.js rev 3 (this build)            +4.18  -23.50    98.6   108.6  1.186
 *          -> 5.9 lab_b too little blue, 33 saturation points flat.
 *
 * `sky.js` was rewritten twice in the space of this task (it now carries the warm
 * near-horizon Mie term it was missing, and overshot on the way past). The same +12
 * mired that was right at the top of the file's history is pushing the wrong way on
 * every one of those numbers by the bottom of it, and correcting rev 3's error from here
 * would take roughly -35 mired plus a 1.3x saturation boost: a heavy blue cast on the
 * neutral axis, in a frame with no neutral content to reveal it, to hide a defect in
 * another module. That is precisely the trade this file has now been burned by twice, in
 * both directions. So the CAT ships at identity, and the residual is recorded in
 * `CALIBRATION.measured` where it can be attributed correctly instead of absorbed here.
 *
 * By elevation band (rev 2 numbers - the shape has not changed in rev 3), so it is clear
 * this is not a mask artefact:
 *
 *      band            render lab_b / sat / lum    kf_00600 lab_b / sat / lum
 *      zenith            -21.71 /  88.9 / 109.1      -30.90 / 147.1 /  82.4
 *      upper mid         -21.69 /  84.0 / 118.7      -31.65 / 135.9 /  94.2
 *      lower mid         -20.98 /  76.2 / 132.4      -30.49 / 130.2 / 101.0
 *      near horizon      -16.91 /  62.8 / 142.1      -19.23 /  91.0 / 109.3
 *
 * The deficit is uniform in elevation and large in magnitude; it is a scattering
 * problem, not a white-point problem, and it belongs in `src/world/sky.js`.
 *
 * The knob and its calibration are left in place, because the fix is one number once the
 * sky settles: capture ungraded (CALIBRATION.captureCmd), measure the masked sky at
 * `ref_00600` against `kf_00600`, and dial `gradeTempShift` at roughly +0.20 lab_b per
 * mired until it closes - but ONLY if the residual is a constant offset across the
 * elevation bands above, because that is what makes it a white point rather than a
 * scattering curve. If instead the sky is short of saturation at every elevation, as it
 * is today, the grade is the wrong file.
 *
 * The gamma that used to live here
 * --------------------------------
 * A previous version shipped `gradeGamma [0.9413, 1.0391, 1.0026]` to correct a measured
 * sky G/R of 1.138 against a reference 1.241. Reverted to [1,1,1]:
 *
 *   - it is chasing a number that has since moved twice (1.370 last build, 1.123 this
 *     one, against a reference 1.383);
 *   - per-channel gamma in display space peaks on the NEUTRAL axis. Measured by pushing
 *     a ramp through `gradeJS`: input 128 came out (122.61, 131.36, 128.23), R-G = -8.75
 *     codes, about lab_a -5.5, decaying to zero at both endpoints. The reference's
 *     neutrals are warm, not green - kf_00000 whole-frame lab_a +2.48 / lab_b +4.67, the
 *     `weapon` ROI lab_a +1.89 - so every rock, plate and gun barrel would have read
 *     ~7 lab_a units green the moment those modules landed;
 *   - and a display-space per-channel curve cannot tell "the sky is magenta" from
 *     "everything is magenta". With no scene content to disambiguate, that is a coin
 *     flip baked into every frame.
 *
 * If a global chromatic trim is wanted, `gradeTempShift` is the knob: a 3x3 on linear
 * tristimulus is hue-selective, so at +12 mired it moves the masked sky by 2.4 lab_b
 * while moving midgrey R-G by 2.7 codes - an order of magnitude less, and in the warm
 * direction the reference's neutrals already want, not the green one.
 *
 * LUT fidelity
 * ------------
 * The 32^3 lattice costs 0.15 code values RMS against the exact transform over the whole
 * cube with the CAT at +12 mired (worst case 3.4 codes, at saturated yellow-green,
 * RGB 203,255,21, which nothing in this scene produces). Over the sky's own gamut it is
 * 0.003 RMS / 0.025 worst case, two orders of magnitude below the dither floor. N=48
 * halves it and is not worth the rebuild time.
 *
 * Content-bound statistics, deliberately left alone
 * -------------------------------------------------
 * Terrain, rocks, water and the viewmodel are stubs; the frame is sky over a flat
 * placeholder plane. So the whole-frame signature is dominated by content that does not
 * exist and fitting the grade to it would repeat the original mistake in a third
 * direction. Measured on `diag_sky`, this build, against the clip average:
 *
 *   - lum_std 33.3 against 52.3. The missing 19 units are the missing dark rock and
 *     bright cloud - p01 is 63 because nothing in frame is dark. A contrast trim would
 *     buy the statistic by crushing the sky, which is the only region present.
 *     `gradeContrast 1.000` is a measurement.
 *   - whole-frame lab_b -15.2 against +1.4. kf_00600, the one reference frame whose
 *     composition is also mostly sky, is itself at -21.7. The +1.4 comes from sand.
 *     `gradeCdl*` all neutral.
 *   - sat_mean 63.9 against 83.9, and the sky itself is 52 saturation points short of
 *     the reference's. A global saturation boost would move both numbers toward target
 *     today and blow the sky out the moment `sky.js` is fixed at source.
 *     `gradeSaturation 1.000`.
 *
 * (`gradePivot` is 0.4626, the sRGB code of scene-linear 0.18 - AgX's middle grey - so
 * that when the contrast knob is finally dialled it rotates about middle grey.)
 */
const DEFAULTS = {
  gradeEnabled: true,

  // Bradford CAT. Off. This is a measurement, not a default-by-neglect - see
  // "Why the white-balance knob ships at zero" above, and re-run the two commands in
  // CALIBRATION before changing it.
  gradeTempShift: 0.0,
  gradeTintShift: 0.0,

  gradeCdlSlope: [1.000, 1.000, 1.000],
  gradeCdlOffset: [0.000, 0.000, 0.000],
  gradeCdlPower: [1.000, 1.000, 1.000],

  gradeLift: [0.000, 0.000, 0.000],
  gradeGamma: [1.000, 1.000, 1.000],
  gradeGain: [1.000, 1.000, 1.000],

  // 1.000 is a measurement, not a default-by-neglect. See the note above.
  gradeContrast: 1.000,
  gradePivot: 0.4626,          // sRGB code of scene-linear 0.18 - AgX's middle grey
  gradeSaturation: 1.000,

  gradeShadowTint: [0.0000, 0.0000, 0.0000],
  gradeHighlightTint: [0.0000, 0.0000, 0.0000],
  gradeSplitPivot: 0.450,

  // Both tails belong to AgX. Off, not nearly-off. See the note above.
  gradeBlackFloor: 0.0000,
  gradeToeStart: 0.0000,
  gradeWhiteCeil: 1.0000,
  gradeShoulderStart: 1.0000,

  gradeDither: 1.0,
  gradeLutSize: 32,
};

/**
 * Provenance for the numbers above. This exists so the claim "measured" can be checked
 * rather than believed: every statistic here came out of `tools/metrics.py` run on a PNG
 * written by `tools/capture.mjs`, and the command that produced each PNG is named.
 */
export const CALIBRATION = {
  method: 'capture',
  /** The one scored pose whose sky mask area matches its keyframe's, so the masked
   *  comparison measures colour and not the missing terrain. See the note above. */
  anchorPose: 'ref_00600',
  captureCmd: "CFG='{\"gradeEnabled\":false}' node tools/_cap_cfg.mjs --pose ref_00600 --only time,lighting,sky,pipeline --out shots/ungraded_600.png --settle 40",
  verifyCmd: 'node tools/capture.mjs --pose ref_00600 --only time,lighting,sky,pipeline --out shots/graded_600.png --settle 40',
  inputs: 'shots/ungraded_600.png (tonemap output, this pass bypassed)',
  targets: 'ref/keyframes/kf_00600.png',
  skyMask: 'OpenCV HSV hue 95..125, s>=55, v>=40, applied identically to both sides',
  /**
   * before = ungraded capture, after = graded capture, target = the anchor keyframe.
   * The grade is at chroma identity this build, so before ~= after by construction (the
   * residual difference is the 32^3 lattice, which is <= 1 code on 1.4% of pixels,
   * verified by capturing both arms with the dither off and differencing). The gap to
   * `target` is `src/world/sky.js`'s and is recorded here so it cannot be quietly
   * attributed to this pass; see "Why the white-balance knob ships at zero".
   */
  measured: {
    skyLabA: { before: 4.18, after: 4.24, target: 4.78 },
    skyLabB: { before: -23.50, after: -23.62, target: -29.44 },
    skySat: { before: 98.60, after: 99.28, target: 132.09 },
    frameMax: { before: 255, after: 255, target: 255 },
    /** diag_sky, blue channel, column x=1500, top 800 rows. The one this pass owns. */
    bandingMeanRun: { before: 11.94, after: 1.57, target: 1.37 },
  },
};

/**
 * Regression gate. Call with the stats measured on a *captured* frame; it refuses
 * numbers that did not come from a capture and fails on drift.
 *
 * Exposed on `globalThis.__HALO_GRADE__` at init so the capture harness can call it on
 * the stats it already computes without importing anything:
 *
 *     const v = window.__HALO_GRADE__.verifyCalibration({ source: 'capture', ...stats });
 *     if (!v.ok) process.exitCode = 1;         // hard fail
 *     for (const w of v.sceneFailures) warn(w);  // attributed elsewhere, do not gate
 *
 * The split matters. Two of the four checks measure this pass and only this pass, and a
 * build that fails them is broken - that is the case that shipped twice. The other two
 * measure the sky's radiance through this pass; the grade is at chroma identity, so a
 * failure there is `src/world/sky.js`'s and gating the whole capture run on it would
 * train everyone to ignore the gate.
 *
 * @param {object} s  { source, skyLabA, skyLabB, max, bandingMeanRun }
 *                    `source` must be 'capture'.
 * @returns {{ok:boolean, failures:string[], sceneFailures:string[]}}
 */
export function verifyCalibration(s = {}) {
  const f = [], sf = [];
  if (s.source !== 'capture') {
    f.push('grade statistics must come from a capture of the shipping pipeline; got source=' +
      JSON.stringify(s.source) + '. Numbers derived by pushing ref/keyframes through the LUT ' +
      'are not evidence.');
    return { ok: false, failures: f, sceneFailures: sf };
  }

  /* --- owned by this pass: hard failures ---------------------------------- */

  // The reference sits at 1.08-1.37 px mean plateau run on a smooth sky (blue channel,
  // column x=1500, top 800 rows). 3.0 is still visible as contouring on a gradient this
  // clean, so the gate is 2.0. Undithered, this render measured 11.94.
  if (typeof s.bandingMeanRun === 'number' && s.bandingMeanRun > 2.0) {
    f.push('banding mean plateau run ' + s.bandingMeanRun.toFixed(2) +
      ' px > 2.0 - the dither is not reaching the backbuffer');
  }
  // A display transform that cannot emit white has a bug in it, and this chain has
  // shipped two of them (a shoulder that stopped at 241, a CAT normalisation that
  // stopped at 251). The reference reaches 254-255 on 9 of 9 scored keyframes.
  if (typeof s.max === 'number' && s.max < 250) {
    f.push('frame max ' + s.max + ': the chain must be able to reach white (>=250)');
  }

  /* --- measured through this pass, owned by the scene: warnings ------------ */

  const chk = (name, v, target, tol) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { sf.push(name + ': missing'); return; }
    if (Math.abs(v - target) > tol) {
      sf.push(name + ': ' + v.toFixed(2) + ' vs target ' + target + ' (tol ' + tol + '). ' +
        'The grade is at chroma identity; this is src/world/sky.js.');
    }
  };
  // Anchored on ref_00600 vs kf_00600 - the one scored pose whose sky mask area matches
  // its keyframe's. Re-anchor when terrain and rocks land and the other eight poses stop
  // over-reporting sky.
  chk('sky lab_a', s.skyLabA, 4.78, 1.5);
  chk('sky lab_b', s.skyLabB, -29.44, 2.0);

  return { ok: f.length === 0, failures: f, sceneFailures: sf };
}

const LUMA = [0.2126, 0.7152, 0.0722];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-6));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------- white balance (CAT) */
/*
 * A chromatic adaptation transform is the principled way to say "the whole image is
 * lit slightly too blue". It is a 3x3 on linear tristimulus values, so unlike a
 * per-channel gamma it is hue-selective: it moves a saturated blue several lab units
 * and the neutral axis by a fraction of one, in the same direction. That is the
 * difference between "the sky is too blue" and "everything is too blue", and it is why
 * this and not `gradeGamma` is the knob for a global cast.
 *
 * Bradford is used rather than von Kries/XYZ-scaling because its sharpened cone space
 * is the one that actually predicts corresponding colours for daylight shifts.
 */
const M_RGB_TO_XYZ = [
  [0.4123908, 0.3575843, 0.1804808],
  [0.2126390, 0.7151687, 0.0721923],
  [0.0193308, 0.1191948, 0.9505322],
];
const M_XYZ_TO_RGB = [
  [3.2409699, -1.5373832, -0.4986108],
  [-0.9692436, 1.8759675, 0.0415551],
  [0.0556301, -0.2039770, 1.0569715],
];
const M_BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const M_BRADFORD_INV = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
];

const D65_KELVIN = 6503.6;

function mul3(m, c) {
  return [
    m[0][0] * c[0] + m[0][1] * c[1] + m[0][2] * c[2],
    m[1][0] * c[0] + m[1][1] * c[1] + m[1][2] * c[2],
    m[2][0] * c[0] + m[2][1] * c[1] + m[2][2] * c[2],
  ];
}
function mulMM(a, b) {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
  }
  return o;
}

/**
 * Daylight-locus chromaticity for a correlated colour temperature (Kim et al., valid
 * 4000-25000 K, which covers everything a temp trim will ever ask for).
 *
 * Both the source and the destination white are evaluated with this same formula, so
 * its ~0.005 offset from the tabulated D65 chromaticity cancels exactly and a shift of
 * zero mireds produces the identity matrix to floating-point precision.
 */
function cctToXy(kelvin) {
  const t = Math.min(Math.max(kelvin, 4000), 25000);
  const x = -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.240390;
  const y = 3.0817580 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const xyToXYZ = (x, y) => [x / Math.max(y, 1e-6), 1, (1 - x - y) / Math.max(y, 1e-6)];

/**
 * Linear-sRGB white-balance matrix for a shift of `mired` mireds (positive = warmer)
 * and `tint` in xy-y units (positive = magenta, negative = green).
 *
 * The result is renormalised to preserve the Rec.709 luminance of display white. A CAT
 * on its own changes the luminance of everything it touches - warming drops blue, which
 * drops luma, which reads as an exposure change rather than a colour change. Two
 * normalisations were tried:
 *
 *   - scale so no channel of white exceeds 1: nothing clips, but white lands on luma
 *     0.9835 = code 251 and the whole frame loses 1.6 units of lum_mean. The reference
 *     reaches 254-255 on 9 of 9 scored keyframes and a display transform that cannot
 *     emit white is exactly the defect a previous shoulder was rejected for.
 *   - scale so the luma of white is 1 (this one): white leaves as
 *     (1.0080, 1.0004, 0.9827) and clips to (1, 1, 0.9827), luma 0.9988 = code 255.
 *     The clip touches red only where red is already above code 253, i.e. the sun disc
 *     and specular cores, and costs at most 0.8% of a channel there.
 */
export function whiteBalanceMatrix(mired = 0, tint = 0) {
  if (!mired && !tint) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const srcK = D65_KELVIN;
  // mireds = 1e6 / K, and *adding* mireds lowers the temperature, i.e. warms the target
  // white, i.e. warms the image.
  const dstK = 1e6 / (1e6 / srcK + mired);
  const [sx, sy] = cctToXy(srcK);
  let [dx, dy] = cctToXy(dstK);
  dy += tint;

  const ws = mul3(M_BRADFORD, xyToXYZ(sx, sy));
  const wd = mul3(M_BRADFORD, xyToXYZ(dx, dy));
  const D = [[wd[0] / ws[0], 0, 0], [0, wd[1] / ws[1], 0], [0, 0, wd[2] / ws[2]]];
  const catXYZ = mulMM(M_BRADFORD_INV, mulMM(D, M_BRADFORD));
  let M = mulMM(M_XYZ_TO_RGB, mulMM(catXYZ, M_RGB_TO_XYZ));

  const w = mul3(M, [1, 1, 1]);
  const k = 1 / Math.max(LUMA[0] * w[0] + LUMA[1] * w[1] + LUMA[2] * w[2], 1e-6);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] *= k;
  return M;
}

/* sRGB EOTF / OETF. The CAT is defined on linear tristimulus, so the display values
 * this pass works in have to be decoded and re-encoded around it. */
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * One exponential knee, C1-continuous with the identity at the knee point.
 * `lo < t`: below `t` the curve bends over toward `lo` and never reaches it.
 *
 * Note the asymptote: `toe(0) = lo + (t - lo)/e`. With t = 0 this is the identity, which
 * is the default - AgX already owns the shadow roll-off and a second one only lifts
 * black off code 0.
 */
function toe(x, lo, t) {
  if (x >= t || t <= lo) return x;
  const d = t - lo;
  return lo + d * Math.exp(-(t - x) / d);
}
/** Mirror of `toe`. `shoulder(1) = top - (top - s)/e`, so s must be ~1 for white to survive. */
function shoulder(x, top, s) {
  if (x <= s || top <= s) return x;
  const d = top - s;
  return top - d * Math.exp(-(x - s) / d);
}

/**
 * The full grade, in display space. Input and output are sRGB-encoded [0,1].
 * This is the single source of truth: the GPU only ever sees its baked output.
 * @param {number[]} rgb
 * @param {object}   P  a fully-populated parameter set (see DEFAULTS)
 * @param {number[][]} [wb]  precomputed whiteBalanceMatrix(P), for the LUT bake
 */
export function gradeJS(rgb, P, wb = null) {
  let c = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];

  // 1. white balance, on linearised values (a CAT is not defined on encoded ones).
  const M = wb || whiteBalanceMatrix(P.gradeTempShift, P.gradeTintShift);
  if (M !== null && (M[0][0] !== 1 || M[0][1] !== 0 || M[1][1] !== 1 || M[2][2] !== 1)) {
    const lin = mul3(M, [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])]);
    c = [linearToSrgb(clamp01(lin[0])), linearToSrgb(clamp01(lin[1])), linearToSrgb(clamp01(lin[2]))];
  }

  // 2. ASC CDL: (x * slope + offset) ^ power
  for (let i = 0; i < 3; i++) {
    const v = c[i] * P.gradeCdlSlope[i] + P.gradeCdlOffset[i];
    c[i] = Math.pow(Math.max(v, 0), P.gradeCdlPower[i]);
  }

  // 3. lift / gamma / gain. Lift pivots on white, gain pivots on black, so the two
  //    are independent and a colourist can reach for either without undoing the other.
  for (let i = 0; i < 3; i++) {
    const L = P.gradeLift[i];
    let v = (c[i] + L * (1 - c[i])) * P.gradeGain[i];
    c[i] = Math.pow(Math.max(v, 0), 1 / Math.max(P.gradeGamma[i], 1e-3));
  }

  // 4. contrast as a power law about the pivot - monotone, and it degrades gracefully
  //    instead of clipping the way a linear (x-p)*k + p does.
  if (P.gradeContrast !== 1) {
    const p = Math.max(P.gradePivot, 1e-4);
    for (let i = 0; i < 3; i++) c[i] = p * Math.pow(Math.max(c[i], 1e-6) / p, P.gradeContrast);
  }

  // 5. saturation about Rec.709 luma
  if (P.gradeSaturation !== 1) {
    const l = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
    for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * P.gradeSaturation;
  }

  // 6. split tone. Weighted so the two masks sum to <= 1 and vanish at the pivot.
  {
    const l = clamp01(LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]);
    const sw = 1 - smoothstep(0, P.gradeSplitPivot, l);
    const hw = smoothstep(P.gradeSplitPivot, 1, l);
    for (let i = 0; i < 3; i++) c[i] += P.gradeShadowTint[i] * sw + P.gradeHighlightTint[i] * hw;
  }

  // 7. soft roll-off at both ends
  for (let i = 0; i < 3; i++) {
    let v = c[i];
    v = toe(v, P.gradeBlackFloor, P.gradeToeStart);
    v = shoulder(v, P.gradeWhiteCeil, P.gradeShoulderStart);
    c[i] = clamp01(v);
  }
  return c;
}

/**
 * Bake the grade into an N^3 RGBA float lattice, laid out for a sampler3D
 * (x fastest, then y, then z).
 */
export function buildGradeLut(P, N = 32) {
  const data = new Float32Array(N * N * N * 4);
  const wb = whiteBalanceMatrix(P.gradeTempShift, P.gradeTintShift);
  const inv = 1 / (N - 1);
  let o = 0;
  for (let z = 0; z < N; z++) {
    const b = z * inv;
    for (let y = 0; y < N; y++) {
      const g = y * inv;
      for (let x = 0; x < N; x++) {
        const c = gradeJS([x * inv, g, b], P, wb);
        data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2]; data[o++] = 1;
      }
    }
  }
  return data;
}

/** Merge ctx.config over DEFAULTS, so a partially-poked config is still complete. */
export function resolveParams(config = {}) {
  const P = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = config[k];
    const d = DEFAULTS[k];
    if (v === undefined) P[k] = Array.isArray(d) ? d.slice() : d;
    else P[k] = Array.isArray(d) ? [v[0] ?? d[0], v[1] ?? d[1], v[2] ?? d[2]] : v;
  }
  return P;
}

export { DEFAULTS as GRADE_DEFAULTS };

/* --------------------------------------------------------- change detection */
/*
 * An older version called resolveParams() and JSON.stringify() on the result every
 * frame - 20 keys, 8 array allocations and a full serialisation, before the bypass
 * check, purely to discover that nothing had changed. This flattens the same state into
 * a preallocated Float32Array and compares 35 floats. No allocation, no GC pressure,
 * and it still needs no cooperation from whoever writes the config.
 */
const SCALAR_KEYS = ['gradeTempShift', 'gradeTintShift',
  'gradeContrast', 'gradePivot', 'gradeSaturation', 'gradeSplitPivot',
  'gradeBlackFloor', 'gradeToeStart', 'gradeWhiteCeil', 'gradeShoulderStart', 'gradeLutSize'];
const VEC_KEYS = ['gradeCdlSlope', 'gradeCdlOffset', 'gradeCdlPower',
  'gradeLift', 'gradeGamma', 'gradeGain', 'gradeShadowTint', 'gradeHighlightTint'];
const STATE_LEN = SCALAR_KEYS.length + VEC_KEYS.length * 3;   // 11 + 24 = 35

function flatten(config, out) {
  let i = 0;
  for (const k of SCALAR_KEYS) {
    const d = DEFAULTS[k];
    const v = config[k];
    out[i++] = v === undefined ? d : v;
  }
  for (const k of VEC_KEYS) {
    const d = DEFAULTS[k];
    const v = config[k];
    if (v === undefined) { out[i++] = d[0]; out[i++] = d[1]; out[i++] = d[2]; }
    else { out[i++] = v[0] ?? d[0]; out[i++] = v[1] ?? d[1]; out[i++] = v[2] ?? d[2]; }
  }
  return i;
}

/* ------------------------------------------------------------------ the shader */
/* NO BACKTICKS BELOW THIS LINE UNTIL THE LITERAL CLOSES. See "EDITING THIS FILE". */

const FRAG = /* glsl */`
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D tSrc;
uniform sampler3D tLut;
uniform float uLutSize;
uniform float uBypass;    // >0.5 = straight copy
out vec4 oCol;

/*
 * Tetrahedral interpolation. Trilinear would be a single hardware tap, but it
 * interpolates across the cube diagonal and that shows up as a hue twist on smooth
 * gradients - exactly where a sky is, which is two thirds of this game's frame. The
 * tetrahedral decomposition only ever mixes four lattice points that lie in the same
 * simplex, so the neutral axis stays neutral and gradients stay clean. Four texelFetch
 * from a 512 KB volume is a cache hit every time; the cost difference is noise.
 */
vec3 lutTetra(vec3 c){
  float N = uLutSize;
  vec3 p = clamp(c, 0.0, 1.0) * (N - 1.0);
  vec3 base = floor(p);
  vec3 f = p - base;

  ivec3 hi = ivec3(int(N) - 1);
  ivec3 i0 = min(ivec3(base), hi);
  ivec3 i1 = min(i0 + ivec3(1), hi);

  vec3 c000 = texelFetch(tLut, i0, 0).rgb;
  vec3 c111 = texelFetch(tLut, i1, 0).rgb;

  if (f.r > f.g) {
    if (f.g > f.b) {          // r > g > b
      vec3 a = texelFetch(tLut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
      return (1.0 - f.r) * c000 + (f.r - f.g) * a + (f.g - f.b) * b + f.b * c111;
    } else if (f.r > f.b) {   // r > b > g
      vec3 a = texelFetch(tLut, ivec3(i1.x, i0.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
      return (1.0 - f.r) * c000 + (f.r - f.b) * a + (f.b - f.g) * b + f.g * c111;
    } else {                  // b > r > g
      vec3 a = texelFetch(tLut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i0.y, i1.z), 0).rgb;
      return (1.0 - f.b) * c000 + (f.b - f.r) * a + (f.r - f.g) * b + f.g * c111;
    }
  } else {
    if (f.b > f.g) {          // b > g > r
      vec3 a = texelFetch(tLut, ivec3(i0.x, i0.y, i1.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i0.x, i1.y, i1.z), 0).rgb;
      return (1.0 - f.b) * c000 + (f.b - f.g) * a + (f.g - f.r) * b + f.r * c111;
    } else if (f.b > f.r) {   // g > b > r
      vec3 a = texelFetch(tLut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i0.x, i1.y, i1.z), 0).rgb;
      return (1.0 - f.g) * c000 + (f.g - f.b) * a + (f.b - f.r) * b + f.r * c111;
    } else {                  // g > r > b
      vec3 a = texelFetch(tLut, ivec3(i0.x, i1.y, i0.z), 0).rgb;
      vec3 b = texelFetch(tLut, ivec3(i1.x, i1.y, i0.z), 0).rgb;
      return (1.0 - f.g) * c000 + (f.g - f.r) * a + (f.r - f.b) * b + f.b * c111;
    }
  }
}

void main(){
  vec3 src = texture(tSrc, vUv).rgb;
  vec3 c = uBypass > 0.5 ? clamp(src, 0.0, 1.0) : lutTetra(src);
  oCol = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/* -------------------------------------------------- the terminal dither pass */

const DITHER_FRAG = /* glsl */`
in vec2 vUv;
uniform sampler2D tSrc;
uniform float uAmount;    // TPDF amplitude in LSBs (peak)
out vec4 oCol;

/*
 * PCG hash. An integer hash, not a trig/fract one, for two reasons: fract(sin(...))
 * hashes are precision-dependent and drift between drivers, which breaks byte-identical
 * capture; and interleaved-gradient noise, which is the usual cheap choice here, is
 * strongly *structured* - it is designed to be, because it is meant to be averaged over
 * a temporal sequence. Measured on a diag_sky capture, the IGN version of this pass left
 * an autocorrelation of +0.42 at a (3,-3) pixel offset and +0.32 at (0,-2), which is a
 * visible diagonal weave once the sky is high-pass amplified. Dither wants the opposite
 * property: no correlation at any offset, so the quantisation error it decorrelates
 * really is white. This hash measures +/-0.03 at every off-centre offset.
 *
 * Deterministic in gl_FragCoord alone, so two captures of the same frame stay
 * byte-identical - a temporal dither would break the measurement loop for a benefit no
 * still frame can show.
 */
uint pcg(uint v){
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

void main(){
  vec3 c = texture(tSrc, vUv).rgb;
  /* Two independent uniforms subtracted give a symmetric triangular distribution on
   * [-1,1]; scaled to +/-1 LSB that is the textbook TPDF dither, which makes the 8-bit
   * quantisation error white and signal-independent - i.e. it removes banding rather
   * than hiding it. The two uniforms come from separately seeded hashes rather than from
   * two halves of one, so their independence does not rest on the avalanche quality of a
   * single 32-bit word. */
  if (uAmount > 0.0) {
    uvec2 q = uvec2(gl_FragCoord.xy);
    float r1 = float(pcg(q.x ^ pcg(q.y))) * (1.0 / 4294967295.0);
    float r2 = float(pcg((q.x ^ pcg(q.y ^ 0x9E3779B9u)) + 0x85EBCA6Bu)) * (1.0 / 4294967295.0);
    c += ((r1 - r2) * uAmount) / 255.0;
  }
  oCol = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/* NO BACKTICKS ABOVE THIS LINE INSIDE A TEMPLATE LITERAL. */

/**
 * The terminal 8-bit output stage.
 *
 * It exists as its own pass, appended after everything else, because dither is only
 * dither if nothing modifies the signal between the noise injection and the
 * quantisation. `sharpen` (a high-pass) and `grain` (additive noise) both sit between
 * `grade` and the backbuffer, so dithering inside `grade` is dithering the wrong signal.
 *
 * `writesBackbuffer` is used as an assertion rather than a gate. Gating on it is how the
 * dither became dead code the first time; if something ever does get registered after
 * this pass, the right response is a loud warning and to keep dithering, not to go
 * quiet. Every path out of this pipeline ends at an 8-bit canvas.
 */
function makeDither() {
  const p = new Pass('dither');
  p.providesDither = true;
  let quad = null, mat = null, warned = false;

  p.init = () => {
    mat = fsMaterial(DITHER_FRAG, { tSrc: { value: null }, uAmount: { value: DEFAULTS.gradeDither } });
    quad = new FullScreenQuad(mat);
  };
  p.render = (ctx, pipe, out) => {
    if (!p.writesBackbuffer && !warned) {
      warned = true;
      console.warn('[dither] a pass was registered after the terminal dither stage. ' +
        'Dither must be the last thing before the 8-bit write; move it or fold it into ' +
        'whichever pass is now last.');
    }
    mat.uniforms.tSrc.value = pipe.read.texture;
    mat.uniforms.uAmount.value = Math.max(0, ctx.config.gradeDither ?? DEFAULTS.gradeDither);
    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };
  p.setSize = () => {};
  p.dispose = () => quad?.dispose();
  return p;
}

/* -------------------------------------------------------------------- the pass */

export function create(opts = {}) {
  const p = new Pass('grade');
  let quad = null, mat = null, lutTex = null, lutN = 0;
  const state = new Float32Array(STATE_LEN);
  const probe = new Float32Array(STATE_LEN);
  let dirty = true, spawned = false;

  function rebuild(P) {
    const N = Math.max(8, Math.min(64, P.gradeLutSize | 0 || 32));
    const data = buildGradeLut(P, N);
    if (!lutTex || lutN !== N) {
      lutTex?.dispose();
      lutTex = new THREE.Data3DTexture(data, N, N, N);
      lutTex.format = THREE.RGBAFormat;
      lutTex.type = THREE.FloatType;
      // Nearest: the tetrahedral filter fetches lattice points directly and does its
      // own weighting. Hardware filtering here would fight it.
      lutTex.minFilter = THREE.NearestFilter;
      lutTex.magFilter = THREE.NearestFilter;
      lutTex.wrapS = lutTex.wrapT = lutTex.wrapR = THREE.ClampToEdgeWrapping;
      lutTex.colorSpace = THREE.NoColorSpace;
      lutTex.unpackAlignment = 1;
      lutN = N;
    } else {
      lutTex.image.data.set(data);
    }
    lutTex.needsUpdate = true;
    if (mat) {
      mat.uniforms.tLut.value = lutTex;
      mat.uniforms.uLutSize.value = N;
    }
  }

  /** Explicit invalidation for anyone who would rather not be polled. */
  p.markDirty = () => { dirty = true; };

  p.init = (ctx, pipe) => {
    // Publish every default into ctx.config so tuning really is a one-liner and a
    // debug UI can enumerate the whole grade without knowing about this file.
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (ctx.config[k] === undefined) ctx.config[k] = Array.isArray(v) ? v.slice() : v;
    }

    // Hand the regression gate to whoever measures, without an import.
    globalThis.__HALO_GRADE__ = { verifyCalibration, gradeJS, resolveParams, CALIBRATION };

    mat = fsMaterial(FRAG, {
      tSrc: { value: null },
      tLut: { value: null },
      uLutSize: { value: 32 },
      uBypass: { value: 0 },
    });
    quad = new FullScreenQuad(mat);

    flatten(ctx.config, state);
    rebuild(resolveParams(ctx.config));
    dirty = false;

    // Append the terminal dither stage, unless something else in the chain already owns
    // it. pipe.init() iterates its pass array by index, so a pass appended here is still
    // init'd and sized this frame - and lands last, which is the entire point.
    if (pipe && !spawned && !pipe.passes.some((q) => q !== p && q.providesDither)) {
      spawned = true;
      pipe.addPass(makeDither());
    }
  };

  p.render = (ctx, pipe, out) => {
    const c = ctx.config;

    // 35 float compares, no allocation. Only when something moved do we pay for
    // resolveParams + a LUT bake.
    flatten(c, probe);
    if (!dirty) {
      for (let i = 0; i < STATE_LEN; i++) if (probe[i] !== state[i]) { dirty = true; break; }
    }
    if (dirty) {
      state.set(probe);
      rebuild(resolveParams(c));
      dirty = false;
    }

    const u = mat.uniforms;
    u.tSrc.value = pipe.read.texture;
    u.uBypass.value = (c.gradeEnabled ?? DEFAULTS.gradeEnabled) ? 0 : 1;

    ctx.renderer.setRenderTarget(out);
    quad.render(ctx.renderer);
  };

  p.setSize = () => {};
  p.dispose = () => { quad?.dispose(); lutTex?.dispose(); };
  return p;
}
