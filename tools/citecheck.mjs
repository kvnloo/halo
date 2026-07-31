#!/usr/bin/env node
/**
 * citecheck — do the citations in reports/ and docs/ actually resolve?
 *
 * Reports are read as ground truth by every later agent and by the orchestrator, so a
 * citation that cannot be followed is worse than no citation: it looks like provenance
 * and is not.  Three concrete failures in this repo motivated this tool.
 *
 *  1. KNOWN_ISSUES 28 / reports/integrationH.md "check against git rather than taking it
 *     on faith":
 *
 *         $ for c in 865e972 76237b2 8ed94d7; do
 *             git show $c:src/render/passes/ssao.js | grep -c "ensureOpaqueDepth"
 *           done
 *         0  0  0
 *
 *     None of those three objects exist in this repository.  `git show` writes "fatal:"
 *     to stderr, grep reads an empty stream and prints 0 — the *exact* output the real
 *     experiment would produce.  The evidence is self-confirming: it cannot fail.
 *
 *     There is a SECOND, independent reason that line could never have measured anything,
 *     and it survives even with a valid SHA: this repo's shell is zsh, where the unbraced
 *     `$c:src/render/passes/ssao.js` is a parameter expansion followed by the `:s`
 *     substitution modifier.  Measured, with no rc file loaded:
 *
 *         $ zsh -f -c 'c=abc123def; echo "$c:src/render/x.js"'
 *         abc123def/x.js
 *
 *     Double quotes do NOT help — only `${c}:path` does.  So `git show` was handed
 *     `<sha>/passes/ssao.js`, which is neither a rev nor a path, and failed on every
 *     iteration regardless of which SHAs were named.
 *
 *     For the record, re-run against the wave commits that DO exist (Wave E 6a19370,
 *     F f25d7b9, G 8bceeb5, H f96fae6), braced and verified:
 *
 *         export function ensureOpaqueDepth   E:0  F:1  G:1  H:0   (ssao.js)
 *
 *     ssr.js imports and calls it at F and G too.  The claim it was used to support —
 *     "exists in no commit", so GTAO/SSR were dead through waveG-mvfix — is FALSE, and
 *     is registered in tools/refuted.json as `gtao-ssr-dead-through-waveG`.
 *
 *  2. reports/integrationG.md pins its numbers to "tree at time of measurement 76237b2",
 *     and reports/tonemap.md to "committed in fdaaa25".  Neither resolves, so no measured
 *     number in this project can be tied back to the source that produced it.
 *
 *  3. reports/blind.md — the 9-0 acceptance gate — argues from crops under shots/, which
 *     .gitignore excludes.  The frames a future wave would need to re-check the verdict
 *     are not in the repository.
 *
 * Read-only.  Runs no captures, starts no browser, touches nothing.
 *
 *   node tools/citecheck.mjs             # exit 1 if a cited git object is missing
 *   node tools/citecheck.mjs --quiet     # failures only
 *   node tools/citecheck.mjs --warn      # never exit non-zero (for informational runs)
 */
import { existsSync, readFileSync, globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const warnOnly = argv.includes('--warn');
// Citations into .gitignore'd shots/ are counted always, listed only on request: there are
// hundreds of them and they are a known, accepted property of the image-evidence workflow.
const showShots = argv.includes('--shots');

const FILES = [...globSync('reports/*.md', { cwd: ROOT }), ...globSync('docs/*.md', { cwd: ROOT })].sort();

// Paths under these roots are tracked; a citation into them should resolve on any clone.
const TRACKED_ROOTS = /^(src|tools|docs|reports|research|scores)\//;
// shots/ is .gitignore'd (except shots/preview).  Citations there resolve for whoever
// captured them and for nobody else.
const UNTRACKED_ROOTS = /^shots\//;

// `$c:src/render/passes/ssao.js` — unbraced parameter followed by ':' and a path.  In zsh
// (this repo's shell) that is the `:s` history modifier, quoted or not, so the command never
// reads the file it names.  `${c}:path` is fine and is not matched here.
const UNBRACED_SHELL_PATH = /\$[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_.\-/]*\//;

function gitHas(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

const shaCache = new Map();
const has = (s) => (shaCache.has(s) ? shaCache.get(s) : (shaCache.set(s, gitHas(s)), shaCache.get(s)));

let dangling = 0, missingPath = 0, untracked = 0;
const advised = new Set();   // one remediation block per offending line, not per dead SHA

for (const rel of FILES) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const ln = i + 1;

    // ---- git object citations -------------------------------------------------------
    // Only hex tokens that (a) contain a letter, so pure decimals like a triangle count
    // are skipped, and (b) are not embedded in a path/uuid/identifier.
    for (const m of line.matchAll(/(^|[^\w/.-])([0-9a-f]{7,40})(?![\w-])/g)) {
      const sha = m[2];
      if (!/[a-f]/.test(sha)) continue;              // 14057892 tris, 0046542 rad, ...
      // Content-digest lengths. A git abbreviation in this repo is 7-12 chars and a full
      // object id is 40; 16 / 32 / 64 are a truncated sha256, an md5 and a sha256. The
      // provenance stamps (scores/provenance.jsonl `poses`/`metrics.py`, the blind key
      // `keySha`) are 16-char, and quoting one in a report is exactly the behaviour this
      // project wants — it must not read as a broken citation.
      if (sha.length === 16 || sha.length === 32 || sha.length === 64) continue;
      // A CONTENT digest is not a git citation. `reports/posefit.md` pins the scorer by
      // md5 (`tools/_posefit_metrics.py, md5 0592ed3f`) precisely so its numbers stay
      // reproducible across a mid-experiment re-band — the best provenance practice in the
      // repo — and every one of those hashes was reported here as a DANGLING git object.
      // Five of the fourteen "dangling citations" this tool printed were that. A gate whose
      // loudest output punishes the one report doing it right teaches its reader to skip the
      // list (same lesson as META_LEDGER R1). Skip a hex token whose own line names it as a
      // digest; a real commit citation never does.
      // Lookback is one line only, and only backwards: a digest label precedes its value
      // ("...its md5 changed three times" / "(`a580fdc9` -> `92b2b50a` -> `0592ed3f`)").
      // Looking forward as well would let an unrelated later sentence mask a real citation.
      if (/\b(md5|sha1|sha-1|sha256|sha-256|digest|checksum|fingerprint|hash(ed)?)\b/i
        .test(`${lines[i - 1] || ''}\n${line}`)) continue;
      if (has(sha)) continue;
      // A doc that is *discussing* a dangling SHA (this file's own docs, KNOWN_ISSUES once
      // someone annotates §28) is not making a citation. Say so within three lines.
      const around = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      if (/dangling|does not exist|no longer (exist|resolve)|neither resolves|missing object|citecheck/i.test(around)) continue;
      dangling++;
      console.error(`DANGLING ${rel}:${ln}  git object '${sha}' does not exist in this repo`);
      // The command is often split over the next line or two (`for c in …` / `git show …`),
      // and one line usually names several dead SHAs — advise once, on the whole statement.
      const stmt = lines.slice(i, i + 3).join('\n');
      if (/git\s+(show|log|diff|checkout)/.test(stmt) && !advised.has(`${rel}:${ln}`)) {
        advised.add(`${rel}:${ln}`);
        console.error(`         this line is a reproduction command and it cannot fail: 'git show' writes`);
        console.error(`         'fatal:' to stderr, 'grep -c' reads the empty stream and prints 0 — byte-`);
        console.error(`         identical to a true negative. Verify the object first, so a dead SHA stops`);
        console.error(`         the run instead of quietly answering the question for you:`);
        console.error(`           git rev-parse --verify "\${c}^{commit}" >/dev/null || exit 1`);
        console.error(`           git show "\${c}:path/to/file.js" | grep -c pattern`);
        // `set -o pipefail` is NOT the fix and is deliberately not suggested: on a dead SHA
        // grep also exits 1, so the pipeline's status is the same as a true negative's.
        if (UNBRACED_SHELL_PATH.test(stmt)) {
          console.error(`         NOTE THE BRACES. This repo's shell is zsh, where "$c:path" — quoted or not —`);
          console.error(`         is a parameter expansion plus the ':s' modifier. Measured:`);
          console.error(`           zsh -f -c 'c=abc123def; echo "$c:src/render/x.js"'  ->  abc123def/x.js`);
          console.error(`         so git was handed '<sha>/render/x.js' and would have failed on a GOOD SHA too.`);
          console.error(`         Only \${c}:path survives. See docs/AGENT_BRIEF.md R9b.`);
        }
      }
      if (!quiet) console.error(`         ${line.trim().slice(0, 110)}`);
    }

    // ---- file path citations --------------------------------------------------------
    for (const m of line.matchAll(/`([A-Za-z0-9_.\-/]+\/[A-Za-z0-9_.\-/]+)`/g)) {
      const p = m[1];
      if (!TRACKED_ROOTS.test(p) && !UNTRACKED_ROOTS.test(p)) continue;
      if (/[*?]/.test(p)) continue;
      if (UNTRACKED_ROOTS.test(p)) {
        if (!p.startsWith('shots/preview')) {
          untracked++;
          if (showShots) console.error(`UNTRACKED ${rel}:${ln}  cites '${p}' — under .gitignore'd shots/, not reproducible from a clone`);
        }
        continue;
      }
      if (existsSync(join(ROOT, p))) continue;
      missingPath++;
      console.error(`NOPATH   ${rel}:${ln}  cites '${p}' which does not exist`);
    }
  });
}

const summary = `citecheck — ${FILES.length} documents: ${dangling} dangling git object(s), ` +
                `${missingPath} missing path(s), ${untracked} citation(s) into untracked shots/`;
if (dangling === 0 && missingPath === 0) {
  if (!quiet) console.log(`ok — ${summary}`);
} else {
  console.error(`\n${summary}`);
}

process.exit(warnOnly || (dangling === 0 && missingPath === 0) ? 0 : 1);
