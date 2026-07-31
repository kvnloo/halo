#!/usr/bin/env node
/**
 * registrycheck — does the disproof registry itself repeat a claim the registry disproved?
 *
 *   node tools/registrycheck.mjs          # list entries whose prose repeats another entry
 *   node tools/registrycheck.mjs --json
 *   node tools/registrycheck.mjs --strict # exit 1 on any hit (default is advisory, exit 0)
 *
 * WHY THIS EXISTS
 * ---------------
 * `tools/claimcheck.mjs` scans `reports/*.md` and `docs/*.md`. It does not scan
 * `tools/refuted.json` — and that file is not passive data: claimcheck PRINTS its
 * `claim` / `refutedBy` / `truth` fields verbatim as the authoritative explanation an agent
 * reads when a claim fires. It is the most-read prose in the trust chain and the only prose
 * nothing checks.
 *
 * LIVE HIT at the time of writing. The `fog-owns-desaturation` entry's `refutedBy` reads:
 *
 *     "reports/vegetation.md:49 is the primary measurement — `--skip volumetricFog`
 *      produced a BYTE-IDENTICAL PNG at ref_00720 (with `--skip bloom` as the control,
 *      proving the skip mechanism works), so the pass wrote no pixels at all"
 *
 * Every clause of that is refuted by a *different entry in the same file*,
 * `skip-flag-can-disable-a-pass`: `src/render/pipeline.js`'s `PASS_MANIFEST` never consults
 * `skip`, so `--skip volumetricFog` and its `--skip bloom` control both skipped nothing and
 * byte-identical was guaranteed. `docs/META_LEDGER.md` round 7 (C3) records exactly this and
 * corrected the ledger prose; the registry field was not corrected, so claimcheck still
 * teaches every agent the void experiment as "the primary measurement". A disproof that
 * stops at the document that wrote it is §19, and this is §19 inside the tool built to stop
 * §19.
 *
 * The conclusion `fog-owns-desaturation` reaches is NOT in question — §18 measured the real
 * cause (scene.js clearing the shared depth texture, sat_mean 55.66 -> 61.66) and stands on
 * its own. What is void is one piece of its cited evidence.
 *
 * Advisory by default, for the round-6 reason `claimcheck --strict` is not wired anywhere:
 * this reads prose and judges it by regex, and its failure mode is blocking an agent over a
 * sentence. Read-only, ~30 ms, no GPU, no browser, never edits the registry.
 *
 * Exit: 0 always, unless --strict and there is a hit (then 1) • 2 registrycheck broke
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');

const REG = join(ROOT, 'tools/refuted.json');
if (!existsSync(REG)) { console.error('registrycheck: tools/refuted.json not found'); process.exit(2); }

let claims;
try { claims = JSON.parse(readFileSync(REG, 'utf8')).claims; }
catch (e) { console.error(`registrycheck: tools/refuted.json does not parse — ${e.message}`); process.exit(2); }

const rx = (s) => { try { return s ? new RegExp(s, 'i') : null; } catch { return null; } };
/** The prose fields claimcheck prints back to an agent. These are the authority text. */
const FIELDS = ['claim', 'refutedBy', 'truth'];

const hits = [];
for (const target of claims) {
  for (const other of claims) {
    if (other.id === target.id) continue;                   // an entry states its own claim by design
    const near = rx(other.near), also = rx(other.alsoNear), cleared = rx(other.cleared);
    if (!near) continue;
    for (const f of FIELDS) {
      const text = target[f];
      if (typeof text !== 'string' || !text) continue;
      // An entry is allowed to NAME another entry's id — that is a cross-reference, not a repeat.
      if (text.includes(other.id)) continue;
      if (!near.test(text)) continue;
      if (also && !also.test(text)) continue;
      if (cleared && cleared.test(text)) continue;          // already annotated in place
      const m = near.exec(text);
      const at = Math.max(0, m.index - 60);
      hits.push({
        entry: target.id, field: f, repeats: other.id,
        excerpt: text.slice(at, m.index + 140).replace(/\s+/g, ' ').trim(),
      });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: hits.length === 0, claims: claims.length, hits }, null, 2));
} else if (!hits.length) {
  console.log(`ok — ${claims.length} registry entr(ies), none repeats another entry's refuted claim ` +
              `in its own authority text`);
} else {
  console.error(`tools/refuted.json — ${hits.length} field(s) rest on a claim this same registry refutes.\n` +
                `claimcheck prints these fields verbatim, so an agent is being taught the void evidence:\n`);
  for (const h of hits) {
    console.error(`  ${h.entry}.${h.field}  repeats  ${h.repeats}`);
    console.error(`      …${h.excerpt}…`);
    console.error(`      Fix: cite evidence that survives ${h.repeats}, or add the retraction inline ` +
                  `(its 'cleared' pattern, or the id '${h.repeats}').\n`);
  }
}

process.exit(strict && hits.length ? 1 : 0);
