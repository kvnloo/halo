#!/usr/bin/env node
/**
 * apicheck — does `docs/API.md` describe the code that is actually on disk?
 *
 *   node tools/apicheck.mjs           # table of documented members that no module defines
 *   node tools/apicheck.mjs --json
 *   node tools/apicheck.mjs --warn    # always exit 0 (what preflight/CI use)
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/API.md` is the one document every module author codes against, and it opens with
 * "**These signatures are frozen.** If you own a module below, you must implement its
 * interface exactly." Nothing has ever checked that sentence. It is a claim, read as
 * ground truth by every wave, with no instrument behind it — the exact shape of §19
 * (`reports/fog.md`'s `HALO_NO_DAEMON=1`, believed for two waves) one level up.
 *
 * It matters more here than in a normal codebase because API.md *also* tells consumers to
 * guard every call:
 *
 *     const terrain = ctx.get('terrain');
 *     const y = terrain ? terrain.height(x, z) : 0;
 *
 * That guard is correct for a module that did not load — and it silently swallows a member
 * that was never implemented. `undefined` propagates as a fallback value, not as an error.
 * This is the same class as KNOWN_ISSUES §12 (every collider `rocks.js` produced was
 * silently discarded) and S1 in the meta ledger (`H.setConfig(obj)` set
 * `config['[object Object]']` and "returned quietly").
 *
 * LIVE FINDING at the time of writing — three members of the `sky` contract:
 *   sky.envTexture      documented "equirect or cube, HDR, for PMREM" — absent, 0 readers
 *   sky.horizonColor    documented "used by aerial perspective + fog" — absent, 0 readers
 *   sky.needsEnvUpdate  documented "set true when the sky changes"    — absent, and
 *                       `src/render/env.js:724` reads it every frame:
 *                           if (sky?.needsEnvUpdate) { dirty = true; force = true; ... }
 *                       so the documented "re-capture the env probe when the sky changes"
 *                       handshake can never fire. env.js falls back to its own sunMoveDeg
 *                       heuristic, so nothing errors and nothing says so.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It checks *presence of the name in the owning module*, not the signature, the argument
 * list or the return type. That is deliberate: a name test has no false positives here
 * (verified against all 15 documented modules — only the three above are flagged), while
 * anything cleverer needs a parser and starts inventing findings. A documented member that
 * exists but takes different arguments is out of scope; a documented member that does not
 * exist at all is the failure this project keeps having.
 *
 * Read-only. No GPU, no browser, no capture, ~50 ms. Never edits anything.
 *
 * Exit: 0 clean (or --warn) • 1 a documented member is absent • 2 apicheck itself broke
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const warnOnly = argv.includes('--warn');

const DOC = join(ROOT, 'docs/API.md');
if (!existsSync(DOC)) {
  console.error('apicheck: docs/API.md not found — nothing to check');
  process.exit(2);
}

/* ---------------------------------------------------------------- index src/ once */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
let SRC = [];
try { SRC = walk(join(ROOT, 'src')); } catch { }
const TEXT = new Map(SRC.map((p) => [p, readFileSync(p, 'utf8')]));
const rel = (p) => p.slice(ROOT.length + 1);

/* module 'terrain' -> src/world/terrain.js (basename match, the project's own convention) */
function moduleFile(name) {
  const hits = SRC.filter((p) => basename(p, '.js') === name);
  return hits.length ? hits[0] : null;
}

/* ------------------------------------------------- parse docs/API.md into a contract */
const doc = readFileSync(DOC, 'utf8').split('\n');
const modules = [];          // { name, members:Set, line }
let cur = null;
let inFence = false;

for (let i = 0; i < doc.length; i++) {
  const line = doc[i];
  const h = /^##\s+`([A-Za-z_][A-Za-z0-9_]*)`/.exec(line);
  if (h && !inFence) { cur = { name: h[1], members: new Set(), line: i + 1 }; modules.push(cur); continue; }
  if (/^```/.test(line)) { inFence = !inFence; continue; }
  if (!cur || !inFence) continue;
  // strip trailing // comment so prose does not manufacture members
  const code = line.split('//')[0];
  const re = new RegExp(`\\b${cur.name}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  let m;
  while ((m = re.exec(code))) cur.members.add(m[1]);
}

/* documented bus events, from the same file: ctx.emit('name', …) */
const events = new Set();
for (const line of doc) {
  const m = /ctx\.emit\(\s*'([a-z]+:[a-z]+)'/i.exec(line);
  if (m) events.add(m[1]);
}

/* ------------------------------------------------------------------------- check it */
const absent = [];       // documented, module file exists, member name never appears
const unbuilt = [];      // documented module has no file in src/ at all
const deadEvents = [];   // documented event nobody emits

for (const mod of modules) {
  if (!mod.members.size) continue;
  const f = moduleFile(mod.name);
  if (!f) { unbuilt.push({ module: mod.name, docLine: mod.line, members: [...mod.members] }); continue; }
  const src = TEXT.get(f);
  for (const mem of mod.members) {
    if (new RegExp(`\\b${mem}\\b`).test(src)) continue;
    // who consumes it? a documented-but-absent member with readers is the worse case:
    // the reader's optional-chaining guard turns it into a silent permanent false.
    const readers = [];
    for (const [p, t] of TEXT) {
      if (p === f) continue;
      const lines = t.split('\n');
      lines.forEach((l, i) => {
        if (/^\s*(\*|\/\/|\/\*)/.test(l)) return;            // a docblock is not a reader
        if (new RegExp(`[.?]\\s*${mem}\\b`).test(l)) readers.push(`${rel(p)}:${i + 1}`);
      });
    }
    absent.push({ module: mod.name, member: mem, file: rel(f), docLine: mod.line, readers });
  }
}

for (const ev of events) {
  let emitted = false;
  for (const t of TEXT.values()) if (t.includes(`emit('${ev}'`) || t.includes(`emit("${ev}"`)) { emitted = true; break; }
  if (!emitted) deadEvents.push(ev);
}

/* ----------------------------------------------------------------------- report out */
const bad = absent.length + deadEvents.length;

if (asJson) {
  console.log(JSON.stringify({
    ok: bad === 0, modules: modules.length, absent, unbuilt, deadEvents,
  }, null, 2));
} else if (bad === 0) {
  console.log(`ok — ${modules.length} documented module contract(s), every member present in src/, ` +
              `${events.size} bus event(s) emitted`);
  if (unbuilt.length) {
    console.log(`note: ${unbuilt.length} documented module(s) have no file in src/ yet ` +
                `(${unbuilt.map((u) => u.module).join(', ')}) — not a defect, they have not landed`);
  }
} else {
  console.error(`docs/API.md declares "These signatures are frozen" — ${absent.length} declared member(s) ` +
                `are not in the module that owns them:\n`);
  for (const a of absent) {
    console.error(`  ${a.module}.${a.member}`);
    console.error(`      documented docs/API.md:${a.docLine}   owner ${a.file} — name never appears`);
    if (a.readers.length) {
      console.error(`      READ BY ${a.readers.length} site(s): ${a.readers.slice(0, 4).join(', ')}` +
                    `${a.readers.length > 4 ? ' …' : ''}`);
      console.error('      A guarded read of a member that does not exist is permanently false and never throws.');
    } else {
      console.error('      no readers — the contract is documented but unused on both sides.');
    }
  }
  for (const ev of deadEvents) console.error(`  event '${ev}' is documented but nothing in src/ emits it`);
  console.error(`\nEither implement the member, or correct docs/API.md. Do not leave the frozen ` +
                `contract describing code that is not there.`);
  if (unbuilt.length) {
    console.error(`(${unbuilt.length} documented module(s) have no file in src/ at all: ` +
                  `${unbuilt.map((u) => u.module).join(', ')} — not counted above.)`);
  }
}

process.exit(warnOnly ? 0 : (bad ? 1 : 0));
