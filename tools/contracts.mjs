#!/usr/bin/env node
/**
 * contracts — for a named cross-file contract, print every file that currently
 * implements it, with line numbers. Read-only. Never fails a build.
 *
 *   node tools/contracts.mjs                    # every contract, ranked by sibling count
 *   node tools/contracts.mjs velocity-producer   # that contract's implementers, with lines
 *   node tools/contracts.mjs depth               # substring match on id
 *   node tools/contracts.mjs --audit             # contracts no report has ever named
 *   node tools/contracts.mjs --json
 *
 * WHY THIS EXISTS
 * ---------------
 * Every contract in this codebase has 3-5 implementers, a fix lands in one, and the
 * siblings are rediscovered a wave later:
 *
 *   - motion vectors (KNOWN_ISSUES #1): scene.js + taa.js fixed together, but there are
 *     three velocity PRODUCERS (terrain.js was accidentally correct, vegetation.js stayed
 *     wrong for two waves), and motionBlur.js carried a matching compensation that also
 *     had to flip.
 *   - collider contract (KNOWN_ISSUES #12): four producers audited, rocks.js fixed in
 *     Wave E ("every collider rocks.js produced was silently discarded"), structures.js
 *     left open until a later wave.
 *   - shared depth (KNOWN_ISSUES #18): dof, motionBlur, taa, ssao, ssr and water
 *     refraction all sample the same broken pipe.depthTex, discovered one consumer at a
 *     time across three waves before the source bug was found and fixed once.
 *
 * In every case the fixer had no way to see the sibling list. This is that list,
 * hand-maintained next to the tool in tools/contracts.json so the wave that adds an
 * implementer adds the pattern in the same commit.
 *
 * This is deliberately a REGISTRY, not a scanner that infers contracts from code. A
 * registry written by an auditor goes stale the moment nobody maintains it; this one
 * goes stale the same way tools/tells.mjs's OWNERS map does, which is at least visible
 * (an unmatched or over-matched pattern is obvious the first time someone reads the
 * output) rather than silent.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const REGISTRY_PATH = join(ROOT, 'tools/contracts.json');
const RDIR = join(ROOT, 'reports');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const audit = argv.includes('--audit');
const query = argv.find((a) => !a.startsWith('-'));

if (!existsSync(REGISTRY_PATH)) {
  console.error('contracts — tools/contracts.json not found; nothing to read.');
  process.exit(0);
}

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
} catch (e) {
  console.error(`contracts — tools/contracts.json does not parse: ${e.message}`);
  process.exit(2);
}

const contracts = Object.entries(registry.contracts || {}).map(([id, c]) => ({ id, ...c }));

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|glsl)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/* Cache one directory listing per (dir) across contracts that share scanDirs. */
const dirCache = new Map();
function filesIn(dir) {
  const abs = join(ROOT, dir);
  if (!dirCache.has(abs)) dirCache.set(abs, existsSync(abs) ? walk(abs) : []);
  return dirCache.get(abs);
}

function matchesFor(contract) {
  let re;
  try {
    re = new RegExp(contract.pattern);
  } catch (e) {
    return { error: `bad pattern: ${e.message}`, files: [] };
  }
  const dirs = contract.scanDirs && contract.scanDirs.length ? contract.scanDirs : ['src'];
  const seen = new Set();
  const files = [];
  for (const d of dirs) {
    for (const f of filesIn(d)) {
      if (seen.has(f)) continue;
      seen.add(f);
      const text = readFileSync(f, 'utf8');
      const lines = text.split('\n');
      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
      }
      if (hits.length) files.push({ file: relative(ROOT, f), hits });
    }
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { error: null, files };
}

/* --audit: which contract ids has no reports/*.md ever named (by id string). This is the
 * same shape as tells.mjs's --audit — a gate is only worth the pixels it prints if
 * someone reads it before closing the defect it names, and the only trace of that is the
 * id showing up in the report that closed it. */
function auditReport() {
  const reports = existsSync(RDIR) ? readdirSync(RDIR).filter((f) => f.endsWith('.md')) : [];
  const cited = {};
  for (const c of contracts) cited[c.id] = [];
  for (const f of reports) {
    const text = readFileSync(join(RDIR, f), 'utf8');
    for (const c of contracts) {
      if (text.includes(c.id)) cited[c.id].push('reports/' + f);
    }
  }
  return cited;
}

if (asJson) {
  if (audit) {
    console.log(JSON.stringify({ ok: true, cited: auditReport() }, null, 2));
  } else if (query) {
    const shown = contracts.filter((c) => c.id.toLowerCase().includes(query.toLowerCase()));
    console.log(JSON.stringify({
      ok: true, query,
      contracts: shown.map((c) => ({ ...c, ...matchesFor(c) })),
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      ok: true,
      contracts: contracts.map((c) => {
        const m = matchesFor(c);
        return { id: c.id, pattern: c.pattern, status: c.status, fileCount: m.files.length, error: m.error };
      }),
    }, null, 2));
  }
  process.exit(0);
}

if (audit) {
  const cited = auditReport();
  console.log(`contracts --audit — ${contracts.length} registered contract(s), checked against ${
    existsSync(RDIR) ? readdirSync(RDIR).filter((f) => f.endsWith('.md')).length : 0
  } file(s) in reports/\n`);
  for (const c of contracts) {
    const c2 = cited[c.id];
    console.log(`${c.id}  ${c2.length ? `named by ${c2.join(', ')}` : 'NAMED BY NO REPORT'}`);
  }
  const un = contracts.filter((c) => !cited[c.id].length);
  console.log(`\n${un.length} of ${contracts.length} contracts have never been named in a report: ${un.map((c) => c.id).join(', ') || '(none)'}`);
  console.log('That does not mean the contract was ignored - this registry may be newer than the');
  console.log('report that closed the defect. It does mean nobody can point to where the sibling');
  console.log('list was checked. Before closing a defect that names a contract, run');
  console.log('`node tools/contracts.mjs <id>` and say in your report what you found in each file.');
  process.exit(0);
}

if (!query) {
  console.log(`contracts — ${contracts.length} registered cross-file contract(s) (tools/contracts.json)\n`);
  for (const c of contracts) {
    const m = matchesFor(c);
    const flag = m.error ? `ERROR: ${m.error}` : `${m.files.length} file(s) match`;
    console.log(`${c.id}  ${flag}`);
    console.log(`  pattern: ${c.pattern}`);
    if (c.knownIssue) console.log(`  known issue: ${c.knownIssue}`);
    if (c.status) console.log(`  status: ${c.status}`);
    console.log('');
  }
  console.log('Run `node tools/contracts.mjs <id>` for the per-file, per-line list.');
  console.log('Run `node tools/contracts.mjs --audit` for which contracts no report has named.');
  process.exit(0);
}

const shown = contracts.filter((c) => c.id.toLowerCase().includes(query.toLowerCase()));
if (!shown.length) {
  console.log(`contracts — no registered contract id contains "${query}".`);
  console.log('Run `node tools/contracts.mjs` to see the registered ids.');
  process.exit(0);
}

for (const c of shown) {
  const m = matchesFor(c);
  console.log(`${c.id}  —  ${c.description || ''}`);
  console.log(`pattern: ${c.pattern}`);
  if (c.knownIssue) console.log(`known issue: ${c.knownIssue}`);
  if (c.status) console.log(`status: ${c.status}`);
  if (c.history) console.log(`history: ${c.history}`);
  if (c.note) console.log(`note: ${c.note}`);
  if (m.error) {
    console.log(`ERROR: ${m.error}`);
    continue;
  }
  console.log(`\n${m.files.length} file(s) currently implement this contract:\n`);
  for (const f of m.files) {
    const lineList = f.hits.map((h) => h.line).join(', ');
    console.log(`  ${f.file}  (lines ${lineList})`);
  }
  console.log('');
}
