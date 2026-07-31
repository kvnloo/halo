#!/usr/bin/env node
/**
 * refstamp — fingerprint the reference material, so "measured against the reference"
 * becomes a checkable statement instead of a promise.
 *
 * Every score in `scores/history.jsonl`, every delta in `docs/TARGETS.md` and every
 * "reference 79.14" in a report is a comparison against `ref/` — 159 keyframes, 50 ROI
 * crops and `ref/roi_signatures.json`. `ref/` is .gitignore'd (it is licensed game footage;
 * see README) and, per the README, "no script survives" for rebuilding it: the extraction
 * was done by hand and never written down.
 *
 * So the ground truth of this project exists on exactly one machine, unversioned, with
 * nothing recording which bytes produced which number. Anyone who re-extracts from a
 * different clip — or re-runs the README's own ffmpeg line, whose `kf_NNNNN` indices depend
 * on the source pts — silently changes what every historical number means, and nothing
 * anywhere will say so. That is the same failure class as KNOWN_ISSUES §3 ("applying a pose
 * fit invalidates every previously recorded score", with no stamp on a score saying which
 * pose set it used).
 *
 * This tool does not redistribute anything: it records name + size + sha256 only.
 *
 *   node tools/refstamp.mjs                 # write tools/ref_manifest.json
 *   node tools/refstamp.mjs --verify        # exit 1 if ref/ no longer matches the manifest
 *   node tools/refstamp.mjs --verify --quiet
 *
 * Run `--verify` before a scored run you intend to compare against history.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, globSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const verify = argv.includes('--verify');
const quiet = argv.includes('--quiet');
const MANIFEST = join(ROOT, 'tools/ref_manifest.json');

// frames_full/ is the raw extraction and is not what anything scores against; the four
// sets below are.
const PATTERNS = ['ref/keyframes/*.png', 'ref/roi/*.png', 'ref/detail/*.png', 'ref/*.json'];

function scan() {
  const out = {};
  for (const p of PATTERNS) {
    for (const rel of globSync(p, { cwd: ROOT }).sort()) {
      const abs = join(ROOT, rel);
      const buf = readFileSync(abs);
      out[rel] = { bytes: statSync(abs).size, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
    }
  }
  return out;
}

if (!existsSync(join(ROOT, 'ref'))) {
  console.error('refstamp: ref/ is absent — the reference material is gitignored (see README).');
  console.error('          Nothing to stamp; scoring is not possible on this machine either.');
  process.exit(verify ? 1 : 0);
}

const now = scan();

if (!verify) {
  writeFileSync(MANIFEST, JSON.stringify({
    note: 'sha256 (first 16 hex) of the reference material every score is measured against. ' +
          'Regenerate ONLY when the reference is deliberately re-extracted — and say so in the ' +
          'commit message, because it invalidates every number in scores/history.jsonl.',
    stampedAt: new Date().toISOString().slice(0, 10),
    files: Object.keys(now).length,
    entries: now,
  }, null, 2) + '\n');
  console.log(`refstamp — wrote tools/ref_manifest.json for ${Object.keys(now).length} reference files`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.error('refstamp --verify: no tools/ref_manifest.json. Run `node tools/refstamp.mjs` once to create it.');
  process.exit(1);
}

const was = JSON.parse(readFileSync(MANIFEST, 'utf8')).entries || {};
const added = [], removed = [], changed = [];
for (const k of Object.keys(now)) if (!was[k]) added.push(k);
for (const k of Object.keys(was)) {
  if (!now[k]) { removed.push(k); continue; }
  if (now[k].sha256 !== was[k].sha256) changed.push(k);
}

if (!added.length && !removed.length && !changed.length) {
  if (!quiet) console.log(`ok — ref/ matches the manifest (${Object.keys(now).length} files); ` +
                          `history.jsonl numbers are comparable`);
  process.exit(0);
}

console.error('!!! REFERENCE DRIFT — the ground truth is not the one these scores were taken against !!!');
for (const k of changed.slice(0, 20)) console.error(`    changed : ${k}`);
for (const k of removed.slice(0, 20)) console.error(`    removed : ${k}`);
for (const k of added.slice(0, 20)) console.error(`    added   : ${k}`);
console.error(`    ${changed.length} changed, ${removed.length} removed, ${added.length} added`);
console.error('    Deltas against scores/history.jsonl and docs/TARGETS.md are no longer meaningful.');
console.error('    If the re-extraction was deliberate: re-stamp, and note it beside the next score row.');
process.exit(1);
