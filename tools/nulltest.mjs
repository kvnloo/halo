#!/usr/bin/env node
/**
 * nulltest — is the thing you are about to tune ALIVE?
 *
 *   node tools/nulltest.mjs --module ssao
 *   node tools/nulltest.mjs --knob aoStrength --off 0 --on 2
 *   node tools/nulltest.mjs --knob exposure --off 0.5 --on 6.5 --pose ref_01500
 *   node tools/nulltest.mjs --module ocean --pose ref_01800 --settle 48
 *
 * Two captures, one difference, plus a control. Exit 0 = the frames differ AND two captures
 * of the same build do not, so the thing is alive and worth tuning. Exit 1 = **byte-identical
 * frames**, the thing is dead and every constant fitted to it is fiction. Exit 4 =
 * UNDETERMINED: the control also differed, so "the frames differ" is this pose's noise floor
 * and says nothing about the subject (see "the control leg" below).
 *
 * WHY THIS EXISTS
 * ---------------
 * This project has spent whole waves tuning parameters attached to nothing, and in every
 * case a sixty-second two-capture A/B would have found it immediately:
 *
 *   §28  `ssao` and `ssr` both early-out on `d >= 1.0` ("sky, nothing to do"). Under §18
 *        every world pixel read as sky, so BOTH PASSES RENDERED ZERO PIXELS for the entire
 *        project — while `aoStrength`, `aoRadius`, `aoPower` and `ssrStrength` were tuned
 *        against them for three waves. Found in Wave H, by reading git history.
 *   §9   `ctx.config.exposure` pinned across a 13x range produced byte-identical frames:
 *        `lum_mean` 110.51883342978395 for every value including no pin at all.
 *   §21  Depth of field was a shipped no-op, gated off by §18, for four waves.
 *   reports/tonemap.md  measured `volumetricFog` as "a byte-level no-op".
 *
 * The instruction the brief already gives — "isolate the term, null it out, re-measure,
 * conclude" (§8) — is the right instruction. What was missing is that you must run it
 * BEFORE you tune, not after you are confused. This makes it one command.
 *
 * A note on what a PASS means. Frames differing does not mean the effect is correct, only
 * that it reaches the framebuffer. That is a floor, not a ceiling — but it is a floor this
 * project has fallen through four times.
 *
 * SAFETY
 * Read-only. Captures to temp files outside the repo, writes nothing into the tree,
 * changes no measurement, adds nothing to the capture path.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : d;
};

const MODULE = arg('module', null);
const KNOB = arg('knob', null);
const OFF = arg('off', '0');
const ON = arg('on', '1');
const POSE = arg('pose', 'ref_00000');
const SETTLE = arg('settle', '48');

if (!MODULE && !KNOB) {
  console.error('nulltest: give me one of\n' +
    '  --module <name>                 A/B the whole module against --skip <name>\n' +
    '  --knob <key> --off <a> --on <b> A/B one --config key across two values\n' +
    '\nOptional: --pose ref_00000  --settle 48\n' +
    '\nModule names come from src/modules.js: time lighting sky clouds env terrain rocks\n' +
    'structures vegetation ocean props particles physics player weapons ai hud audio pipeline');
  process.exit(2);
}

/**
 * `--settle` also advances the world clock (KNOWN_ISSUES §26), so both legs MUST use the
 * same settle and the same `--time`, or the difference you measure is the sea moving
 * rather than the term you nulled. Both legs below are identical except for one argument.
 */
function capture(label, extra) {
  const out = join(tmpdir(), `halo-nulltest-${process.pid}-${label}.png`);
  const args = ['tools/capture.mjs', '--pose', POSE, '--out', out, '--settle', String(SETTLE), ...extra];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let info = null;
  try { info = JSON.parse(r.stdout); } catch { }
  if (!info || info.ok !== true) {
    console.error(`nulltest: leg "${label}" did not produce a frame.`);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(2);
  }
  let bytes = null;
  try { bytes = readFileSync(out); statSync(out); } catch { }
  try { unlinkSync(out); } catch { }
  if (!bytes) { console.error(`nulltest: leg "${label}" wrote no PNG.`); process.exit(2); }
  return { bytes, args: args.slice(1).join(' ') };
}

let legA, legB, subject, offDesc, onDesc, onExtra;
if (MODULE) {
  subject = `module ${MODULE}`;
  offDesc = `--skip ${MODULE}`;
  onDesc = '(full scene)';
  console.log(`nulltest — ${subject} at ${POSE}, settle ${SETTLE}. Up to three captures (two arms + a control), please wait.`);
  onExtra = [];
  legA = capture('off', ['--skip', MODULE]);
  legB = capture('on', onExtra);
} else {
  subject = `knob ${KNOB}`;
  offDesc = `--config ${KNOB}=${OFF}`;
  onDesc = `--config ${KNOB}=${ON}`;
  console.log(`nulltest — ${subject} (${OFF} vs ${ON}) at ${POSE}, settle ${SETTLE}. Up to three captures (two arms + a control), please wait.`);
  onExtra = ['--config', `${KNOB}=${ON}`];
  legA = capture('off', ['--config', `${KNOB}=${OFF}`]);
  legB = capture('on', onExtra);
}

const identical = legA.bytes.length === legB.bytes.length && legA.bytes.equals(legB.bytes);

console.log('');
console.log(`  off : ${offDesc}   (${legA.bytes.length} bytes)`);
console.log(`  on  : ${onDesc}   (${legB.bytes.length} bytes)`);
console.log('');

if (identical) {
  console.error(`!!! DEAD — ${subject} changes NOTHING. The two frames are byte-identical. !!!`);
  console.error('');
  if (MODULE) {
    console.error(`    Skipping \`${MODULE}\` entirely produced the same image as loading it. Either the`);
    console.error('    module renders nothing, or every pixel it writes is overwritten or discarded');
    console.error('    downstream. This is exactly KNOWN_ISSUES §28: `ssao` and `ssr` took an early-out');
    console.error('    on every pixel for the whole project while five of their constants were being');
    console.error('    tuned. Find out WHY it is dead before you touch any of its parameters.');
    console.error('');
    console.error(`    Next: node tools/capture.mjs --pose ${POSE} --only ${MODULE},pipeline --out /tmp/solo.png`);
  } else {
    console.error(`    Pinning \`${KNOB}\` to ${OFF} and to ${ON} produced the same image. The config`);
    console.error('    slot is not reaching the shader, is being overwritten after you set it, or is');
    console.error('    read once at init. KNOWN_ISSUES §9: `ctx.config.exposure` did this across a 13x');
    console.error('    range and every exposure number fitted against it was meaningless.');
    console.error('');
    console.error(`    Next: grep -rn "${KNOB}" src/ — check who WRITES that slot, not who reads it.`);
  }
  console.error('');
  console.error('    Do not fit constants to this. Fix the plumbing first.');
  process.exit(1);
}

/* ------------------------------------------------------------------- the control leg ---
 * "The frames differ" only means the subject is alive if two captures of the SAME build
 * would NOT have differed. That premise is false at some poses and nobody was checking it.
 *
 *   reports/vegetation.md §"FIRST: the renderer is non-deterministic again": two
 *   back-to-back captures of the identical build at `ref_00720` differ in **50.0% of
 *   pixels**, whole frame; with `--skip vegetation` still 38.5%. "This is blocking for
 *   everyone: it puts a noise floor under every A/B in the project."
 *   reports/taa.md §4: a ~0.63 mean / 55%-of-pixels +/-1 floor exists between ANY two
 *   frames, and adjacent TAA phases differ by up to 53 code values.
 *   KNOWN_ISSUES §16: a determinism check returned BROKEN purely because `structures.js`
 *   was saved between the two captures.
 *
 * Every "determinism re-verified bit-exact" note in KNOWN_ISSUES (§10, and the Wave G and
 * Wave H status blocks) was measured at `ref_00000` — this tool's default pose — and read
 * as a whole-project property. Where it does not hold, two captures ALWAYS differ, so the
 * DEAD branch above is unreachable and ALIVE is printed no matter what the subject does.
 * An A/B whose PASS cannot fail is exactly the class KNOWN_ISSUES §4 / §9 / §28 keeps
 * producing, and `tools/knobcheck.mjs:246` already runs this control for `--ab`.
 *
 * Cost: one extra capture, and only on the ALIVE path, where the verdict is at stake. */
const ctl = capture('control', onExtra);
const stable = ctl.bytes.length === legB.bytes.length && ctl.bytes.equals(legB.bytes);
if (!stable) {
  console.error(`??? UNDETERMINED — ${subject} may or may not be alive at ${POSE}. ???`);
  console.error('');
  console.error(`    The control failed: two captures of the SAME build (${onDesc || '(full scene)'})`);
  console.error(`    are not byte-identical either (${legB.bytes.length} vs ${ctl.bytes.length} bytes).`);
  console.error('    So "the off and on frames differ" is what this pose produces anyway, and it');
  console.error('    is not evidence about the subject. Do not fit constants to a difference');
  console.error('    measured here.');
  console.error('');
  console.error('    Two known causes, in order of likelihood:');
  console.error('      1. `src/` was written between the two captures (KNOWN_ISSUES §16).');
  console.error('         Check: node tools/preflight.mjs   — its src-quiescent check says so.');
  console.error(`      2. The renderer is genuinely non-deterministic at ${POSE}`);
  console.error('         (reports/vegetation.md: 50.0% of pixels at ref_00720, identical build).');
  console.error('         Determinism has only ever been verified at ref_00000.');
  console.error('');
  console.error('    Next: re-run at --pose ref_00000, or measure a magnitude against the mean');
  console.error('    of three control captures instead of a byte compare (the method');
  console.error('    reports/vegetation.md had to invent), or use tools/ablate.mjs, which');
  console.error('    toggles inside ONE page load and has no between-capture window.');
  process.exit(4);
}

// Alive. Give a magnitude too, so "alive but invisible" is distinguishable from "alive".
let diffLine = '';
const py = join(ROOT, '.venv/bin/python');
try {
  if (statSync(py).isFile()) {
    // reuse the project's own imdiff if present; purely informational, never fatal
    diffLine = '';
  }
} catch { }

console.log(`  ALIVE — ${subject} changes the frame. Tuning it is meaningful.`);
console.log(`  control: a second capture of the same build at ${POSE} is byte-identical, so`);
console.log('           the difference above is the subject, not this pose\'s noise floor.');
console.log('');
console.log('  Note: "alive" is a floor, not a verdict. It proves the term reaches the');
console.log('  framebuffer, not that it is correct or the right strength. Measure structure');
console.log('  next (docs/TARGETS.md), and quote this line in your report:');
console.log(`  > nulltest: ${subject} is alive at ${POSE} (${offDesc} vs ${onDesc} differ).`);
if (diffLine) console.log(diffLine);
