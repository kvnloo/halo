#!/usr/bin/env node
/**
 * tells — put the acceptance gate in front of the agent who owns the file it names.
 *
 *   node tools/tells.mjs                 # every tell, ranked, with its owning file(s)
 *   node tools/tells.mjs rocks           # only the tells that name your subsystem
 *   node tools/tells.mjs --audit         # which tells no report has ever cited
 *   node tools/tells.mjs --json
 *
 * WHY THIS EXISTS
 * ---------------
 * `reports/blind.md` is the project's stated acceptance gate: nine frames judged blind
 * against the real game, lost 9-0, with eleven tells ranked by how many frames each one
 * decided. That list is the only ranked statement of what actually loses the A/B.
 *
 * Nobody reads it. Measured over `reports/*.md`:
 *
 *   - 4 of 30 reports mention the blind test at all, and three of those four are the
 *     tooling agents who built it (`harness`, `metrics`, `posefit`). ZERO subsystem
 *     reports cite the tell that decides their own subsystem.
 *   - `reports/tonemap.md` (written 2026-07-31 02:15) and `reports/terrain.md` (02:14)
 *     both landed ~2.5 h AFTER `blind.md` was committed, and neither contains the string
 *     "blind" or any `T<n>`. T11 is *about* the tonemap; T2 is *about* the beach.
 *
 * `docs/AGENT_BRIEF.md` R1-R10 never names `reports/blind.md`. So agents optimise six
 * scored axes against reference frames, while the ranked list of what actually gave the
 * frame away sits unread — including T10, "at ref_02220 the bridge is absent from our
 * render entirely … it should be triaged first because it is the only finding here that
 * is outright *wrong*". Twenty-six subsystem reports, each measuring its own ROI, and a
 * missing building was found only by the blind test.
 *
 * Read-only. Prints. Never fails a build (`--strict` is there if a wave script wants it).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BLIND = join(ROOT, 'reports/blind.md');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const audit = argv.includes('--audit');
const strict = argv.includes('--strict');
const query = argv.find((a) => !a.startsWith('-'));

/**
 * Hand-maintained: which src/ file an agent would have to own to act on each tell.
 * Hand-maintained on purpose — the tells are prose written by a human judge and do not
 * name files reliably (T3 and T9 name no file at all). Adding a tell here is one line.
 * A key matches if the query is a substring of any path or of the tell's title.
 */
const OWNERS = {
  T1: ['src/world/rocks.js'],
  T2: ['src/world/rocks.js', 'src/world/terrain.js', 'src/world/props.js'],
  T3: ['src/render/passes/ssao.js', 'src/render/passes/scene.js'],
  T4: ['src/game/ai.js', 'src/gfx/materialCommon.js'],
  T5: ['src/world/ocean.js'],
  T6: ['src/world/vegetation.js'],
  T7: ['src/world/clouds.js'],
  T8: ['src/world/sky.js'],
  T9: ['src/render/passes/volumetricFog.js', 'src/gfx/materialCommon.js'],
  T10: ['src/world/structures.js'],
  T11: ['src/render/passes/tonemap.js', 'src/render/passes/bloom.js', 'src/render/passes/grade.js'],
};

if (!existsSync(BLIND)) {
  console.error('tells — reports/blind.md not found; nothing to read.');
  process.exit(0);
}

const src = readFileSync(BLIND, 'utf8');
const lines = src.split('\n');

/* Parse `### T1 — Rock silhouettes are extrusions, not erosion *(decided 7 of 9 frames)*` */
const tells = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^###\s+(T\d+)\s*[—-]\s*(.+?)\s*$/.exec(lines[i]);
  if (!m) continue;
  const [, id, rawTitle] = m;
  const decided = /decided\s+(\d+)\s+of\s+(\d+)/i.exec(rawTitle);
  // body = up to the next heading, trimmed to something readable in a terminal
  const body = [];
  for (let j = i + 1; j < lines.length && !/^#{2,3}\s/.test(lines[j]); j++) body.push(lines[j]);
  tells.push({
    id,
    line: i + 1,
    title: rawTitle.replace(/\*\([^)]*\)\*/g, '').trim(),
    decided: decided ? Number(decided[1]) : 0,
    global: /global/i.test(rawTitle),
    owners: OWNERS[id] || [],
    body: body.join('\n').trim(),
  });
}

/* Who, if anyone, has ever cited a tell. A report counts as citing it only if it mentions
 * the blind test AND the tell id — "T5" alone is too common a token to trust. */
const RDIR = join(ROOT, 'reports');
const reports = existsSync(RDIR) ? readdirSync(RDIR).filter((f) => f.endsWith('.md') && f !== 'blind.md') : [];
const cited = Object.fromEntries(tells.map((t) => [t.id, []]));
for (const f of reports) {
  const text = readFileSync(join(RDIR, f), 'utf8');
  if (!/blind/i.test(text)) continue;
  for (const t of tells) {
    if (new RegExp(`\\b${t.id}\\b`).test(text)) cited[t.id].push('reports/' + f);
  }
}

let shown = tells.slice().sort((a, b) => b.decided - a.decided);
if (query) {
  const q = query.toLowerCase();
  shown = shown.filter((t) =>
    t.owners.some((o) => o.toLowerCase().includes(q)) ||
    t.title.toLowerCase().includes(q) ||
    t.id.toLowerCase() === q);
}

if (asJson) {
  console.log(JSON.stringify({
    ok: true, source: 'reports/blind.md', query: query || null,
    tells: shown.map((t) => ({ ...t, citedBy: cited[t.id], body: undefined })),
  }, null, 2));
  process.exit(0);
}

if (!shown.length) {
  console.log(`tells — no tell in reports/blind.md names "${query}".`);
  console.log('That is a real answer: the blind gate did not lose a frame on your subsystem.');
  console.log('Run `node tools/tells.mjs` to see the ones it did.');
  process.exit(0);
}

console.log(`tells — reports/blind.md, ${tells.length} ranked tells` + (query ? ` (filtered: ${query})` : '') + '\n');
for (const t of shown) {
  const c = cited[t.id];
  const flag = c.length ? `cited by ${c.join(', ')}` : 'CITED BY NO REPORT';
  console.log(`${t.id}  decided ${t.decided}/9${t.global ? ' (global)' : ''}  — ${t.title}`);
  console.log(`     owner(s): ${t.owners.length ? t.owners.join(', ') : '(unassigned — nobody owns this)'}`);
  console.log(`     ${flag}`);
  console.log(`     reports/blind.md:${t.line}`);
  if (query) {
    console.log('');
    console.log(t.body.split('\n').map((l) => '     | ' + l).join('\n'));
  }
  console.log('');
}

if (audit || !query) {
  const un = tells.filter((t) => !cited[t.id].length);
  console.log(`${un.length} of ${tells.length} tells have never been cited by any report: ${un.map((t) => t.id).join(' ')}`);
  console.log('The blind A/B is the acceptance gate (reports/blind.md:1). An axis delta that');
  console.log('does not move a tell does not move the gate.');
}

process.exit(strict && shown.some((t) => !cited[t.id].length) ? 1 : 0);
