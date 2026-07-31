#!/usr/bin/env node
/**
 * needscheck — cross-file fixes an agent could not apply, and whether anyone picked them up.
 *
 *   node tools/needscheck.mjs            # the routing list
 *   node tools/needscheck.mjs --json
 *   node tools/needscheck.mjs --strict   # exit 1 if a report asks for a cross-file change
 *                                        # without the machine-readable `NEEDS: <path>` heading
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/AGENT_BRIEF.md` R9: "One agent, one file. If your fix needs another file, write the
 * exact change into your report under a `NEEDS: <path>` heading and stop. The orchestrator
 * routes it."
 *
 * Agents obey the first half and ignore the second. Measured over `reports/*.md`:
 *
 *   - `NEEDS:` headings in 28 subsystem reports: **0**.
 *   - Reports that nonetheless hand off a fix in prose: at least nine, e.g.
 *       reports/depth.md:372   "~6-line fix in a file I do not own, with the patch written
 *                               out above. Highest priority."
 *       reports/clouds.md:379  "Needs an owner of `scene.js`"
 *       reports/structures.md:324 "the OBB type belongs to `physics.js`, which I do not own"
 *       reports/props.md:437   "terrain's splat, which I do not own. Whoever does: ..."
 *       reports/integration.md:632 "it needs the owner of `scene.js` + `taa.js`"
 *
 * So the ownership rule works and the routing channel does not exist: every one of those
 * fixes is a sentence in the middle of a 20-50 KB report, and the orchestrator has no way
 * to enumerate them. This is the same shape as the disproof that never reached the copies
 * (`tools/claimcheck.mjs`), one level up.
 *
 * This tool finds both forms — the heading and the prose — so the routing list exists even
 * for the reports written before the heading was asked for. It is read-only and advisory.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const RDIR = join(ROOT, 'reports');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');

/** Prose that hands work to another file's owner. Deliberately narrow: every pattern here
 *  was taken from a line that actually appears in reports/, not invented. */
const PROSE = [
  /\b(?:do not|don'?t|can(?:no|')t)\s+own\b/i,
  /\bneeds? an owner of\b/i,
  /\bneeds the owner of\b/i,
  /\bwhoever owns\b/i,
  /\bnot mine to (?:fix|edit|change|touch)\b/i,
  /\bfile I do not own\b/i,
];

const files = existsSync(RDIR)
  ? readdirSync(RDIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()
  : [];

/** last commit touching a path, as a unix ts — "was this routed?" is best answered by
 *  "has the target file changed since the report asked for it?" */
function lastTouched(p) {
  try {
    const t = execFileSync('git', ['log', '-1', '--format=%ct', '--', p], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (t) return Number(t) * 1000;
  } catch { }
  try { return statSync(join(ROOT, p)).mtimeMs; } catch { return 0; }
}

const rows = [];
for (const f of files) {
  const text = readFileSync(join(RDIR, f), 'utf8');
  const lines = text.split('\n');
  const rel = 'reports/' + f;
  const mtime = statSync(join(RDIR, f)).mtimeMs;

  lines.forEach((l, i) => {
    const m = /^\s*#{0,6}\s*\**NEEDS\**\s*:\s*(.+?)\s*$/i.exec(l);
    if (m) {
      // a heading may name several paths: `NEEDS: docs/KNOWN_ISSUES.md, reports/x.md`
      const paths = (m[1].match(/[\w./-]+\.(?:js|md|mjs|py|json)/g) || []);
      rows.push({
        kind: 'NEEDS', report: rel, line: i + 1, targets: paths,
        missing: paths.filter((p) => !existsSync(join(ROOT, p))),
        stale: paths.filter((p) => lastTouched(p) < mtime),
        text: l.trim().slice(0, 160),
      });
    } else if (PROSE.some((re) => re.test(l))) {
      const paths = (l.match(/`([\w./-]+\.(?:js|mjs|py|md))`/g) || []).map((s) => s.replace(/`/g, ''));
      rows.push({ kind: 'prose', report: rel, line: i + 1, targets: paths, text: l.trim().slice(0, 160) });
    }
  });
}

const needs = rows.filter((r) => r.kind === 'NEEDS');
const prose = rows.filter((r) => r.kind === 'prose');
const unrouted = prose.filter((r) => !needs.some((n) => n.report === r.report));

if (asJson) {
  console.log(JSON.stringify({ ok: unrouted.length === 0, needs, prose }, null, 2));
  process.exit(strict && unrouted.length ? 1 : 0);
}

console.log(`needscheck — ${files.length} reports\n`);

console.log(`NEEDS: headings (machine-routable): ${needs.length}`);
for (const n of needs) {
  const tag = n.missing.length ? `  MISSING PATH: ${n.missing.join(' ')}`
            : n.stale.length ? `  not touched since the report asked: ${n.stale.join(' ')}`
            : '  target changed after the report — probably routed';
  console.log(`  ${n.report}:${n.line}  -> ${n.targets.join(', ') || '(no path parsed)'}${tag}`);
}

console.log(`\nCross-file handoffs written in prose only (R9 says these belong under a NEEDS: heading): ${prose.length}`);
for (const p of prose.slice(0, 40)) {
  console.log(`  ${p.report}:${p.line}${p.targets.length ? '  [' + p.targets.join(' ') + ']' : ''}`);
  console.log(`      ${p.text}`);
}
if (prose.length > 40) console.log(`  … ${prose.length - 40} more`);

if (unrouted.length) {
  console.log(`\n${unrouted.length} handoff line(s) in ${new Set(unrouted.map((u) => u.report)).size} report(s) with no NEEDS: heading anywhere in the file.`);
  console.log('Add one line at the point of the handoff so the orchestrator can enumerate it:\n');
  console.log('    NEEDS: src/render/passes/scene.js');
  console.log('    <the exact change, as you would have made it>\n');
  console.log('This is advisory. R9 (docs/AGENT_BRIEF.md) is otherwise followed well — agents');
  console.log('really do stop at their file boundary; the fix then has nowhere to go.');
}

process.exit(strict && unrouted.length ? 1 : 0);
