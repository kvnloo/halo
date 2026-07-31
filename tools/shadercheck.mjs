#!/usr/bin/env node
/**
 * shadercheck — the fourth integrity channel: a module that LOADS and whose shaders
 * do not COMPILE.
 *
 *   node tools/shadercheck.mjs                    # ~20 s, one cheap capture
 *   node tools/shadercheck.mjs --pose ref_01500
 *   node tools/shadercheck.mjs --settle 48        # match your real measurement
 *   node tools/shadercheck.mjs --json
 *
 * WHY THIS IS SEPARATE FROM preflight.mjs
 * ---------------------------------------
 * `tools/preflight.mjs` is deliberately CPU-only and ~3 s, so it can be run constantly.
 * This one needs a GPU and a real boot, so it is its own command: run it once before a
 * measurement you intend to publish, not on every loop iteration.
 *
 * WHAT IT CATCHES THAT NOTHING ELSE DOES
 * --------------------------------------
 * Four channels can report "this subsystem is not in the frame". Three are now gated:
 *
 *   __HALO_MISSING__         module failed to import      -> capture.mjs integrity gate
 *   stats.failedModules      module init() threw          -> capture.mjs integrity gate
 *   __HALO_MISSING_PASSES__  post pass failed to load     -> capture.mjs integrity gate
 *   GLSL compile / link      module fine, material dead   -> NOBODY
 *
 * The fourth is the one that cost the most. `reports/terrain.md` §1:
 *
 *     ERROR: 0:406: 'patch' : Illegal use of reserved word     MeshStandardMaterial
 *     ERROR: 0:418: 'patch' : Illegal use of reserved word     MeshDepthMaterial
 *     ERROR: 0:566: 'patch' : Illegal use of reserved word     ShaderMaterial
 *
 * All three terrain materials failed to link. `terrain.js` imported fine, `init()` threw
 * nothing, no pass was missing — every integrity channel said the scene was complete. The
 * "sand" in the showcase contact sheet `shots/preview/preview.png` was **the clear colour**.
 * That frame was captured, scored, committed (65da9df) and reviewed before anyone read the
 * browser console. Fixing it moved whole-frame `lum_mean` 98.87 -> 110.48 in one rename.
 *
 * Same failure, other subsystems: `reports/integration_waveE.md` §303-327 records three
 * `THREE.WebGLProgram: Shader Error ... VALIDATE_STATUS false`; KNOWN_ISSUES §16 lists GLSL
 * errors for `stepAt`, `lodAmp`, `oc_surface` and `oc_wave`; `reports/structures.md` notes
 * in passing that "`sky.js` failed to compile during one of my captures" — discovered by
 * luck, mid-measurement.
 *
 * The information was never missing. `capture.mjs` has always filed these into `warnings[]`
 * in its stdout JSON, and **no caller in this repo prints that array**. KNOWN_ISSUES §19
 * says so outright: "capture warnings do get swallowed into `warnings[]`". One agent solved
 * it privately — `reports/props.md` §80 describes a scratch tool that "re-runs if
 * `warnings[]` mentions `not loaded` or `Shader Error`" — and it never became shared
 * infrastructure, so every other agent kept flying blind.
 *
 * SAFETY
 * Read-only. Captures to a temp file outside the repo, writes nothing into the tree,
 * changes no measurement, and adds nothing to the capture path. Safe to run at any time.
 */
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const POSE = arg('pose', 'ref_00000');
const SETTLE = arg('settle', '8');
const asJson = argv.includes('--json');

/**
 * Patterns that mean "a shader did not compile or link".
 *
 * Deliberately narrow. A false positive here blocks a whole wave, which is worse than the
 * bug it catches. Every pattern below is quoted from a failure recorded in this repo, and
 * none of them can be produced by a healthy frame.
 */
const SHADER_FAIL = [
  [/THREE\.WebGLProgram:\s*Shader Error/i, 'reports/integration_waveE.md:303'],
  [/VALIDATE_STATUS\s+false/i, 'reports/integration_waveE.md:314'],
  [/\bERROR:\s*\d+:\d+:/, "reports/terrain.md:15 — the GLSL compiler's own message format"],
  [/Illegal use of reserved word/i, "reports/terrain.md — `patch` is reserved in ESSL 3.00"],
  [/Program Info Log/i, 'three.js prints this alongside a link failure'],
];

/**
 * Not a compile failure — the frame renders, but a pass sampled the target it was writing,
 * so the pixels are undefined. KNOWN_ISSUES §16 called this out as "a genuine item that
 * deserves follow-up independently of the churn" and nothing has watched for it since.
 */
const PIPELINE_FAIL = [
  [/Feedback loop formed between Framebuffer and active Texture/i, 'KNOWN_ISSUES §16'],
];

const out = join(tmpdir(), `halo-shadercheck-${process.pid}.png`);
if (!asJson) console.log(`shadercheck — booting ${POSE} at settle ${SETTLE} (needs a GPU, ~20 s)`);

const cap = spawnSync(process.execPath,
  ['tools/capture.mjs', '--pose', POSE, '--out', out, '--settle', String(SETTLE)],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
try { unlinkSync(out); } catch { }

// capture.mjs already prints its own integrity failure to stderr and exits non-zero.
// Pass it through verbatim rather than paraphrasing — that message is already good.
if (cap.stderr && !asJson) process.stderr.write(cap.stderr);

let info = null;
try { info = JSON.parse(cap.stdout); } catch { }

if (!info || info.ok !== true) {
  const msg = 'shadercheck: could not obtain a frame — capture.mjs did not return ok JSON.';
  if (asJson) console.log(JSON.stringify({ ok: false, reason: 'no-frame', captureStatus: cap.status }, null, 2));
  else console.error('\n' + msg + '\n  (its output is above; fix that first)');
  process.exit(2);
}

const warnings = info.warnings || [];
const hit = (table) => warnings.flatMap((w) => {
  const m = table.find(([re]) => re.test(w));
  return m ? [{ text: String(w).slice(0, 600), why: m[1] }] : [];
});
const shader = hit(SHADER_FAIL);
const pipeline = hit(PIPELINE_FAIL);

if (asJson) {
  console.log(JSON.stringify({
    ok: shader.length === 0 && pipeline.length === 0,
    pose: POSE, settle: Number(SETTLE),
    shaderFailures: shader, pipelineFailures: pipeline,
    warningCount: warnings.length,
    integrity: info.integrity ?? null,
  }, null, 2));
  process.exit(shader.length || pipeline.length ? 1 : 0);
}

if (shader.length) {
  console.error('');
  console.error('!!! SHADER COMPILE / LINK FAILURE — a subsystem is missing from this frame !!!');
  console.error('');
  for (const h of shader.slice(0, 12)) console.error('    ' + h.text.replace(/\n/g, '\n    '));
  console.error('');
  console.error('    A material that fails to link is invisible in exactly the way a file that');
  console.error('    fails to parse is invisible: no error in the image, just a scene quietly');
  console.error('    missing a thing. terrain.js shipped like this and the "sand" in the');
  console.error('    showcase sheet was the clear colour (reports/terrain.md §1).');
  console.error('');
  console.error('    DO NOT MEASURE THIS FRAME.');
  console.error('');
  console.error('    Most common cause here: an ESSL 3.00 reserved word used as a variable —');
  console.error('    patch, sample, filter, active, common, partition, resource, input, output.');
}

if (pipeline.length) {
  console.error('');
  console.error('!!! GL PIPELINE ERROR — the frame rendered, but its pixels are undefined !!!');
  for (const h of pipeline.slice(0, 6)) console.error('    ' + h.text + '   [' + h.why + ']');
}

if (shader.length || pipeline.length) {
  console.error(`\nshadercheck FAILED at ${POSE}. Numbers taken from this tree are not evidence.`);
  process.exit(1);
}

const s = info.stats || {};
console.log('');
console.log(`shadercheck ok — ${POSE}, settle ${SETTLE}, draws ${s.drawCalls ?? '?'}, tris ${s.triangles ?? s.tris ?? '?'}, programs ${s.programs ?? '?'}`);
console.log(`  ${warnings.length} console warning(s), none a shader or pipeline failure`);
console.log('  Quote this in your report so a reviewer knows the frame was real:');
console.log(`  > shadercheck ok at ${POSE} — every material linked, no GL pipeline errors.`);
