#!/usr/bin/env node
/**
 * blindledger — make a blind A/B verdict auditable after the session that ran it is gone.
 *
 * The blind test is this project's acceptance gate: `reports/blind.md` records **9 losses in
 * 9 pairs**. Everything that makes that number checkable is transient:
 *
 *   - the answer key lives outside the repo, in a session-scoped scratchpad
 *     (`/tmp/claude-.../<session-uuid>/scratchpad/blindkeys/key.json`) that disappears with
 *     the session,
 *   - the A/B sheets live under `shots/`, which is .gitignore'd,
 *   - the picks live in `scratchpad/mypicks.txt`, likewise gone.
 *
 * So the only surviving artefact is the prose, and the prose is not reliable on its own:
 * blind.md's positional-bias guard states "the randomiser put our render on side A in 4 pairs
 * and side B in 5". The key says **3 and 6**. (The 9-0 tally itself is correct — verified
 * against the key, pair by pair — but that guard paragraph was written from memory.)
 *
 * This tool writes the permanent, non-spoiling record: per pose, which side the render was
 * on, what was picked, whether that pick was the reference, plus the sha256 of the key file
 * and of each sheet. It touches nothing else, and `tools/blind.mjs` does not need to change.
 *
 *   node tools/blindledger.mjs --key <key.json> --picks "ref_00000=A,ref_00120=B,..." --tag waveH
 *   node tools/blindledger.mjs --show                 # print the ledger
 *
 * The recorded sides are not a spoiler for a future run: blind.mjs re-randomises per run and
 * the key it writes is run-scoped.
 */
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const LEDGER = join(ROOT, 'scores/blind_ledger.jsonl');
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

if (argv.includes('--show')) {
  if (!existsSync(LEDGER)) { console.log('no blind ledger yet'); process.exit(0); }
  for (const line of readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    console.log(`${r.tag.padEnd(14)} ${r.date}  render wins ${r.renderWins}/${r.n}  ` +
                `render on A ${r.renderOnA}, on B ${r.renderOnB}  key ${r.keySha}`);
    for (const p of r.pairs) console.log(`    ${p.pose.padEnd(12)} render=${p.renderSide} pick=${p.pick} -> ${p.pickWas}`);
  }
  process.exit(0);
}

const keyPath = arg('key');
const picksArg = arg('picks');
const tag = arg('tag', 'untagged');
if (!keyPath || !picksArg) {
  console.error('usage: node tools/blindledger.mjs --key <key.json> --picks "pose=A,pose=B,..." [--tag <tag>]');
  process.exit(2);
}
if (!existsSync(keyPath)) { console.error(`blindledger: no key at ${keyPath}`); process.exit(1); }

const keyBuf = readFileSync(keyPath);
const key = JSON.parse(keyBuf.toString());
const picks = Object.fromEntries(picksArg.split(',').map((s) => s.trim().split('=')));

const pairs = [];
for (const [pose, v] of Object.entries(key.pairs || {})) {
  const pick = picks[pose];
  if (!pick) { console.error(`blindledger: no pick recorded for ${pose}`); process.exit(1); }
  const sheet = v.sheet && existsSync(join(ROOT, v.sheet)) ? sha(readFileSync(join(ROOT, v.sheet))) : null;
  pairs.push({ pose, renderSide: v.renderSide, pick,
               pickWas: pick === v.renderSide ? 'render' : 'reference', sheetSha: sheet });
}

const row = {
  tag,
  date: new Date().toISOString().slice(0, 10),
  n: pairs.length,
  renderWins: pairs.filter((p) => p.pickWas === 'render').length,
  renderOnA: pairs.filter((p) => p.renderSide === 'A').length,
  renderOnB: pairs.filter((p) => p.renderSide === 'B').length,
  keySha: sha(keyBuf),
  keyPath,
  pairs,
};
appendFileSync(LEDGER, JSON.stringify(row) + '\n');
console.log(`blindledger — ${tag}: render won ${row.renderWins}/${row.n}; ` +
            `render was on side A in ${row.renderOnA} pair(s), B in ${row.renderOnB}. ` +
            `Appended to scores/blind_ledger.jsonl`);
