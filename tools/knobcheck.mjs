#!/usr/bin/env node
/**
 * knobcheck — does this `--config` knob reach anything?
 *
 * `--config k=v` is this project's primary experimental instrument. §18's before/after,
 * §8b's exposure sweep, §9's 13x pin, the fog A/B in `reports/fog.md`, the ocean arms in
 * `reports/ocean_waveH.md`, the `vmLegacyDepth=1` reproduction of the project's
 * highest-priority defect — all of them are `--config`. And `ctx.config` is a bare object:
 *
 *     api.setConfig = (k, v) => { engine.ctx.config[k] = v; ... };
 *
 * It accepts ANY key, stores it, returns it, and reports success. Nothing reads it. The
 * frame does not change. The arm and the baseline come out byte-identical — which is the
 * exact signature of "this pass is dead", so the conclusion drawn is about the renderer
 * instead of about the typo. There is no error anywhere in that chain.
 *
 * It has already happened, twice, in the documented record:
 *
 *   reports/depth.md §7  `tools/_ssprobe.mjs` called `H.setConfig(obj)` with an OBJECT
 *                        instead of `(k, v)`, setting `config['[object Object]'] =
 *                        undefined` and "returning quietly". **Every `_ssprobe --config`
 *                        invocation documented in `reports/screenspace.md` §8 measured the
 *                        default configuration.** A whole report's worth of A/Bs measured
 *                        nothing and read as measurements.
 *   reports/depth.md §7  "my first `--config vmLegacyDepth=1` run returned the *fixed*
 *                        numbers and looked like the A/B knob was dead."
 *   KNOWN_ISSUES §9      `exposure` pinned across a 13x range produced byte-identical
 *                        frames — the real thing, indistinguishable from the above.
 *
 * `tools/ablate.mjs` covers the other half of this space (a pass that is switched off with
 * `togglePass` and changes nothing). It never touches `ctx.config`, so nothing until now
 * checked the knobs.
 *
 * Three checks, all static and instant; a fourth that costs two captures.
 *
 *   node tools/knobcheck.mjs --config "aoRadius=0.6,fogDensity=0"   # validate before you spend a capture
 *   node tools/knobcheck.mjs --audit          # every --config recipe in tools/ docs/ reports/
 *   node tools/knobcheck.mjs --gates          # which pass switches the harness can and cannot set
 *   node tools/knobcheck.mjs --ab exposure=0.2,exposure=2.6 --pose ref_00000   # does it move the image?
 *
 * Read-only with respect to src/. Uses only flags capture.mjs already supports.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const OPT = {
  config: arg('config', null),
  ab: arg('ab', null),
  pose: arg('pose', 'ref_00000'),
  settle: arg('settle', '16'),
  audit: has('audit'),
  gates: has('gates'),
  json: has('json'),
};

/* ------------------------------------------------------ what does src/ actually read?
 * Deliberately over-inclusive. A checker that cries wolf is a checker agents learn to
 * ignore, and an ignored gate is the failure this whole exercise is about. A key counts as
 * "reachable" if it appears as a config property access, a destructured config field, or a
 * string literal compared against a key name (ocean.js and ssao.js dispatch their debug
 * knobs with `if (k === 'oceanFoam')` on the config event). Only a key that appears NOWHERE
 * is called out. */
function indexConfigKeys() {
  const read = new Map();
  const add = (k, f) => {
    if (!/^[A-Za-z_][\w]*$/.test(k)) return;
    if (!read.has(k)) read.set(k, new Set());
    read.get(k).add(f);
  };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = p.slice(ROOT.length + 1);
      const s = readFileSync(p, 'utf8');
      for (const m of s.matchAll(/config\s*\??\.\s*([A-Za-z_][\w]*)/g)) add(m[1], rel);
      for (const m of s.matchAll(/config\s*\??\.?\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) add(m[1], rel);
      for (const m of s.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[^;\n]*\bconfig\b/g))
        for (const part of m[1].split(',')) add(part.split(':')[0].split('=')[0].trim(), rel);
      // short aliases: `const c = ctx.config`
      const aliases = new Set();
      for (const m of s.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\bconfig\b[^;\n]*/g))
        if (m[1].length <= 4) aliases.add(m[1]);
      for (const a of aliases)
        for (const m of s.matchAll(new RegExp('\\b' + a + '\\.([A-Za-z_][\\w]*)', 'g'))) add(m[1], rel);
      // key-dispatch style: `if (k === 'oceanFoam')`, `case 'oceanFoam':`
      for (const m of s.matchAll(/(?:===?\s*|case\s+)['"]([A-Za-z_][\w]*)['"]/g)) add(m[1], rel);
    }
  };
  walk(join(ROOT, 'src'));
  return read;
}

/* ------------------------------------------------------------------ pass gate idioms
 * `capture.mjs --config k=v` runs `setConfig(k, isNaN(+v) ? v : +v)`. It can send the
 * NUMBER 0 and the STRING 'false'. It can never send the BOOLEAN false. So a gate written
 * `(c.k ?? cfg.k) !== false` is un-turn-off-able from the harness: `0 !== false` is true,
 * the pass stays on, and the A/B measures a frame that never changed. */
function discoverGates() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const s = readFileSync(p, 'utf8');
      for (const m of s.matchAll(/\bc(?:tx\.config|onfig)?\.\s*([a-zA-Z][a-zA-Z0-9]*Enabled)\s*\?\?/g)) {
        const tail = s.slice(m.index, m.index + 90);
        out.push({ key: m[1], file: p.slice(ROOT.length + 1), settable: !/!==\s*false/.test(tail) });
      }
    }
  };
  walk(join(ROOT, 'src'));
  const seen = new Set();
  return out.filter((g) => (seen.has(g.key) ? false : (seen.add(g.key), true)));
}

/* --------------------------------------------------------- recipes written down anywhere */
function collectRecipes() {
  const hits = new Map();   // key -> Set(file)
  const dirs = ['tools', 'docs', 'reports'];
  for (const d of dirs) {
    const dir = join(ROOT, d);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/\.(mjs|js|md|sh)$/.test(name)) continue;
      if (name === 'knobcheck.mjs') continue;          // this file's own usage examples
      const rel = `${d}/${name}`;
      const s = readFileSync(join(dir, name), 'utf8');
      for (const m of s.matchAll(/--config\s+["']?([A-Za-z][A-Za-z0-9_]*=[^\s"',]+(?:,[A-Za-z][A-Za-z0-9_]*=[^\s"',]+)*)/g)) {
        for (const kv of m[1].split(',')) {
          const k = kv.split('=')[0];
          if (/^(k|key|name|foo)$/.test(k)) continue;   // placeholders in usage examples
          if (!hits.has(k)) hits.set(k, new Set());
          hits.get(k).add(rel);
        }
      }
    }
  }
  return hits;
}

const KEYS = indexConfigKeys();
const findings = [];

/* ------------------------------------------------------------------------- --config */
if (OPT.config) {
  const pairs = OPT.config.split(',').map((s) => s.trim()).filter(Boolean);
  let bad = 0;
  for (const kv of pairs) {
    const [k, v] = kv.split('=');
    if (!v && v !== '0') {
      console.error(`FATAL ${kv}: not a k=v pair. capture.mjs would pass it through and setConfig would store junk.`);
      bad++; continue;
    }
    if (!KEYS.has(k)) {
      console.error(`FATAL ${k}: NO code under src/ reads this key.\n`
        + `      ctx.config accepts any key and reports success, so this A/B would have produced\n`
        + `      two identical frames and looked exactly like a dead subsystem (KNOWN_ISSUES 9,\n`
        + `      reports/depth.md 7). Check the spelling before you spend a capture.`);
      bad++; continue;
    }
    const gate = discoverGates().find((g) => g.key === k);
    if (gate && !gate.settable && (v === '0' || v === 'false')) {
      console.error(`FATAL ${kv}: ${k} is gated with \`!== false\` in ${gate.file}.\n`
        + `      --config can send the number 0 or the string 'false', never the boolean false,\n`
        + `      so this leaves the pass ON. Use tools/ablate.mjs (togglePass) for this one.`);
      bad++; continue;
    }
    console.log(`ok    ${kv}  read by ${[...KEYS.get(k)].join(', ')}`);
  }
  if (bad) process.exit(1);
}

/* --------------------------------------------------------------------------- --gates */
if (OPT.gates) {
  const gates = discoverGates();
  console.log(`${gates.length} pass gate(s) found under src/:\n`);
  for (const g of gates) {
    console.log(`  ${g.settable ? 'settable  ' : 'UNSETTABLE'} ${g.key.padEnd(18)} ${g.file}`);
  }
  const un = gates.filter((g) => !g.settable);
  if (un.length) {
    findings.push({ kind: 'unsettable-gate', keys: un.map((g) => g.key) });
    console.error(`\n${un.length} of ${gates.length} pass switches CANNOT be turned off with --config: `
      + `${un.map((g) => g.key).join(', ')}`);
    console.error(`  They are written \`(c.<key> ?? cfg.<key>) !== false\`, and the harness cannot express`);
    console.error(`  the boolean false — \`--config ${un[0].key}=0\` leaves the pass running. Any A/B on`);
    console.error(`  these knobs compared a frame with itself. Use tools/ablate.mjs, which goes through`);
    console.error(`  __HALO__.togglePass() and sets pass.enabled directly.`);
    console.error(`  Recommended src/ fix (not applied — src/ is owned by the rendering waves): test`);
    console.error(`  falsiness, \`const on = !!(c.<key> ?? cfg.<key>)\`, so 0 means off like every other knob.`);
  }
}

/* --------------------------------------------------------------------------- --audit */
if (OPT.audit) {
  const recipes = collectRecipes();
  const dead = [...recipes.entries()].filter(([k]) => !KEYS.has(k));
  console.log(`${recipes.size} distinct --config key(s) referenced across tools/, docs/ and reports/`);
  if (dead.length) {
    findings.push({ kind: 'dead-recipe', keys: dead.map(([k]) => k) });
    console.error(`\n${dead.length} recipe key(s) that NO code under src/ reads — every documented run of`);
    console.error(`these measured the shipped default and reported it as an A/B:\n`);
    for (const [k, files] of dead) console.error(`  ${k.padEnd(24)} cited in ${[...files].join(', ')}`);
  } else console.log('every documented --config key resolves to a read in src/');

  const gates = discoverGates().filter((g) => !g.settable);
  const cited = gates.filter((g) => recipes.has(g.key));
  if (cited.length) {
    console.error(`\n${cited.length} recipe(s) set a gate the harness cannot turn off: ${cited.map((g) => g.key).join(', ')}`);
  }
}

/* ------------------------------------------------------------------------------ --ab
 * The only check here that costs a capture. Two arms plus a control, so the noise floor is
 * measured rather than assumed (KNOWN_ISSUES 26: settle 48 is not converged at every pose). */
if (OPT.ab) {
  const arms = OPT.ab.split(',').map((s) => s.trim()).filter(Boolean);
  if (arms.length < 2) { console.error('--ab needs at least two arms, e.g. --ab exposure=0.2,exposure=2.6'); process.exit(2); }
  const WORK = join(tmpdir(), `halo-knobcheck-${process.pid}`);
  mkdirSync(WORK, { recursive: true });
  const cap = (label, cfg) => {
    const out = join(WORK, `${label}.png`);
    const a = ['tools/capture.mjs', '--pose', OPT.pose, '--settle', String(OPT.settle), '--out', out];
    if (cfg) a.push('--config', cfg);
    const r = spawnSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !existsSync(out)) return { ok: false, err: (r.stderr || '').trim().slice(0, 400) };
    const buf = readFileSync(out);
    return { ok: true, file: out, sha: createHash('sha256').update(buf).digest('hex') };
  };
  console.error(`[knobcheck] ${OPT.pose}, settle ${OPT.settle}: control + ${arms.length} arm(s)`);
  const base = cap('base', null);
  if (!base.ok) { console.error('baseline capture failed:\n' + base.err); process.exit(2); }
  const ctrl = cap('control', null);
  if (ctrl.ok && ctrl.sha !== base.sha) {
    console.error(`WARN  two identical captures differ at --settle ${OPT.settle} — this pose is not`);
    console.error(`      converged (KNOWN_ISSUES 26). "no effect" below is still sound; "has an effect" is not.`);
  }
  const shas = new Map([['<default>', base.sha]]);
  for (const a of arms) {
    const r = cap(a.replace(/[^A-Za-z0-9]/g, '_'), a);
    if (!r.ok) { console.error(`ERR   ${a}: ${r.err.split('\n')[0]}`); continue; }
    shas.set(a, r.sha);
  }
  const uniq = new Set(shas.values());
  console.error('');
  for (const [label, sha] of shas) console.error(`  ${label.padEnd(28)} ${sha.slice(0, 16)}`);
  if (uniq.size === 1) {
    findings.push({ kind: 'dead-knob', arms });
    console.error(`\nDEAD — every arm produced a BYTE-IDENTICAL frame. This knob does not reach the image.`);
    console.error(`  KNOWN_ISSUES 9 is this exact result for \`exposure\` across a 13x range. Do not tune it,`);
    console.error(`  and do not conclude anything about the pass behind it until the knob is wired.`);
  } else console.error(`\n${uniq.size} distinct frames across ${shas.size} arms — the knob reaches the image.`);
  rmSync(WORK, { recursive: true, force: true });
}

if (!OPT.config && !OPT.audit && !OPT.gates && !OPT.ab) {
  console.error('usage: node tools/knobcheck.mjs [--config k=v,...] [--audit] [--gates] [--ab k=v1,k=v2 --pose P]');
  process.exit(2);
}
if (OPT.json) console.log(JSON.stringify({ findings }, null, 2));
process.exit(findings.length ? 1 : 0);
