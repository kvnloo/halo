#!/usr/bin/env node
/**
 * reportlint — does each report say enough for a reviewer to trust its numbers?
 *
 *   node tools/reportlint.mjs            # table of every report and what it is missing
 *   node tools/reportlint.mjs --strict   # exit non-zero if any report lacks provenance
 *   node tools/reportlint.mjs --json
 *
 * WHY
 * ---
 * `tools/capture.mjs` now stamps `_capture.json` beside every set of PNGs. That fixes
 * provenance for *captures*. Reports are the artefact humans and critics actually read,
 * and they still carry bare numbers with nothing saying which tree produced them.
 *
 * The cost is on the record:
 *
 *   §16  Six `src/` files were rewritten *while* captures were running. It produced three
 *        phantom parse errors and two false `BROKEN` determinism results, and all five were
 *        written down as real findings before anyone worked out what had happened.
 *   §19  `reports/fog.md` opened by instructing everyone to measure with
 *        `HALO_NO_DAEMON=1` on a stale-module-cache theory. Tested later: false. The
 *        workaround it recommended is the configuration that exhausted system memory at 17
 *        agents, and it had already propagated into `reports/tonemap.md`.
 *   §26  `waveG` and `waveG-settle96` are identical code and differ by 0.52 points on
 *        `--settle` alone — and most reports never say which settle they used.
 *
 * Two reports already do this right, unprompted. `reports/structures.md` opens with
 * "`src/` is not quiescent ... so no whole-frame number captured minutes apart is
 * comparable", and `reports/ocean_waveH.md` opens with "Read section 1 before believing any
 * absolute number in this file". Those two are trustworthy in a way the other twenty-four
 * cannot be shown to be, and the entire difference is six lines of header.
 *
 * This lints for that header. It is ADVISORY by default: it never fails a build, and it
 * never edits a report. `--strict` is there for a wave script that wants to enforce it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIR = join(ROOT, 'reports');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');

/** Fields the provenance block should carry. `owner` and `pose` matter most: without them
 *  a number cannot be re-taken, which is the only way to check it. */
const FIELDS = [
  ['owner', /^\s*owner\s*:/im, 'which src/ file this report owns'],
  ['pose', /^\s*poses?\s*\(?s?\)?\s*:/im, 'which pose(s) the numbers came from'],
  ['settle', /^\s*settle\s*:/im, 'settle count — §26, 48 vs 96 is worth 0.52 points'],
  ['preflight', /^\s*preflight\s*:/im, 'was the tree gated before measuring (§20)'],
  ['src-quiescent', /^\s*src[-_ ]?quiescent\s*:/im, 'was src/ still during the window (§16)'],
];

const SKIP = new Set(['README.md', 'blind.md']);   // index page and the acceptance gate
const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith('.md') && !SKIP.has(f)).sort()
  : [];

const rows = files.map((f) => {
  const src = readFileSync(join(DIR, f), 'utf8');
  const head = src.slice(0, 4000);          // the block belongs at the top, not buried
  const block = /<!--\s*provenance([\s\S]*?)-->/i.exec(head);
  const hay = block ? block[1] : head;
  const missing = FIELDS.filter(([, re]) => !re.test(hay)).map(([k]) => k);
  // A report that declares its limits in prose is doing the right thing even without the
  // block; credit it so the lint does not punish the two reports that got it right first.
  const prose = /quiescen|not comparable|before believing any absolute|same-window/i.test(head);
  return { file: 'reports/' + f, hasBlock: !!block, missing, prose };
});

const bad = rows.filter((r) => r.missing.length);

if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, checked: rows.length, rows }, null, 2));
} else {
  console.log(`reportlint — ${rows.length} reports\n`);
  for (const r of rows) {
    if (!r.missing.length) { console.log(`  ok    ${r.file}`); continue; }
    const note = r.prose ? '  [declares its limits in prose — good, but not machine-readable]' : '';
    console.log(`  MISS  ${r.file}  missing: ${r.missing.join(', ')}${note}`);
  }
  if (bad.length) {
    console.log(`\n${bad.length} of ${rows.length} reports carry numbers with no provenance.`);
    console.log('Add this block at the top of your report (docs/AGENT_BRIEF.md R7):\n');
    console.log('<!-- provenance');
    for (const [k, , why] of FIELDS) console.log(`${k}: ${' '.repeat(Math.max(0, 14 - k.length))}   # ${why}`);
    console.log('capture:          # path to the _capture.json beside your PNGs');
    console.log('-->\n');
    console.log('This is advisory. It exists so a reviewer can tell a measured number from a');
    console.log('remembered one — see §16, where five findings taken during a non-quiescent');
    console.log('window were recorded as real.');
  } else {
    console.log('\nAll reports carry provenance.');
  }
}

process.exit(strict && bad.length ? 1 : 0);
