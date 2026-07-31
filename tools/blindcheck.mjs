#!/usr/bin/env node
/**
 * blindcheck — how many scored runs have landed since the gate that decides the project?
 *
 *   node tools/blindcheck.mjs           # the gap, in runs and in tags
 *   node tools/blindcheck.mjs --strict  # exit 1 when the gate is stale
 *   node tools/blindcheck.mjs --json
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `docs/LOOP.md` §5 carries seven standing rules. Two of them are the project's own
 * statement of what its numbers are worth:
 *
 *   6. "Run the blind test every wave, not at the end. It costs one command and three
 *      looks now. Five waves were spent optimising proxies that a single 30-minute blind
 *      test would have invalidated on day one."
 *   7. "The blind test is the score. Everything in scores/history.jsonl is a proxy that
 *      was picked for being cheap. When a proxy and the blind test disagree, the proxy is
 *      wrong. It has disagreed once, by 9 pairs to nil."
 *
 * Measured adherence, from the two files themselves: `scores/history.jsonl` holds 14
 * scored runs plus 1 hand-written marker row; `scores/blind.jsonl` holds ONE human
 * judgement — `waveH`, and its own note says "backfilled". Four scored runs have landed
 * since, including the 29.44 -> 16.85 collapse across the Wave I pose refit, and none of
 * them was judged. Rule 6 has been followed once in fourteen.
 *
 * It is not carelessness and it is not the judge's fault: `docs/AGENT_BRIEF.md` — the file
 * wave scripts inject — never mentions `docs/LOOP.md`, so the standing rules reach nobody,
 * and no tool ever compared the two ledgers. Every other rule that got a command behind it
 * (R1, preflight) is followed; every rule left as a paragraph is not. This is the command.
 *
 * It reads two files and computes a difference. No capture, no GPU, no network, ~30 ms.
 * `tools/blind.mjs` is NOT touched or invoked — it is owned elsewhere, and running the
 * acceptance gate is a human's decision, not a checker's.
 *
 * Exit codes:  0 ok (or advisory)  •  1 --strict and the gate is stale  •  2 blindcheck broke
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');
const maxGapI = argv.indexOf('--max-gap');
const MAX_GAP = maxGapI >= 0 ? Number(argv[maxGapI + 1]) : 0;   // 0 = judge every wave (LOOP §5.6)

function readJsonl(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* a malformed row is historycheck's business */ }
  }
  return out;
}

try {
  /* A marker row is not a run. `== POSE REFIT LINE ==` was hand-appended to record a
   * discontinuity; U2 taught historycheck the same lesson. n === 0 is the signature. */
  const runs = readJsonl('scores/history.jsonl')
    .filter((r) => r && r.tag && Number(r.n) > 0)
    .map((r) => ({ tag: String(r.tag), score: r.score }));

  const blind = readJsonl('scores/blind.jsonl');
  const human = blind.filter((b) => b.kind === 'human');
  const auto = blind.filter((b) => b.kind === 'auto');
  const last = human.length ? human[human.length - 1] : null;

  /* Where does the last judged tag sit in the run series? Match from the end: a tag can
   * repeat (`latest` appears twice — G6 flagged it), and the later occurrence is the one
   * a judgement taken today would refer to. */
  let idx = -1;
  if (last?.tag) for (let i = runs.length - 1; i >= 0; i--) if (runs[i].tag === last.tag) { idx = i; break; }
  const since = last ? (idx >= 0 ? runs.length - 1 - idx : null) : runs.length;
  const sinceTags = idx >= 0 ? runs.slice(idx + 1).map((r) => r.tag) : (last ? [] : runs.map((r) => r.tag));

  const stale = since === null ? true : since > MAX_GAP;
  const summary = !last
    ? `no human blind judgement has ever been recorded, against ${runs.length} scored run(s)`
    : idx < 0
      ? `the last human blind judgement is tagged "${last.tag}", which matches no row in history.jsonl — the two ledgers cannot be joined`
      : `${since} scored run(s) since the last human blind judgement (${last.tag}${last.at ? ', ' + String(last.at).slice(0, 10) : ''}: render won ${last.chose_render ?? '?'} of ${last.n ?? '?'})`;

  if (asJson) {
    console.log(JSON.stringify({
      ok: !stale, runs: runs.length, humanJudgements: human.length, autoRuns: auto.length,
      lastJudged: last?.tag ?? null, since, sinceTags, maxGap: MAX_GAP, summary,
    }, null, 2));
  } else {
    console.log(`blindcheck — ${summary}`);
    if (sinceTags.length) console.log(`  unjudged: ${sinceTags.join(' ')}`);
    if (auto.length) console.log(`  ${auto.length} machine pass(es) on record (node tools/blind.mjs --auto) — a cheap proxy for the gate, not the gate`);
    if (stale) {
      console.log(`  docs/LOOP.md §5.7: "The blind test is the score. Everything in scores/history.jsonl is a`);
      console.log(`  proxy that was picked for being cheap. When a proxy and the blind test disagree, the`);
      console.log(`  proxy is wrong." §5.6 asks for one judgement per wave; this is ${since === null ? 'unjoinable' : since + ' behind'}.`);
      console.log(`  Run:  node tools/blind.mjs --capture --contact   # then --score "ref_00000=A,..."`);
    }
  }
  process.exit(strict && stale ? 1 : 0);
} catch (e) {
  console.error('blindcheck BROKE: ' + (e?.stack || e));
  process.exit(2);
}
