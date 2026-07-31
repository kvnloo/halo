#!/usr/bin/env node
/**
 * claimcheck — has a disproved claim been left standing where an agent will act on it?
 *
 * Reports in this project are read as ground truth by every later wave. When one of them is
 * wrong, the wrongness propagates: `reports/fog.md` opened by telling everyone to measure
 * with `HALO_NO_DAEMON=1` on a stale-module-cache theory. It was tested and is false
 * (KNOWN_ISSUES §19) — and the workaround costs one vite + one Chrome per agent, the exact
 * configuration that exhausted memory at 17 agents. fog.md now carries a retraction. The
 * copies of the claim that had already spread to other reports do not.
 *
 * So: `tools/refuted.json` is the list of claims measurement has killed. This tool finds
 * every place they still appear without a retraction marker beside them. It is a grep with
 * a memory — no captures, no browser, read-only, a second to run.
 *
 *   node tools/claimcheck.mjs            # list live sites, exit 0
 *   node tools/claimcheck.mjs --strict   # exit 1 if any site is unannotated (for gates)
 *   node tools/claimcheck.mjs --quiet    # sites only, no explanation blocks
 *
 * Disproved something an earlier agent asserted? Add it to tools/refuted.json in the same
 * commit as the disproof. That is what stops it coming back in two waves' time.
 */
import { readFileSync, globSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const quiet = argv.includes('--quiet');

const registry = JSON.parse(readFileSync(join(ROOT, 'tools/refuted.json'), 'utf8')).claims;
const FILES = [...globSync('reports/*.md', { cwd: ROOT }), ...globSync('docs/*.md', { cwd: ROOT })].sort();

const WINDOW_NEAR = 3;    // lines each side for the corroborating pattern
const WINDOW_CLEAR = 8;   // lines each side in which a retraction marker counts

const rx = (s) => (s ? new RegExp(s, 'i') : null);
let live = 0;

for (const c of registry) {
  const near = rx(c.near), also = rx(c.alsoNear), cleared = rx(c.cleared);
  const hits = [];

  for (const rel of FILES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!near.test(line)) return;
      const win = (n) => lines.slice(Math.max(0, i - n), i + n + 1).join('\n');
      if (also && !also.test(win(WINDOW_NEAR))) return;
      // A retraction counts if it is near the line OR in the section heading above it —
      // "## 19. ... TESTED AND FALSE" annotates everything under it.
      let heading = '';
      for (let h = i; h >= Math.max(0, i - 80); h--) {
        if (/^#{1,4}\s/.test(lines[h])) { heading = lines[h]; break; }
      }
      if (cleared && cleared.test(win(WINDOW_CLEAR) + '\n' + heading)) return;   // already annotated
      hits.push({ rel, ln: i + 1, text: line.trim().slice(0, 110) });
    });
  }

  if (!hits.length) continue;
  live += hits.length;
  console.error(`\nREFUTED CLAIM STILL LIVE — ${c.id}`);
  if (!quiet) {
    console.error(`  claim     : ${c.claim}`);
    console.error(`  refuted by: ${c.refutedBy}`);
    console.error(`  do instead: ${c.truth}`);
  }
  for (const h of hits) console.error(`  ${h.rel}:${h.ln}  ${h.text}`);
}

if (live === 0) console.log(`ok — ${registry.length} refuted claim(s) checked across ${FILES.length} documents, none left unannotated`);
else console.error(`\n${live} unannotated site(s) across ${registry.length} refuted claim(s). ` +
                   `Add a one-line retraction beside each, or correct the text.`);

process.exit(strict && live > 0 ? 1 : 0);
