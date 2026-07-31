# Meta ledger — process gates already installed

Anything listed here is **done**. Do not re-propose it. Each entry names the past failure it
would have caught, so a future auditor can judge whether it is still earning its place.

Everything here is additive: no measurement changed semantics, no `src/` file was touched,
and every gate has a one-flag escape hatch.

---

# INDEX — read this before proposing anything

*Written 2026-07-31 by the meta-audit review pass, over rounds 1–12. The round sections below
are the full evidence and stay verbatim; this index is the actionable summary.*

**Round numbers below repeat** (there are four "round 10"s, two each of 2, 5, 7, 11, 12)
because rounds ran concurrently under different lenses and each numbered itself. Round
numbers are **not** a chronology and **not** unique keys — cite the entry id (`G14`, `T4`,
`E2`, `V3`, `A12` …) or the file, never "round 10".

## A. GATED NOW

Verified end-to-end on the clean tree, 2026-07-31. "Blocks" means a non-zero exit stops a
commit, a push, or a measurement. Everything else prints and gets out of the way — by
design: on a fresh clone *not running* is the normal state for several of these, and a gate
that reddens a healthy tree gets deleted by the next person in a hurry.

| Instrument | Catches | Runs from | Blocks? | Clean-tree state today |
|---|---|---|---|---|
| `tools/parsecheck.mjs` | a `src/**.js` that does not parse; backticks inside `/* glsl */` templates (§20) | CI push, `preflight` #1 | **yes** (CI) | ok, 42 files |
| `tools/_posecheck.mjs` | a camera pose sunk under the terrain (§17.1) | CI push, `preflight` #2 | **yes** (CI) | ok, 28 poses |
| `tools/parsecheck-staged.mjs` | the same, on the **staged blob** — the working copy is routinely mid-write (§16) | `.githooks/pre-commit`, CI | **yes** (commit) | ok |
| `tools/stagedcheck.mjs` | staged `tools/*.mjs`, `tools/*.py`, `*.json`, `*.jsonl` — the instruments and the record, not just `src/` (G16) | `.githooks/pre-commit`, CI | **yes** (commit) | ok |
| `capture.mjs` integrity gate (G1) | scene missing a module / a failed `init()` / a pass that never loaded — three channels, exit 3 | every capture; `npm run selftest` in CI | **yes** | selftest ok, detects 3/3 |
| `capture.mjs` argv-whitespace fatal (E3) | `"--skip ocean"` as one token — a quoting bug that silently captures the default build | every capture, exit 2 | **yes** | n/a |
| `capture.mjs` stale-frame fatal (G14) | one `ref_NNNNN` written beside older `ref_` frames that `score.mjs` would average in at full `n` | every single-pose capture, exit 6 | **yes** | **fires correctly** (verified) |
| `capture.mjs` foreign-daemon fatal (G12/G13) | the machine-wide daemon serving a *different* checkout — a confident null result | every daemon capture, exit 5 | **yes** | roots match, silent |
| `capture.mjs` `--settle % 16` warning (E2) | an off-phase settle: TAA's converged still is periodic with period 16, worth up to 53 code values | every capture | no | silent at 48 |
| `capture.mjs` preflight-stamp NOTE (A12) | a capture taken against a tree preflight never gated | every capture | no | prints when stale |
| `capture.mjs` `daemonFallback` reason (G13) | the daemon path failing silently and falling back to ~1 GB standalone | every capture; written to `scores/provenance.jsonl` | no | daemon healthy |
| `tools/score.mjs` incomplete-run gate | a pose that failed to measure, or a null axis — a mean over a different set, exit 4 | every score | **yes** | n/a |
| `tools/score.mjs` `BAND_VERSION` assert | `metrics.py` re-bands without `score.mjs` following — every recorded score silently becomes a different quantity, exit 5 | every score | **yes** | in sync at v2 |
| `tools/historycheck.mjs` | malformed / duplicate-tag / dead-axis rows in `scores/history.jsonl` | CI | exit 1 only on a malformed row | ok |
| `tools/preflight.mjs` | 13 checks; `SKIP … THIS CHECK DID NOT RUN` + an `N/13 checks ran` coverage count (T4) | `precapture`/`prescore`, CI, by hand | hard checks only | **ok, 13/13 ran, 5 advisory** |
| `tools/advisory.mjs` (G15) | a guardrail that **crashed** looking like one that passed. `0 = ok · 1 = findings · ≥2 / signal / stack trace = BROKE` | CI | on BROKE only | ok; 2 checks report findings |
| `tools/reportgate.mjs` | report-side rules R7/R9 at the only machine gate every report passes | `.githooks/pre-commit` | no (`\|\| true`) | ok |

Reporting instruments, run by hand or via `advisory` — none of them block, all of them are
wired into `preflight` or `advisory` so nobody has to remember them:

`citecheck` (dangling SHAs/paths) · `claimcheck` + `tools/refuted.json` (a disproved claim
still standing) · `registrycheck` (the disproof registry against itself) · `provcheck`
(adjacent history rows share a pose set and an instrument) · `shotcheck` (a scored dir holds
one capture) · `gatecheck` (does `blind.mjs`'s refusal read a field `capture.mjs` emits) ·
`apicheck` (docs/API.md's "frozen" signatures exist in `src/`) · `refcheck` + `refstamp`
(ref/ shape, fingerprint, and whether the rebuild recipe works) · `roicheck` +
`tools/roi_notes.json` (that crop is not what it is named) · `contracts` +
`tools/contracts.json` (the sibling implementers of a contract you are about to fix one of) ·
`knobcheck` (`--config` keys that reach nothing; pass gates that cannot be turned off) ·
`ablate` (switch one pass off through `togglePass()`, not through a knob) · `nulltest`
(ALIVE verdicts with a control leg) · `axischeck` / `scalecheck` / `dupcheck` (the score
series) · `blindcheck` / `blindledger` / `tells` (the acceptance gate) · `shadercheck` (a
material that linked) · `pixelcheck` (exact-black / NaN) · `reportlint` · `postflight`.

**Non-zero on a clean tree today, all advisory, none of them new or broken:** `citecheck`
(10 dangling SHAs lost in the `a9c1e8a` history rewrite), `shotcheck` (`shots/latest` is a
mixture — see B4), `apicheck` (B3), `gatecheck` (B2), `axischeck`/`scalecheck` (the band
re-baseline, B6). `knobcheck`, `pixelcheck` and `blindledger` exit 2 with **no arguments** —
that is their usage line, not a failure; `npm run knobcheck` / `npm run pixelcheck` bare will
look red and is not.

## B. RECOMMENDED, NOT DONE — with enough detail to act

Ordered by how likely the gap is to produce a wrong number. Each is either a `src/` change
(owned by the rendering waves) or a file owned by a concurrent wave; none is a drive-by.

**B1. `--rescore` bypasses every capture-time gate.** `tools/score.mjs`'s `--rescore` path
prints `[score] rescoring existing PNGs in <dir> (no capture)` and goes straight to the
`readdirSync(/^ref_\d+\.png$/)` filter with nothing in between: no G14 stale-frame refusal
(it takes no capture), no preflight, no provenance row. `scores/rescore_latest.json` on disk
right now was written this way from a `shots/latest` holding frames 15 h apart, with `"n": 9`.
**NEEDS `tools/score.mjs`:** before that `readdirSync`, spawn `node tools/shotcheck.mjs
<outdir>` and refuse a `--rescore` over a directory holding more than one capture unless
`--allow-stale`; and write a provenance row for rescore runs so they can be tied to a pose
set at all.

**B2. `tools/blind.mjs`, two lines.** `gatecheck` reports both every run: (a) the refusal
gate reads `info.failedModules`, but `capture.mjs` only ever puts it at
`info.integrity.failedModules` — so "a blind test with a missing subsystem is not a fair
fight" has never once fired; (b) the `--score` tally loop never compares its count `n`
against `Object.keys(key.pairs).length`, so a judge who submits fewer picks than pairs gets a
clean row with nothing marking it partial. `gatecheck` goes silent the moment they land.

**B3. `sky.envTexture` / `sky.horizonColor` / `sky.needsEnvUpdate` do not exist.**
`docs/API.md:36` declares them frozen; the name appears nowhere in `src/world/sky.js`.
`src/render/env.js:724` *reads* `sky?.needsEnvUpdate` every frame — an optional-chained read
of a member that does not exist is permanently false and never throws, so the env-update
handshake has never run and nothing said so. **Either implement the member or correct
`docs/API.md`.** `apicheck` reports it every preflight until one of those happens.

**B4. `shots/latest` is a mixture and its number is quoted.** 9 frames spanning 57,184 s.
G14 stops the *next* one; it deletes nothing, because a stale frame is evidence. Whoever owns
that number: re-capture the set into a fresh tag, or annotate `rescore_latest` as
uncomparable. Any report quoting it is quoting an average across two builds.

**B5. Nobody has ever run the same build twice and recorded the run-to-run spread of any
axis.** `reports/metrics.md` §6.1's own words: until someone does, *no single-wave composite
delta under about 2 points should be believed — mine included*. Cost: two full scored runs of
one unchanged tree. This is the single cheapest thing that would make every wave's headline
number interpretable and it is still not on disk.

**B6. No row in `scores/history.jsonl` is at the current banding.** All 15 rows predate
`band_version`; the two that carry a `score_legacy` (`waveI-fitstand`, `waveI-handstand`) are
band **v1**, whose `structure` axis was `1 − MS_SSIM` — an axis won by rendering a flat grey
rectangle (`reports/metrics.md` §9). `score.mjs --history` now correctly shows an empty
`SCORE` column for every row. `ref/baseline.json` cannot be re-banded either, only
re-generated: it stores banded axes with no raw statistics. **This needs a metrics owner and
one clean re-baselining run.** Until then every "30.30" in `reports/` is on a scale nothing
currently produces (v2 measures the same pixels at ~17–18).

**B7. `score.mjs` runs no preflight on the path that writes `history.jsonl`.** Two lines —
spawn `preflight --quiet`, abort on exit 1. A12's NOTE reaches `score.mjs` only indirectly,
because it spawns `capture.mjs`.

**B8. `src/` changes, all with evidence, none with an owner.**
* `api.setConfig` validates nothing — a malformed call is swallowed and the A/B measures the
  shipped default. `if (typeof k !== 'string' || v === undefined) console.error('[config]
  ignored malformed setConfig(', k, ',', v, ') — did you pass an object instead of (k, v)?')`
  before the assignment. `capture.mjs`'s warning filter already surfaces it.
* Three pass gates cannot be turned off (`knobcheck --gates` reports them every run):
  `grain.js:358`, `motionBlur.js:575`, `sharpen.js:291` all write `(c.k ?? cfg.k) !== false`,
  and the harness cannot express boolean `false` — `--config grainEnabled=0` leaves the pass
  running and the A/B compared a frame with itself. Fix: `const on = !!(c.k ?? cfg.k)`.
* `src/core/Engine.js` after line 46: `renderer.debug.onShaderError = (gl, program, vs, fs)
  => { (globalThis.__HALO_SHADER_ERRORS__ ||= []).push({ program: gl.getProgramInfoLog(program),
  vs: gl.getShaderInfoLog(vs), fs: gl.getShaderInfoLog(fs) }); };` — `capture.mjs`'s
  `integrityReport()` then reads it as a fourth channel and a shader that fails to link
  becomes a hard exit instead of a string somebody greps for. Keep `tools/shadercheck.mjs`
  afterwards as the fallback for errors three.js reports outside that hook.
* `src/modules.js` `buildModules()` validates `--only`/`--skip` names against nothing, and
  drops a module whose `create()` returns falsy via `if (inst)` with no `else` recording it —
  a hole in integrity channel one.
* `applyWorldMaterial` is stomped by ten callers, four of which carry a local re-install and
  a comment explaining it (`props.js:618`, `vegetation.js:414-426`, `terrain.js:1481-1504`,
  `rocks.js:1735`). Chain it once in `lighting.js:83`'s `registerMaterial` or
  `materialCommon.js:126-127`; every local workaround can then be deleted. Registered as the
  `world-material-hook` contract in `tools/contracts.json`.

**B9. Report-side edits, one line each, owned by their authors.**
* `reports/characters.md`, `reports/depthfx.md`, `reports/postfx.md`: *"the `weapon` region is
  a screen rectangle that is ~65% sand (`reports/weapons.md:279`); this number is not a
  viewmodel measurement."*
* `reports/blind.md` §0: *"CORRECTED: the split was 3/6, not 4/5 — measured from the key in
  `scores/blind_ledger.jsonl`. The conclusion is unaffected: an always-A judge scores 6/9."*
* `docs/KNOWN_ISSUES.md` §28 and `reports/integrationH.md` §7 still assert a refuted claim
  inline; `claimcheck` flags both. The exact replacement text is in R5-B.
* `tools/refuted.json`'s `fog-owns-desaturation.refutedBy` cites the `--skip volumetricFog`
  experiment that the sibling entry `skip-flag-can-disable-a-pass` refutes. `claimcheck`
  prints that prose to agents as authority. Cite §18's depth-clear evidence instead.

**B10. The acceptance gate is 4 scored runs behind.** One human blind judgement in fourteen
scored runs; `waveI-prefit/posefit/fitstand/handstand` are all unjudged.
`node tools/blind.mjs --capture --contact`, then `--score`. `docs/LOOP.md` §5.7: *the blind
test is the score; everything in `history.jsonl` is a proxy picked for being cheap.*

**B11. Eight guardrails exist only in this working tree.** `preflight`'s
`guardrails-committed` warns every run. `.githooks/pre-commit` and
`.github/workflows/preflight.yml` are **tracked and modified** and both invoke
`tools/stagedcheck.mjs` and `tools/advisory.mjs`, which are **untracked** — commit the hook
and the workflow without the tools and every commit is refused with `MODULE_NOT_FOUND` and
CI is red on step 3 for everyone. `git add -- tools/stagedcheck.mjs tools/advisory.mjs
tools/gatecheck.mjs tools/apicheck.mjs tools/refcheck.mjs tools/registrycheck.mjs
tools/roicheck.mjs tools/roi_notes.json tools/contracts.mjs tools/contracts.json
tools/blindcheck.mjs tools/reportgate.mjs` in the same commit.

## C. REJECTED / DELIBERATELY NOT GATED — do not re-propose

**Already shipped; a proposal to build it is a proposal to build it twice.** The capture
integrity gate (G1) · the provenance stamp (G2) · `preflight` as one command (G3) · the
staged-blob pre-commit gate (G4/G16) · the CI workflow (G5) · dead-axis detection, both
flavours — `historycheck` (exact-constancy over the last 5 rows of `history.jsonl`) and
`axischeck` (span over all runs from `scores/<tag>.json`); they fail on different things,
**keep both** · `citecheck` and its dangling-provenance remediation · the refuted-claim
registry and its propagation annotations (T2/T2b) · `registrycheck` (the registry against
itself) · `shadercheck` · `ablate` (the inert-pass A/B) · `pixelcheck` (the exact-black /
NaN scan) · `nulltest`'s control leg (E1) · the `--settle % 16` warning (E2) · the argv
whitespace fatal (E3) · `roicheck` (E4) · the `world-material-hook` sibling list (E5) · the
preflight-bypass NOTE (A12) · `docs/AGENT_BRIEF.md`'s instruction set · the
`docs/RESEARCH.md:7` correction · `capture.mjs` arg hygiene · `reportlint` provenance.

**Evidence did not survive checking.** `geometry-owner-misattributed` — the per-module
triangle breakdown at `ref_02220` that carried the argument does not reproduce and is
structurally impossible to produce the way it was described. `warning-filter-drops-info` —
accurate but already logged verbatim as round-3 S2, same two files, near-identical regex.

**Deliberately not gated, and the reason is not laziness:**
* **`--settle` welded to the world clock (§26)** and **re-banding the `grade` axis (§15)**:
  both change the meaning of every number already recorded. They need an owner and one clean
  re-baselining run. `historycheck`/`axischeck` make the deadness visible instead. (See B6 —
  this debt has now come due.)
* **`claimcheck`/`citecheck` do not read `research/`.** Measured: widening the glob surfaces
  one genuine dangling commit and **10 false positives**, all upstream paths (three.js,
  FSR2) that `TRACKED_ROOTS`'s `^src/` cannot tell from a real citation. Needs an
  upstream-path guard first.
* **`preflight` is not a hard refusal at capture time.** It costs ~1.7 s and `capture.mjs` is
  spawned in loops by `knobcheck`, `nulltest`, `ablate` and `previewsheet`. It needs a
  per-tree cache keyed on the `src/` content hash before it can be a gate.
* **`warnings[]` stays non-fatal.** Benign (a 404, "Multiple instances of Three.js") and real
  are genuinely mixed in there; someone must separate them before any of it can exit non-zero.
* **Contracts are hand-written, never inferred.** Automatic inference would silently mis-scope
  a pattern with nobody around to notice; a hand-written entry's mistake is visible the first
  time a human reads its output.
* **`postflight --strict` is wired but off.** Turn it on one wave from now — when a wave's
  reports were all written under a brief that actually contained R2b — not retroactively.
* **Scratch-copy work:** `shots/` is 8.5 GB and `/tmp` is a 7.8 GB tmpfs. Copy
  `src tools docs package.json vite.config.js index.html` only — 2.9 MB — and set
  `HALO_NO_DAEMON=1`, or the daemon answers from the *other* tree.

## D. Verification pass — 2026-07-31, after round 12

Every gate above was run on the clean tree. All hard gates green: `parsecheck` (42 files),
`_posecheck` (28 poses, 0 FAIL), `parsecheck-staged`, `stagedcheck`, `.githooks/pre-commit`
end-to-end (exit 0), `npm run selftest` (detects 3/3 injected failures, exit 0),
`preflight` (13/13 ran, 5 advisory, exit 0), `historycheck`, `advisory` (5/5 produced a
result, exit 0). `node tools/capture.mjs --pose ref_00000 --settle 8` → `ok:true`,
`via:"daemon"`, all three integrity channels empty, exit 0. G14 fire-tested in a throwaway
`shots/_metaverify` (exit 6, correct message). T4 fire-tested in a scratch copy with
`_posecheck.mjs`/`scalecheck.mjs` deleted and `provcheck.mjs` replaced by a `throw`: three
`SKIP … THIS CHECK DID NOT RUN` lines, `[10/13 checks ran]`, and the crashed `provcheck` no
longer manufactures the reassuring `ok provenance` line. **No gate was reverted — nothing
regressed.**

### One defect found and fixed in this pass — `tools/advisory.mjs`

`advisory.mjs` was invoking two of its five jobs as `citecheck --warn` and `shotcheck
--warn`. Those flags force the tool to exit 0, which collapses `advisory.mjs`'s own
`findings (advisory)` state into `ok` — so a run printing ten `DANGLING` citations and
`FAIL shots/latest — 9 frames span 57184s; this is not one capture` summarised them as
`ok  node tools/citecheck.mjs --warn` / `ok  node tools/shotcheck.mjs --warn`, and the CI
step was green with the word "ok" printed over two live findings. That is the exact
green-line-over-a-hole this wrapper was built to remove from `|| true` (G15) and that T4
removed from `preflight` — rebuilt one layer in, inside the tool that exists to prevent it.
The `--warn` flags were redundant as well as lossy: `advisory.mjs` only ever reddens on
**BROKE**, never on findings.

Fixed: both jobs now run in their native exit mode, and the final line names the count.
Summary now reads `findings  node tools/citecheck.mjs` / `findings  node
tools/shotcheck.mjs` and `advisory ok — 5 check(s) produced a result; 2 reported FINDINGS`.
Re-verified all three states: clean → `ok`, findings → `findings` (exit 0, CI stays green),
injected `throw` → `BROKE — uncaught exception`, exit 1.

**Generalisation for the next round:** `--warn`/`--quiet`/`|| true` on a check that is
*already* inside an advisory wrapper does not make it safer, it makes it unreadable. A
wrapper that classifies by exit code must be given the exit code.

---

## Installed 2026-07-31 — round 1 (lens: gates)

### G1. `tools/capture.mjs` fails non-zero when the scene is incomplete
**Files:** `tools/capture.mjs`, `tools/captured.mjs`
Three integrity channels existed and none was checked by any caller: `__HALO_MISSING__`
(import/`create()` failure), `stats.failedModules` (`init()` threw), `__HALO_MISSING_PASSES__`
(post pass failed to load — this one was not even returned by the daemon). Capture printed a
stderr note for the first, ignored the other two, and exited 0 with `"ok": true`.

Would have caught: §20 (ocean.js + rocks.js dead across Waves F and G, both waves scored
against a scene with no ocean), §11 (`physics` threw in `init()` and was dead in *every*
capture and *every* score on record), §19 (a pass that stopped *loading* misdiagnosed as a
stale-code daemon bug, shipping a workaround that cost a vite + Chrome per agent).

`score.mjs` already aborts on a non-zero capture, so this closes the loop without touching it.
Escape hatch: `--allow-missing` / `HALO_ALLOW_MISSING=1`. Exit code 3.

### G2. Provenance stamp on every capture
**Files:** `tools/capture.mjs` (writes `<outdir>/_capture.json` **and** appends
`scores/provenance.jsonl`)
Records git SHA/branch, dirty + recently-written `src/` files, sha256 of `src/world/poses.js`,
sha256 of `capture.mjs`/`score.mjs`/`metrics.py`, all capture options including `settle`, and
`via: daemon | standalone`. Join key is the outdir, which is `shots/<tag>` for a scored run.

Would have caught: §3 / `ba09973` (poses are refittable and a refit invalidates every recorded
score, with no stamp saying which pose table produced a number), §26 (`waveG` vs
`waveG-settle96` — same code, −0.52 from `--settle` alone, and `--settle` is recorded
nowhere), §16 (six `src/` files rewritten *during* captures), and "a capture that silently
fell back to a different code path" (`viaDaemon()` swallows every error and falls through to
standalone; the standalone path never said so).

Pure stamp. Never fails a capture; changes no measurement.

### G3. `tools/preflight.mjs` — the one command
**Files:** `tools/preflight.mjs`, `package.json` (`preflight`, `precapture`, `prescore`)
Five checks that all already existed and were all attached to nothing: parsecheck (hard),
`_posecheck` (hard), reference-keyframe coverage (soft), `src/` quiescence per §16 (soft),
wedged-daemon detection per §27 (soft). ~2.5 s, no GPU. Wired as npm `pre` hooks so
`npm run capture` and `npm run score` cannot skip it.

### G4. `.githooks/pre-commit` — staged blobs must parse
**Files:** `.githooks/pre-commit`, `tools/parsecheck-staged.mjs`, `package.json` (`prepare`),
`git config core.hooksPath .githooks`
Checks `git show :<path>` — the bytes about to become a commit — not the working tree, which
is never quiescent here. Catches the §20 GLSL-backtick hazard and the
`tools/checkpoint.md` hazard ("an agent killed mid-edit can leave a file that does not parse
... it took the whole build down twice here").
Escape hatch: `git commit --no-verify`, which is the correct move for a salvage commit like
`2651d8c`. Uninstall: `git config --unset core.hooksPath`.

### G5. `.github/workflows/preflight.yml` — CPU-only CI
**Files:** `.github/workflows/preflight.yml`
The repo went public (`a9c1e8a`, `bf15ef7`) and nothing has ever run on a push. Runs
parsecheck, posecheck and preflight without a GPU, a browser or `ref/`. Turns "§20 discovered
by a critic two waves later" into a red mark on the commit that introduced it.

### G6. `tools/historycheck.mjs` — dead-axis detector
**Files:** `tools/historycheck.mjs`
Flags any score axis that has been constant across the last 5 runs, plus rows scored over
different pose counts and duplicate run tags.
Would have caught: §15 — `grade` scored 0.00 in **every run ever recorded** including runs
where it genuinely improved (`hist` 0.889 → 0.802 at Wave E), for nine runs, and was found by
a human reading the column. Reports only; it deliberately does not re-band anything, because
re-banding changes what every historical number means. Already surfaced a live one: the tag
`latest` appears twice in `history.jsonl`, so the `scores/latest.json` behind the earlier row
was overwritten and its per-pose detail is gone.

---

## Installed 2026-07-31 — round 2 (lens: recurrence)

Round 1 gated the failures where *something failed to load*. These three cover the failures
where **everything loaded and the frame was still not what anyone thought it was** — which is
the shape of §28, §21 and §24, none of which any integrity gate can see.

### G7. `tools/ablate.mjs` — switch one thing off, measure what changed
**Files:** `tools/ablate.mjs` (new), uses `tools/pixelcheck.py --diff`
One page load, `__HALO__.togglePass()` per variant, reports image delta + triangle/draw delta
against baseline and **flags any target that is byte-identical when removed as `INERT`**.

Would have caught: **§28** — `ssao` and `ssr` early-out on `d >= 1.0`, which under §18 was true
of every world pixel, so both rendered nothing while `aoStrength`, `aoRadius`, `aoPower` and
`ssrStrength` were tuned against them. Nothing failed to load, so G1 would not have fired;
`ssao_off` producing a byte-identical frame is the only signature there was. **§21** — `dof`
was a shipped no-op for two waves, same signature.

> **CORRECTION (round 5).** This paragraph originally read "rendered nothing through Waves E,
> F **and G**", repeating §28's conclusion. That span is wrong and the correction is measured:
> `export function ensureOpaqueDepth` in `src/render/passes/ssao.js` is **E:0 F:1 G:1 H:0**
> (`6a19370`, `f25d7b9`, `8bceeb5`, `f96fae6`), and `ssr.js` imports and calls it at F and G.
> Registered as `gtao-ssr-dead-through-waveG` in `tools/refuted.json`; see round 5 below. The
> *value* of G7 is unchanged — an INERT signature is still the only cheap way to see this —
> only the size of the window it would have covered.

Also makes the measurement that §23 (Wave F), §25 (Wave G) and §29b (Wave H) each named as "the
single highest-value measurement nobody has taken" — the `--skip rocks` / `--skip props` A/B,
deferred four waves — one command. It reports cost in triangles and draw calls only, never in
ms, per §29/§29b. Replaces five hand-rolled harnesses (`_blackab`, `_fogab`, `_ssaocost`,
`_chab.sh`, `_wpnab.sh`) that each hard-coded one pose and one target list.

Refuses to run if `src/` was written in the last 10 minutes (§16, the stated reason the §23 A/B
never ran); `--allow-churn` overrides. Exit 1 on INERT or un-toggleable target, 3 on churn,
4 on an incomplete scene.

### G8. `tools/pixelcheck.py` — exact-black / NaN scan
**Files:** `tools/pixelcheck.py` (new)
Counts exact `rgb(0,0,0)` and `rgb(255,255,255)` pixels per frame with bounding boxes; exits
non-zero over a threshold (default: any exact black).

Would have caught: **§24** — `taa` writes NaN/Inf as exact black over the ocean at
`shot_sky_ring` (7,978 px at Wave F, 7,934 at Wave G) and in Wave G **leaked into two more
poses**, `ref_00000` (17 px) and `shot_shoreline` (6 px). That spread was found by a human
re-counting pixels in a preview sheet. 0.385% of a frame moves no aggregate statistic, so
`score.mjs` structurally cannot see it. Still live: a fresh capture of `ref_00000` today has
4–5 exact-black px at `y635-639 x882-895`. Note §24's finding that film grain dithers about
half of them off exact zero, so any count is a ~2x lower bound.

Also provides `--diff`, the ablation delta table G7 prints.

**Native captures only (added round 4).** The scan skips any image not at `--res`
(default `1920x1080`), printing it as `skipped (not a capture: 2880x586)`. This is the domain
of the metric, not cosmetic filtering: **exact zero does not survive resampling.** Measured on
the live `ref_00000` residue — 5 exact-black px at native resolution becomes **0 px** when the
frame is downscaled to 0.75x or 0.5x. A montage therefore cannot produce a true positive and
reliably produces false ones: `shots/preview/00_sky_progress.png` (2880x586) has its label
strips drawn at exact black and scored **124,149 px** in a `y0-45` full-width band — 15x the
real §24 defect, and the loudest line in the report. That is how a gate gets ignored.

* Turn the filter off: `--res any`. Change capture resolution: `--res 2560x1440`.
* If the filter leaves **nothing** scannable, that is exit **2** with an explanation, not a
  pass — otherwise a resolution change would silently make this gate inert.
* Exit codes: 1 = over threshold, 2 = nothing scanned, 0 = clean.
* `--diff` is unaffected (explicit files, no filter), so G7 `ablate.mjs` is untouched.

`tools/pixelcheck.py shots/preview` **exits 1 today** — 5 exact-black px in the stored
`ref_00000.png` at `y635-639 x882-895`, the same band Wave G recorded. Silence it for a known
residue with `--max-black 8`; do not silence it by deleting the tool. But see R2 below before
concluding anything about whether that residue is still being produced.

### G9. `tools/axischeck.mjs` — span-based dead-axis check + the raw series
**Files:** `tools/axischeck.mjs` (new)
Complements G6 rather than repeating it. G6 tests *exact constancy over the last 5 history
rows*; on today's data that fires on nothing, because `grade` reads 0, 0, 0, 1.40, 1.40 and
`structure` reads 4.43, 4.39, 4.43, 3.42, 3.42 — neither is constant and **both are dead**.
This measures span across every scored run, excluding the score-0 empty baseline (leaving it in
hands every axis a free span equal to its first real value, which is how a dead axis hides).
It flags `grade` (§15, known) **and `structure`, which no section of KNOWN_ISSUES mentions**:
1.71 points of a 100-point axis across ten runs while the composite went 22.24 → 30.30. Two of
six axes carrying no gradient is a third of the objective function.

It also reconstructs `raw` (ssim, ms_ssim, hist, lpips, lap_ratio, edge_ratio) from the
per-wave `scores/<tag>.json` files, because `history.jsonl` keeps only the banded axes — the
longitudinal record retains exactly the numbers §15 calls dead and discards the ones it says to
read instead. Reports only; re-bands nothing.

---

## Known and deliberately NOT gated

* **`--settle` is welded to the world clock (§26).** Fixing it re-baselines every historical
  score. It needs an owner and one clean re-baselining run; it is not a drive-by, and a gate
  cannot substitute for the decision.
* **Re-banding the `grade` axis (§15).** Same reason — it changes the meaning of every number
  already recorded. G6 makes the deadness visible instead.
* **`src/` changes of any kind.** Out of scope for a process audit; see the recommendations
  in the round-1 findings for what a rendering wave should pick up.

---

## Installed 2026-07-31 — round 2 (lens: trust)

Round 1 gated the *machine* (does the tree parse, is the scene complete, what produced this
number). Round 2 gates the *written record*, which is the other half of the trust chain:
reports are read as ground truth by every later wave, and two of them were confidently wrong.

### T1. `tools/citecheck.mjs` — cited git objects and paths must resolve
**Files:** `tools/citecheck.mjs`, `package.json` (`citecheck`), `.github/workflows/preflight.yml`
Scans `reports/*.md` + `docs/*.md`, resolves every hex token that looks like a commit against
`git cat-file`, and existence-checks every backticked repo path. Currently: **9 dangling
citations across 5 sites**, 0 bad paths.

Would have caught: KNOWN_ISSUES §28 / `reports/integrationH.md` §7, whose evidence that
GTAO+SSR were dead in Waves E–G is a loop over three commits — none of which exists in this
repo, i.e. all three are dangling — running `git show $c:src/render/passes/ssao.js | grep -c
ensureOpaqueDepth` and reporting `0 0 0`. `git show` fails to stderr and `grep -c` prints `0`
on an empty stream, which is exactly what a true negative prints. It could not fail. Also:
`reports/integrationG.md` pins its numbers to tree `76237b2` and `reports/tonemap.md` to
commit `fdaaa25` — neither resolves, so no measured number can be tied to its source.
Advisory-only in CI (`--warn`); exits 1 when run directly.

*Round 5 amended this entry twice over: the §28 loop had a **second** unfailable defect (zsh
quoting — see R5-A below), and its conclusion is not merely unsupported but false. The
counts, braced and verified, are E:0 F:1 G:1 H:0.*

### T2. `tools/refuted.json` + `tools/claimcheck.mjs` — a disproved claim cannot quietly stand
**Files:** `tools/refuted.json`, `tools/claimcheck.mjs`, `package.json` (`claimcheck`),
`docs/AGENT_BRIEF.md` (R9b)
A registry of claims measurement has killed, with a regex per claim; claimcheck lists every
site that repeats one without a retraction marker within 8 lines or in its section heading.
Seeded with three, 8 live sites at the time of writing — **now 2, see T2b**, which landed the
retractions and fixed three defects in the registry seeded here.

Would have caught: §19 — `reports/fog.md`'s `HALO_NO_DAEMON=1` instruction was believed for
two waves and had already spread to `reports/tonemap.md` §1 (the measurement used to close
§9); only fog.md carries the retraction. §18 vs §8 — the "it is `volumetricFog.js`" story is
still live in `docs/RESEARCH.md`, `reports/terrain.md` §2 and §8's own heading.

### T3. `tools/refstamp.mjs` + `tools/ref_manifest.json` — fingerprint the ground truth
**Files:** `tools/refstamp.mjs`, `tools/ref_manifest.json`, `package.json` (`refstamp`)
sha256 (216 files: keyframes, ROI crops, detail crops, `roi_signatures.json`) of the reference
material every score is measured against. `--verify` exits 1 on drift, in ~2 s. Records hashes
only — nothing licensed is redistributed.

Would have caught: nothing yet, and that is the point. `ref/` is gitignored, was extracted by
hand, and per the README "no script survives" for rebuilding it; the README's own ffmpeg line
numbers keyframes by source pts. Round 1's G2 stamps `poses.js` and the tools but not the
reference. Re-extract on any other machine and every delta in `scores/history.jsonl`,
`docs/TARGETS.md` and 26 reports silently changes meaning with nothing to say so.

### T4. Named wrong claim, not fixable from here — **SUPERSEDED by T2b, see below**
> The ownership argument below does not hold for a one-sentence factual correction in a
> shared doc, and R9b — the project's own rule — requires it. `docs/RESEARCH.md` now carries
> the correction. Only `docs/KNOWN_ISSUES.md` §8 remains; paste-ready text is in T2c.

`docs/RESEARCH.md` opens its case for research-before-invention with: "`volumetricFog.js` ...
shipped an additive near-field in-scatter that crushed whole-scene saturation to 43% of target
— the single largest visual defect in the project." That attribution was disproved twice:
KNOWN_ISSUES §18 (the cause was `scene.js` clearing the depth texture shared with the
G-buffer; fixing it moved `sat_mean` 55.66 → 61.66) and `reports/vegetation.md`
(`--skip volumetricFog` produced a **byte-identical** PNG — the pass wrote no pixels at all).
> **CORRECTION (round 7).** That second disproof does not hold either: `--skip` reaches
> only `src/modules.js`'s module manifest, never `PASS_MANIFEST`, so the arm **skipped
> nothing** and byte-identical was the only possible outcome. See `skip-flag-can-disable-a-pass`
> in `tools/refuted.json`. The *lesson* — the example is the wrong file — is unaffected; §18
> is still the measured cause. What is void is the evidence, not the conclusion.
`docs/RESEARCH.md` and `docs/KNOWN_ISSUES.md` §8 are owned by other waves; T2 flags both
until an owner corrects them. The *lesson* RESEARCH.md draws is still right; only the example
is wrong, and it is one sentence.

### T5. `tools/blindledger.mjs` + `scores/blind_ledger.jsonl` — the acceptance gate becomes auditable
**Files:** `tools/blindledger.mjs`, `scores/blind_ledger.jsonl`
The blind A/B is the project's acceptance gate, and every artefact that made its verdict
checkable was transient: the answer key sits in a session-scoped `/tmp` scratchpad, the sheets
under gitignored `shots/`, the picks in a scratchpad file. Only the prose survives.

The Wave H run has now been recorded from the key while it still existed. Two results:
**the 9-0 tally is correct**, verified pair by pair (`render wins 0/9`); and
`reports/blind.md` §0's positional-bias guard — "the randomiser put our render on side A in
4 pairs and side B in 5" — **is wrong**: it was 3 and 6. The conclusion is unaffected (a
judge who always answered "A" would have scored 6/9, not 9/9), but the guard paragraph was
written from memory rather than from the key, in the one report whose job is to be
unimpeachable. `tools/blind.mjs` was not modified; the ledger is written beside it.

---

## Installed 2026-07-31 — round 3 (lens: silence)

G1 gates *loading*. G7 (`ablate.mjs`) gates *contribution*, through `__HALO__.togglePass()`.
Neither touches `ctx.config`, which is the instrument almost every A/B in this project is
actually made with — and which accepts anything, silently.

### S1. `tools/knobcheck.mjs` — a `--config` knob that reaches nothing
**Files:** `tools/knobcheck.mjs` (new). Read-only w.r.t. `src/`; uses only flags
`capture.mjs` already supports.

`api.setConfig = (k, v) => { engine.ctx.config[k] = v; }` accepts any key, stores it, and
reports success. Nothing reads it, the frame does not change, and the arm comes out
byte-identical to the baseline — which is the same signature as a dead pass, so the
conclusion lands on the renderer instead of on the typo.

Four modes, three of them static and instant:

* `--config k=v,…` — validate keys against every config read in `src/` **before** spending a
  capture. Rejects a key nothing reads, and rejects a `k=0` against a gate the harness
  cannot set (below).
* `--gates` — classifies every `*Enabled` pass switch. **Live finding: 3 of 7 are
  un-turn-off-able from `--config`.** `grainEnabled`, `mbEnabled` and `sharpenEnabled` are
  written `(c.k ?? cfg.k) !== false`; `--config` sends the *number* 0 or the *string*
  `'false'` and can never send the boolean `false`, so `0 !== false` is true and the pass
  stays on. Any config A/B ever run on those three compared a frame with itself.
* `--audit` — every `--config` recipe written down in `tools/`, `docs/` and `reports/`,
  checked against what `src/` reads. **Live finding: `reports/depth.md:361` still documents
  `--config aoLegacyDepth=1`**, a knob `ssao.js` deleted ("they selected between two
  byte-identical textures and meant nothing"). Re-running that line today silently measures
  the shipped build.
* `--ab k=v1,k=v2` — two captures plus a control arm, byte-compared. Byte-identical across
  arms means the knob does not reach the image (KNOWN_ISSUES §9's `exposure` pin, which
  re-measures as **alive** today: three distinct frames at `ref_00000`).

Would have caught: `reports/depth.md` §7 — `tools/_ssprobe.mjs` called `H.setConfig(obj)`
with an object, setting `config['[object Object]'] = undefined` and "returning quietly", so
**every `_ssprobe --config` run documented in `reports/screenspace.md` §8 measured the
default configuration**; and the same report's "my first `--config vmLegacyDepth=1` run
returned the *fixed* numbers and looked like the A/B knob was dead."

### S2. Recommendations for a rendering wave (NOT applied — `src/` is owned elsewhere)
* `src/render/passes/{grain,motionBlur,sharpen}.js`: replace `!== false` with a falsiness
  test so `0` means off, like every other knob in the build. One line each; makes 3 more
  passes A/B-able from the harness.
* `src/main.js` `api.setConfig`: warn on a non-string key or an `undefined` value. That one
  line turns the `_ssprobe` object-argument bug from a report's worth of null measurements
  into an immediate console error.
* `src/modules.js` `buildModules`: an unknown `--only`/`--skip` name is silently ignored, so
  `--skip rocsk` skips nothing and reads exactly like "rocks contributes nothing" — and
  `--skip` is how §23's four-waves-deferred rocks/props A/B is meant to be run. Push unknown
  names into `missing[]`, where G1's integrity gate already fails the capture. Same function:
  a module whose `create()` returns falsy is dropped by `if (inst)` without being recorded in
  `missing[]` — a hole in G1's first channel.
* `tools/capture.mjs` / `tools/captured.mjs` warning filters (`/warn|error|404|THREE/i` and
  `/warn|error|THREE|Shader/i`) drop `console.info`. §21's `[dof] world path disabled: …`
  printed on **every capture for two waves** and matched neither. Add
  `disabled|not loaded|no-op|fallback|NaN|feedback loop`. Not applied here only because a
  concurrent wave was editing both files during this audit.

---

## Installed 2026-07-31 — round 4 (lens: the gate nobody trusts)

### R1. `tools/pixelcheck.py` — restrict the NaN scan to native captures
**Files:** `tools/pixelcheck.py` (edited; new `--res`). No `src/` change, no measurement
semantics changed, no CI/hook wiring — this stays hand-run, which is what makes it safe.

**What it catches.** Unchanged from G8: §24's NaN/Inf-to-framebuffer corruption, which
`score.mjs` structurally cannot see (0.385% of a frame moves no aggregate statistic) and
which spread to two extra poses undetected for two waves until a human re-read a contact
sheet cell by cell.

**What was wrong with it.** The gate's own loudest output was a false positive. Scanning
`shots/preview` reported `00_sky_progress.png` at **124,149** exact-black px — its label
strips — versus **5** px for the genuine `ref_00000` residue. Any checklist built on that
output teaches its reader to ignore the top line, and the 5-px line is the one that matters.

**Why the fix is a correctness fix, not a mute button.** Exact zero does not survive
resampling. Measured: the real 5-px `ref_00000` residue drops to **0 px** at 0.75x and 0.5x
downscale; in a synthetic sheet, an injected 7,610-px defect survived downscaling as **1 px**
against 66,242 px of label-strip chrome. A montage can only ever yield false positives. So
the scan now runs only on images at `--res` (default `1920x1080`) and lists the rest as
`skipped (not a capture: WxH)`.

This was preferred over the alternative `--exclude 00_*,*sheet*,preview.png`: a name
blacklist is evaded by the next sheet someone names differently, and it encodes no reason.
The resolution check is a whitelist grounded in why the metric works, and it self-maintains.

**How to run it**
```
.venv/bin/python tools/pixelcheck.py shots/preview          # scan a dir
.venv/bin/python tools/pixelcheck.py shots/latest/*.png     # or explicit files
```
Exit 1 = a frame over `--max-black` (default 0) / `--max-white`; exit 2 = nothing scannable;
exit 0 = clean. It only reads images.

**Proof it fires** (synthetic fixtures under `/tmp`, never in the repo):

| test | input | result |
|---|---|---|
| clean | 3 grain-dithered frames, no exact zero | exit **0** |
| §24 scale | 7,610 px injected at `y902-1035 x357-956` | exit **1**, bbox reported *identical to §24's* |
| Wave-G leak scale | 11 px and 6 px in separate frames | exit **1**, both flagged |
| sheets only | one 1440x405 montage | exit **2**, "scanned NONE", not a silent pass |
| `--res any` | same montage | exit **1** — old behaviour recoverable |
| `--max-black 20` / `8` on the 11-px leak | — | exit **0** / **1** |
| `--diff` (G7 contract) | 4 files | exit **0**, table unchanged |

**How to turn it off if it becomes a nuisance** — in increasing order of bluntness:
1. `--max-black N` to tolerate a known residue (e.g. `--max-black 8` for today's `ref_00000`).
2. `--res any` to drop the native-capture filter, or `--res WxH` if capture resolution moved.
3. Just stop running it. Nothing invokes it automatically — no hook, no CI, no capture-time
   cost. `tools/ablate.mjs` uses only `--diff`, which ignores every flag above, so ablation
   keeps working regardless.

### Noticed, not done (round 4)
* `shots/preview/00_sky_progress.png` is stale: nothing under `tools/` generates it any more
  (`grep -rl sky_progress tools/` is empty). It is now skipped rather than scanned, so it is
  harmless — but it is also unowned output sitting in a reviewed directory. Left in place;
  deleting existing artifacts is out of scope.
* `tools/preview.mjs:76` draws label strips at `(16,16,16)`, deliberately off exact black, and
  `preview.png` scans clean. Whatever produced `00_sky_progress.png` did not follow that
  convention. If sheet generation is ever reinstated, reuse the `(16,16,16)` strip.
### R2. §24's status is now UNDETERMINED — do not record it as fixed or as live
Measured this round, and deliberately not resolved, because resolving it needs a re-capture of
the preview set that a concurrent wave's `poses.js` edit makes unsafe to take right now:

* Stored `shots/preview/ref_00000.png` — **5** exact-black px at `y635-639 x882-895`.
* Fresh `ref_00000` captures taken today at `--settle 8`, `32` and `96` — **0** px, all three.
  So it is *not* a TAA-accumulation/settle artifact, which was the obvious first guess.
* But the two are **not comparable**: `src/world/poses.js` was modified at `02:07` today, the
  stored preview was captured at `23:44` yesterday, and my captures ran at `02:16+`. Per §3, a
  pose refit moves the camera, so "fresh `ref_00000`" is very likely a *different view* than
  the stored one. This is exactly the hazard G2's provenance stamp exists to make legible.
* `src/render/passes/taa.js` has **not** been modified since `2026-07-30 16:45` — before the
  stored preview was captured. So nothing changed in the pass §24 fingers. A fix is therefore
  the *least* likely explanation of 5 → 0.
* Also: no pose other than `ref_00000` in `shots/preview` carries any exact black — including
  `shot_sky_ring`, the original 7,978-px site. Consistent with the preview set being stale
  relative to Wave G rather than with a repair.

**What would settle it**, once `poses.js` is quiescent (G3/§16 check it first): re-capture the
full preview set at the current poses, run `pixelcheck` over it, and if the residue returns,
bisect with `tools/ablate.mjs` — §24 already fingers `taa`. Until then §24 should be treated as
open. §24's grain caveat still applies: any count is a ~2x lower bound. Fixing it needs `src/`,
which is owned elsewhere.

---

## Installed 2026-07-31 — round 5 (lens: the gate's own verification must be trustworthy)

### I1. `--selftest-integrity` added to `KNOWN_FLAGS` — the integrity gate stops crying wolf

**What was wrong.** The capture integrity gate (three channels: `__HALO_MISSING__`,
`stats.failedModules`, `__HALO_MISSING_PASSES__`) was already installed and correct. But its
own CI verification step was noisy: `selftest-integrity` was absent from `KNOWN_FLAGS` in
`tools/capture.mjs:111-113`, so `.github/workflows/preflight.yml` printed this on **every
green run**:

```
[capture] WARNING: unknown flag(s) IGNORED, this capture used defaults instead: --selftest-integrity
```

The warning was factually false — the flag *is* read, at `capture.mjs:339` via
`has('selftest-integrity')`. The unknown-flag warner exists to catch exactly the KNOWN_ISSUES
§27 class of mistake (`--beauty --placement --chrome`, four undefined flags running for hours).
Training readers to skip that line, inside the one step that proves the integrity gate still
fires, is how a real typo gets waved through later.

**What I changed** (three lines total, all additive):
* `tools/capture.mjs` — added `'selftest-integrity'` to `KNOWN_FLAGS`. One word.
* `package.json` — added `"selftest": "node tools/capture.mjs --selftest-integrity"`.
* `.github/workflows/preflight.yml` — that step now runs `npm run selftest`, so CI and a
  reviewer invoke the same string and cannot drift apart.

No measurement semantics changed. No `src/` file touched. Nothing runs at capture time.

**How to run it**
```
npm run selftest        # == node tools/capture.mjs --selftest-integrity
```
~30 ms, no GPU, no browser. Prints `{"selftest": true, "detected": 3, "expected": 3}` and
exits 0. Exits 1 if the gate has stopped detecting all three historical channels.

**Proof the gate fires** — full end-to-end, in a scratch copy under `/tmp`, never in the repo.
All three of KNOWN_ISSUES §20 / §11 / §19 reproduced simultaneously in real `src/` files:

| test | tree | result |
|---|---|---|
| clean control | untouched copy, standalone | exit **0**, `ok:true`, all three channels `[]` |
| §20 ocean stops parsing | `ocean.js` + garbage | `missing: ["ocean: Unexpected identifier 'is'"]` |
| §11 physics `init()` throws | `addStatic()` injected at `physics.js:225` | `failedModules: ["physics: ReferenceError: addStatic is not defined"]` |
| §19 fog pass stops loading | `volumetricFog.js` + `const broken = ;` | `missingPasses: ["volumetricFog: Unexpected token ';'"]` |
| all three at once | as above | **exit 3**, `ok:false`, loud named block on stderr |
| escape hatch | same broken tree + `--allow-missing` | exit **0**, `ok:true` |
| typo discrimination | `--selftest-integrity --beauty --selftest_integrity` | warns about the latter two **only** |

`node tools/parsecheck.mjs` on that same broken tree found **2 of 3** (exit 1) — it cannot see
the physics `ReferenceError`, which is precisely the §11 hole the gate exists to close.

**Proof of no harm** (real repo, after the change): `node tools/parsecheck.mjs` → `ok — 42
files parse, no GLSL template hazards`, exit 0. `node tools/capture.mjs --pose ref_00000 --out
/tmp/meta_smoke.png --settle 8` → `"ok": true`, `"via": "daemon"`, all three channels empty,
exit 0, 5.0M PNG written.

**How to turn it off if it becomes a nuisance**, in increasing order of bluntness:
1. Per-run: `--allow-missing`, or `HALO_ALLOW_MISSING=1` — for a deliberately partial build.
   This is the intended hatch and it is verified working above.
2. Drop the `npm run selftest` step from `.github/workflows/preflight.yml`. The gate itself
   keeps working; you only lose the proof that it still fires.
3. Remove `'selftest-integrity'` from `KNOWN_FLAGS` to restore the old (noisy) behaviour. There
   is no reason to want this, but it is a one-word revert.

Reverting this entry entirely: `git checkout -- tools/capture.mjs package.json
.github/workflows/preflight.yml`. Nothing else depends on it.

### Noticed, not done (round 5)

* **A scratch-copy test of any `src/` change is a silent no-op unless you set
  `HALO_NO_DAEMON=1`.** I hit this live: my first broken-tree capture under `/tmp` returned
  `ok:true` with all channels empty and I nearly recorded the gate as failing. The shared
  daemon is machine-wide and serves whatever repo it was *started from* — so a `/tmp` copy
  with three deliberately broken files was scored against the clean `/workspace` tree.
  Anything comparing two trees (ablation, bisecting a regression, verifying a fix) is exposed
  to this and would produce a confident null result. Worth a loud note in `docs/AGENT_BRIEF.md`
  and arguably a daemon `/health` field carrying its own repo root so `capture.mjs` can refuse
  a daemon whose root != `process.cwd()`. Deferred: that is a real behavioural change to the
  daemon path, not a one-word fix, and this round's scope was the flag.
* Carried forward, still correct to defer: modules whose `create()` returns falsy are dropped
  by `if (inst)` without entering `missing[]` — a hole in channel one that needs a `src/` edit.
* Carried forward: the `warnings[]` array stays non-fatal. My broken-tree runs surfaced a
  404 and a "Multiple instances of Three.js being imported" alongside the real failures —
  benign and real are genuinely mixed in there, and someone must separate them before any of
  it can be made to exit non-zero.
* `shots/` is **8.5 GB**. `/tmp` is a 7.8 GB tmpfs. A naive `tar` of the repo into `/tmp`
  fills the disk and takes down every concurrent agent's bash output with ENOSPC (I did this;
  it is how I learned). Any future scratch-copy work should copy `src tools docs package.json
  vite.config.js index.html` only — that is 2.9 MB.

## Installed 2026-07-31 — round 6 (lens: the disproof that never reached the copies)

### T2b. The claimcheck annotations landed — steady state is now a to-do, not a wall of noise
**Files:** `tools/refuted.json` (fog entry retuned), `reports/tonemap.md`,
`reports/terrain.md`, `reports/integration_waveE.md`, `docs/RESEARCH.md` (one retraction
each), `docs/AGENT_BRIEF.md` (R9b rewritten). **Supersedes T4.**

T2 shipped the detector and left 8 live sites standing. That was the wrong steady state: a
checker whose output never changes is a gate that cries wolf, and the next agent in a hurry
reads "8 unannotated sites" as furniture. The finding was never the *list* — the finding was
that a disproof stops at the report it corrects. Leaving the list on disk reproduces exactly
the failure it names.

So the retractions are now **on disk beside the claims**:

| site | claim | what the annotation says |
|---|---|---|
| `reports/tonemap.md` §"Proof, re-measured" | `no-daemon` | method retracted (§19); the six numbers are not challenged, but re-run on the shared daemon |
| `reports/terrain.md` §2 | `fog-owns-desaturation` | "not albedo" holds, `volumetricFog` does not — `--skip` was byte-identical, §18 has the cause |
| `reports/integration_waveE.md` §"Both tails" | `fog-owns-desaturation` | the additive *signature* was real, the file was wrong; by Wave H the signature is gone too |
| `docs/RESEARCH.md:7` | `fog-owns-desaturation` | HTML-comment correction: the lesson is right, the example names the wrong file |

`node tools/claimcheck.mjs`: for T2's three seeded claims, **8 live sites → 2** — the daemon
claim 1→0, the module-integrity claim 0→0, the fog claim 7→2. Both survivors are
`docs/KNOWN_ISSUES.md` §8, both under one heading, and that file is owned by a concurrent
wave — see T2c for the paste-ready text. (A concurrent round-5 agent has since registered a
fourth claim, `gtao-ssr-dead-through-waveG`, which carries its own live sites; the total the
tool prints is theirs plus these two.)

**Four defects in T2's own registry, every one found by *testing* it rather than reading it:**

1. **`refutedBy` credited the wrong report.** It named `reports/tonemap.md` for the
   byte-identical `--skip volumetricFog` measurement. The primary is
   **`reports/vegetation.md:49`**, ~~which is also the better experiment — it ran `--skip bloom`
   as a control to prove the skip mechanism itself works, so "byte-identical" could not be a
   silently-broken flag~~. `reports/tonemap.md:61` repeats it secondhand. A registry of
   disproofs that miscites its own disproof is the T1 failure in a new costume.
   > **CORRECTION (round 7): the struck sentence is exactly wrong, and it is the same failure
   > one level deeper.** `--skip` is read only by `src/modules.js`; `src/render/pipeline.js`'s
   > `PASS_MANIFEST` loads every pass unconditionally. `bloom` is a pass, so the *control*
   > **skipped nothing** either — "differs at byte 44" is the 50%-of-pixels nondeterminism
   > `reports/vegetation.md` itself documents 30 lines further down. Byte-identical was
   > guaranteed, and it is the signature of a flag that did nothing, which is indistinguishable
   > from an inert pass. Registered as `skip-flag-can-disable-a-pass`; `tools/capture.mjs` now
   > exits 2 on that command.
2. **`alsoNear` was `saturation|desaturat|43%|…`, which flags honest work.** Any future report
   putting a `sat_mean` number within 3 lines of the word `volumetricFog` tripped it — and fog
   is exactly what the next wave touches. Retuned to the refuted *mechanism* wording
   (`near-field in-scatter`, `additive haze`, `crushed whole-scene`, `not albedo`,
   `43% of target`). **Verified:** a synthetic honest post-Wave-H ablation report
   ("`volumetricFog` off vs on moves `sat_mean` by +2.9 … it is not this pass") is a **false
   positive under the old regex and clean under the new one**. Recall was checked too — the
   new regex still catches §8's heading, and additionally caught `reports/terrain.md:48`,
   which the old one missed.
3. **`cleared` could not see a bare `§18`.** It required the literal string `KNOWN_ISSUES`
   before the section number — but inside `docs/KNOWN_ISSUES.md`, where three of the sites
   live, people write `§18`. A correct retraction written in the natural style stayed flagged.
   Found by *applying* the §8 fix in a scratch tree and watching the tool refuse to go green.
   Added `§\s*(18|19|20|21)\b` and `refuted\.json` as retraction markers.

4. **The `no-daemon` entry was too broad, and a concurrent agent proved it within the hour.**
   Round 5's own notes record a *newly measured* fact: the capture daemon is machine-wide and
   serves the repo it was **started from**, so capturing a scratch copy under `/tmp` genuinely
   does need `HALO_NO_DAEMON=1` or it silently measures the original tree. The registry flagged
   that sentence as a repeat of the refuted claim. It is not — the refuted claim was about the
   *working tree* going stale under edits. The entry now says so in `truth`, and `cleared`
   accepts `scratch|/tmp|another repo|different repo|started from`. **Regression-tested:** a
   plain "I measured with `HALO_NO_DAEMON=1`" still fires (`--strict` exit 1); the scratch-tree
   sentence does not. `no-daemon` is now at **0 live sites**.

   This is the failure mode a claim registry has to be watched for: a refuted claim is refuted
   *in a context*, and the regex does not know the context. An entry that is one word too broad
   converts the tool from "stop repeating a dead claim" into "stop writing about this topic".

**R9b rewritten.** It said "do three things" and then listed two — and the missing one was the
one that matters. It is now three numbered steps, and step 3 is *annotate the copies
claimcheck finds*, with the R9 `NEEDS: <path>` escape for a site another wave owns. The
rewrite states why: steps 1 and 2 were **already being followed** — `reports/fog.md` did
retract its own `HALO_NO_DAEMON=1` claim — and the claim still cost two waves, because nobody
touched the copy in `reports/tonemap.md`. Self-retraction is not the gap. Propagation is.

**Not adopted: `--strict` anywhere.** CI stays `|| true`, no npm `pre` hook, no git hook. This
gate reads prose and judges it by regex; its false-positive mode is blocking an agent over a
sentence. Advisory is the correct setting and `--strict` exists for a human running it
deliberately.

**Run it:** `npm run claimcheck` (or `node tools/claimcheck.mjs`). Read-only, ~40 ms, no GPU,
no browser, no captures.

**Turn it off:** it cannot block anything, so there is nothing to disable in an emergency. To
silence one claim, delete its object from `tools/refuted.json` — that is the whole coupling.
To retire the tool, drop the `claimcheck` line from `package.json` and the one line from
`.github/workflows/preflight.yml`. Nothing else imports it.

### T2c. `NEEDS: docs/KNOWN_ISSUES.md` — the last 2 sites, with the exact text
The remaining two flags are `docs/KNOWN_ISSUES.md:242` and `:251`, both under the §8 heading,
and that file is owned by a concurrent wave (R9). **Verified in a scratch mirror: replacing
the §8 heading with the block below takes `claimcheck` to `ok — none left unannotated`, exit
0 under `--strict`.** Both sites clear from the one edit, because claimcheck clears a site
whose section heading carries the retraction.

```markdown
## 8. Scene renders blown out and desaturated — **CORRECTED TWICE — see §18**

> **Both diagnoses below are wrong.** Albedo was disproved first (kept below);
> `volumetricFog` was disproved second — `--skip volumetricFog` measured
> **byte-identical** at `ref_00720` (`reports/vegetation.md`), so the pass wrote no
> pixels. The cause was **`scene.js` clearing the depth texture** shared with the
> G-buffer, so every world pixel integrated 460 m of haze — **§18**. Registered as
> `fog-owns-desaturation` in `tools/refuted.json`.
```

Worth noting for whoever lands it: §8 has now named the wrong file **twice** (albedo, then
`volumetricFog`), and §8's own Wave-H note has quietly named a third cause — a highlight
roll-off in `tonemap.js`, from `p01` being correct while `p99` is crushed. Three attributions,
one section heading, and the heading still advertises the second one.

### Noticed, not done (round 6)
* **Naming a claim's `id` in prose can trip the checker on that claim.** Found by
  dogfooding `tools/refuted.json` against this very file: the entry originally listed the
  counts by slug, and the module-integrity slug alone satisfies both that claim's `near` and
  its `alsoNear`, so the ledger flagged itself twice. Reworded rather
  than special-cased, because "the writer mentioned the id" is not proof they are retracting
  it — a report can cite the slug while still repeating the claim. But it means an entry whose
  slug is built from the claim's own words is self-tripping, and slugs should be picked with
  that in mind. Not worth a code change for three entries; worth knowing at thirty.
* **`docs/AGENT_BRIEF.md:286` claims R9b closed "what to do when your measurement contradicts
  an existing report."** It is struck through as answered. It was only two-thirds answered
  until this round — the brief told you to retract and register, never to fix the copies. The
  strike-through outran the rule. No action beyond the R9b rewrite; flagged because "resolved"
  markers in the brief are not independently checked by anything.
* **`reports/tonemap.md` §1's six-capture sweep closed KNOWN_ISSUES §9 using a method now
  retracted.** The flag is a harness choice, not a render setting, so the conclusion is
  probably intact — but "probably" is doing work no measurement supports. One re-run on the
  shared daemon settles it. Not run here: re-measuring is a rendering wave's job, and G7
  (`ablate.mjs`) / S1 (`knobcheck.mjs --ab`) already do it in one command.
* **`claimcheck` reads only `reports/*.md` and `docs/*.md`.** A refuted claim repeated in a
  `research/*.md` brief, a source comment, or `tools/checkpoint.md` is invisible to it.
  Widening the glob is one line, but every added file is added false-positive surface, and
  the observed propagation path has been report-to-report. Left narrow on purpose.
* **Nothing checks that a `NEEDS: <path>` block was ever picked up.** R9 tells an agent to
  write the change into their report and stop; T2c above is one. There is no ledger of open
  `NEEDS:` items and no gate that notices one going stale — which is the same
  disproof-does-not-propagate shape, one level up. A `needscheck.mjs` is the obvious next
  round; not bundled here.

---

## Installed 2026-07-31 — round 5 (lens: the check that cannot fail)

T1 (`citecheck.mjs`) established that KNOWN_ISSUES §28's evidence cited three objects that do
not exist. This round finished the job: the same command had a **second** way of never
measuring anything, and — once run properly — its conclusion turns out to be false. Flagging
the provenance while leaving the conclusion standing is the failure mode this ledger exists to
police, so both are dealt with here.

### R5-A. `tools/citecheck.mjs` — the remediation it prints is now the one that works
**Files:** `tools/citecheck.mjs` (edited: docblock, remediation text, one new regex, dedup)

When the offending line is a `git show/log/diff`, citecheck already explained that
`git show <dead> | grep -c` prints `0` and is indistinguishable from a true negative. Two
corrections:

* **`set -o pipefail` is not the fix and is no longer implied.** Measured: on a dead object
  `grep` exits 1 as well, so the pipeline status is identical to a true negative's. The
  printed replacement is verify-then-read:
  `git rev-parse --verify "${c}^{commit}" >/dev/null || exit 1`.
* **The braces are load-bearing, and this is the bigger finding.** This repo's shell is zsh,
  where `$c:src/render/passes/ssao.js` is a parameter expansion plus the `:s` substitution
  modifier — **and double quotes do not disable it**. Measured, no rc file, with a SHA that
  resolves:

  ```
  $ zsh -f -c 'c=f25d7b9; echo "$c:src/render/passes/ssao.js"'
  f25d7b9/passes/ssao.js
  ```

  So §28's loop handed git `<sha>/passes/ssao.js` — neither a rev nor a path — and would have
  printed `0 0 0` **with perfectly good SHAs**. Dead objects were never the only reason it
  could not fail. citecheck now detects the unbraced form (`UNBRACED_SHELL_PATH`) and prints
  this alongside the verify line. The advice is emitted once per offending line rather than
  once per dead SHA, which took the §28 output from 30 repeated lines to 10.

Ships as `docs/AGENT_BRIEF.md` R9b → *"A verification command must be able to fail — and in
zsh, must be braced"*, with the measured transcript and the corrected loop.

### R5-B. The claim itself, not only its provenance — `gtao-ssr-dead-through-waveG`
**Files:** `tools/refuted.json` (new entry), `docs/META_LEDGER.md` (G7 correction above)

Re-run braced and verified against the wave commits that **do** exist:

```
$ for c in 6a19370 f25d7b9 8bceeb5 f96fae6; do
    git rev-parse --verify "${c}^{commit}" >/dev/null || exit 1
    git show "${c}:src/render/passes/ssao.js" | grep -c "export function ensureOpaqueDepth"
  done
0    Wave E   6a19370
1    Wave F   f25d7b9
1    Wave G   8bceeb5
0    Wave H   f96fae6
```

`ssr.js` imports and calls it at F and G too (`ssr.js:3`, `ssr.js:733`; defined `ssao.js:51`,
called `ssao.js:1053` at `f25d7b9`). Its absence at Wave H is a **deliberate deletion**, not
absence-from-history: the header of today's `src/render/passes/ssao.js` records that the
private mid-frame snapshot was proved bit-identical to `pipe.depthTex` at all 21 poses and
removed.

So "exists in no commit", and the "every scored run up to and including `waveG-mvfix` had both
passes dead" that rests on it, are **false**. The rationale *"`aoStrength`, `aoRadius`,
`aoPower`, `ssrStrength` were all tuned against a pass that produced no output"* holds at most
for Wave E. Any downward re-tune of those four justified by that sentence needs re-deriving.
The over-strength finding itself is untouched by this: `edge_ratio` 1.413 and `lap_ratio`
1.360 at waveH are image measurements that stand on their own.

Registered in `tools/refuted.json`, so `claimcheck` now names every live site: 3 in
`docs/KNOWN_ISSUES.md` §28 (:1108, :1112, :1121), 4 in `reports/integrationH.md`
(:135, :142, :146, :475), and 1 in this ledger's own G7 entry — which is corrected inline
above, and was the copy that proves the claim had already propagated.

### R5-C. Reviewer point 3 — checked, and the premise was wrong
Two "false evidence claims" were reported in the T1 entry and the `preflight.yml` comment:
that `docs/LOOP.md` does not exist, and that citecheck reports 5 bad paths. Neither is on
disk. `docs/LOOP.md` is present (362 lines) and `reports/harness.md`'s five citations of it
resolve; T1 already reads "**9 dangling citations across 5 sites**, 0 bad paths", and today's
run agrees exactly — `9 dangling, 0 missing paths, 56 into untracked shots/`. The "5 bad
paths" appears to be "5 sites" mis-transcribed into the task brief. **No edit made**, on the
principle that correcting a document to match a claim rather than the measurement is the
thing being policed. `preflight.yml` left untouched for the same reason (its comment is
accurate) and because a concurrent wave is editing that file.

### Proof it fires
Scratch fixture at `/tmp/citecheck_fixture` (own git repo, one commit, deleted afterwards —
nothing constructed inside the repo):

| test | input | result |
|---|---|---|
| dangling SHA in prose | `` `deadbee` `` as a "Tree:" provenance stamp | **DANGLING**, exit 1 |
| §28 shape | `for c in deadbee cafe123 8ed94d7; do git show $c:src/thing.js \| grep -c …` | **DANGLING** ×3 + verify-first block + **NOTE THE BRACES** |
| dead path | two backticked paths under `src/` and `tools/` that are not on disk | **NOPATH** ×2 |
| valid SHA, braced, verified | real short SHA + `git rev-parse --verify "${c}^{commit}"` | not flagged |
| decimals | `14057892`, `0046542` | not flagged (no hex letter) |
| clean tree | only the good doc | `ok — …`, **exit 0** |
| `--warn` on a dirty tree | dangling SHA present | **exit 0** — advisory mode cannot redden CI |
| claimcheck, new entry | a doc repeating "exists in no commit" / "tuned against a dead pass" | **2 sites flagged**, `--strict` exit 1 |
| …with a retraction beside it | `CORRECTION: … 6a19370 / f25d7b9 / 8bceeb5 — E:0 F:1 G:1 H:0` | **0 sites**, `--strict` exit 0 |

On the real tree, before and after: **9 dangling, 0 missing paths** — the round's edits added
no findings and cleared none, and `docs/AGENT_BRIEF.md`'s new worked example does not flag
itself (the bad loop is marked `# DO NOT COPY — all three are dangling`, and the zsh
transcript deliberately uses `f25d7b9`, a SHA that resolves).

### How to run it
```bash
npm run citecheck                # or: node tools/citecheck.mjs
npm run claimcheck               # node tools/claimcheck.mjs --strict to gate on it
node tools/citecheck.mjs --shots # also list the 56 citations into gitignored shots/
```

### How to turn it off if it becomes a nuisance
1. `--warn` — reports everything, always exits 0. This is already what CI uses.
2. Drop the `citecheck / claimcheck (advisory)` step from `.github/workflows/preflight.yml`.
   It is `|| true`, so it can never fail a build; removing it costs nothing but the output.
   A reviewer argued the npm script plus the R9b rule is the load-bearing 90% and the CI step
   only surfaces text nobody is obliged to read. That is fair — it was kept because it is free
   and because "nobody is obliged to read it" is also true of every report here.
3. Delete the `gtao-ssr-dead-through-waveG` entry from `tools/refuted.json` — one JSON object,
   no other tool reads it. Do that only by *correcting* §28, not to quiet the noise.
4. Nothing above runs at capture time, starts a browser, or touches `src/`. Deleting
   `tools/citecheck.mjs` outright breaks only `npm run citecheck` and one advisory CI step.

### Noticed, not done (round 5)
* **`docs/KNOWN_ISSUES.md` §28 and `reports/integrationH.md` §7 still assert the refuted
  claim inline.** Both are owned elsewhere (§28's file is explicitly off-limits to this
  round), so they are flagged by `claimcheck` rather than edited. **NEEDS:
  `docs/KNOWN_ISSUES.md`, `reports/integrationH.md`** — replace the `0 0 0` block with the
  braced, verified loop in R5-B and change "exists in no commit" to "absent at Wave E, live at
  Waves F and G, deliberately deleted at Wave H". `reports/integrationH.md:475` ("with the git
  proof that `ensureOpaqueDepth` exists in no commit") is the sentence that carries the
  conclusion into the recommendations list; it is the one that matters most.
* **The AO/SSR re-tune may be resting on the corrected premise.** Whoever lowers
  `aoStrength`/`aoRadius`/`aoPower`/`ssrStrength` should justify it from the waveH image
  numbers (`edge_ratio` 1.413, `lap_ratio` 1.360), which are sound, and not from "tuned
  against a dead pass", which is only true of Wave E. Not re-derived here: it needs captures,
  and `src/` is owned elsewhere.
* **Every SHA in the written record predates the `a9c1e8a`/`b92decf` rewrite and is
  unrecoverable.** citecheck can say a citation is dead; nothing can say what it *meant*. The
  wave commits are recoverable by subject line (`git log --oneline | grep '^.\{8\}Wave '`) and
  that mapping is now written down in R5-B for E–H. Earlier waves have no such mapping.
* **`citecheck` cannot tell a dangling SHA from a typo'd one.** `deadbee` and a real SHA with
  one character wrong report identically. A `--suggest` mode doing a `git rev-list` prefix
  search would separate them; not built, because the observed failure was whole-history loss,
  not fat fingers.
* **No gate detects the zsh `:s` hazard outside a `git` line.** `UNBRACED_SHELL_PATH` is only
  consulted when the line already contains `git show/log/diff/checkout` **and** already has a
  dead SHA on it. A correctly-SHA'd but unbraced command in any other tool's docs passes
  silently. Widening it to every fenced shell block in `reports/` is a plausible next round;
  left narrow here because the false-positive surface is large and unmeasured.

---

## Installed 2026-07-31 — round 7 (lens: gates — the gate that is not in the repository)

Rounds 1–6 installed gates. This round asked where they *are*, and what reads the records
they write. Two answers, both mechanical.

### G10. `preflight` check 6 — the guardrails must be committed
**Files:** `tools/preflight.mjs` (new check 6, advisory)

`git ls-files .github .githooks` returns **0 files**. Everything six rounds of this loop
installed lives in one working tree and has never been committed:

* `.github/workflows/preflight.yml` — its own header reads "the repo is public
  (github.com/kvnloo/halo) but nothing has ever run on a push". It still has not, and cannot:
  GitHub cannot run a workflow that is not in the repository.
* `.githooks/pre-commit` — `core.hooksPath=.githooks` is local `.git/config`. A fresh clone
  gets no hook, no CI and no error. The §20 backtick gate does not exist anywhere but here.
* `package.json`'s whole script block (`prepare`, `preflight`, `precapture`, `prescore`,
  `selftest`, `citecheck`, `claimcheck`, `refstamp`) is an **uncommitted modification** —
  `git show HEAD:package.json | grep preflight` is empty.
* 22 of the 61 files in `tools/` are untracked, including `preflight.mjs`,
  `parsecheck-staged.mjs`, `historycheck.mjs`, `citecheck.mjs`, `refuted.json`,
  `ref_manifest.json`.
* `scores/provenance.jsonl` is untracked, although `tools/capture.mjs:251` states it is
  mirrored there *because* that file "IS tracked". The join key from a score back to the tree
  that produced it exists on one disk.

This repo's log already contains two salvage commits for work nearly lost to session death
(`2651d8c`, `41624e7`). The entire safety layer is currently in that same unsaved state.

The check enumerates what the process depends on (hooks under `core.hooksPath`, the workflow,
`provenance.jsonl`, `package.json`, and every `tools/` script named in a package script),
runs `git ls-files --error-unmatch` over it, and prints the `git add` line that fixes it.
**Advisory** — it must never block a wave, and it is loud enough unblocked.

**Not done here, deliberately:** the commit itself. Committing on `main` while a dozen agents
hold the tree is the orchestrator's call, not a drive-by. The command is in the check's output.

### G11. `tools/provcheck.mjs` — something finally reads the provenance stamp
**Files:** `tools/provcheck.mjs` (new), `tools/preflight.mjs` (check 8, advisory),
`package.json` (`provcheck`), `.github/workflows/preflight.yml` (advisory step)

G2 stamps every capture with the sha256 of `poses.js`, of `metrics.py`/`score.mjs`/
`capture.mjs`, the git SHA, the settle and the resolution, keyed by `outdir` — and
`score.mjs` captures to `shots/<tag>/`, so the tag joins straight back to the
`history.jsonl` row. `grep -rn provenance.jsonl tools/` returned exactly one file: the
writer. A receipt nobody joins.

Joined, the last three rows of the series read:

```
waveI-posefit    poses 19ebfe59d18e0da6   metrics.py 507bfe35ffda18e8
waveI-fitstand   poses 9eaf76fa87dcda0c   metrics.py 05fcf4e4e796826f   score.mjs also changed
waveI-handstand  poses 0f4f314680b198d8   metrics.py 85c1f653780e2658
```

Three adjacent rows, three different camera pose tables, three different measuring
instruments — and the last two are read against each other as a fit-vs-hand comparison
(`reports/posefit.md`). The discontinuity *was* eventually caught, by a human who hand-typed
a `{"tag": "== POSE REFIT LINE ==", "note": "DISCONTINUITY..."}` row into `history.jsonl`
afterwards; that marker sits below all three, so it does not separate them from each other.
That hand-typed row is the manual version of this check.

It also compares the **live** tree: `src/world/poses.js` today (`cac5ef7f2cae9006`) is not the
file that produced `waveI-handstand`, so the next score taken here is already on a different
framing than every row in the history.

Advisory by default; `--strict` exits 1 on an incomparable adjacent pair (it does today).
Re-bands nothing, edits nothing, never runs at capture time.

### G12. `/health` reports the daemon's own repo root; `preflight` check 7 refuses a mismatch
**Files:** `tools/captured.mjs` (two fields on `/health`), `tools/preflight.mjs` (check 7)

Round 5 noticed this and deferred it: the capture daemon is machine-wide and serves whatever
repo it was *started from*, so a capture taken in a scratch copy is answered from the original
tree and returns `ok:true` with every integrity channel empty — indistinguishable from a
genuine null result. The reviewer who hit it "nearly recorded the gate as failing". Every
two-tree operation (ablation, bisecting a regression, verifying a fix) is exposed.

`/health` now carries `root` and `pid`. Preflight compares `realpath(root)` to its own ROOT
and **hard-fails** on a mismatch, with the two fixes in the message (`HALO_NO_DAEMON=1`, or
`curl .../stop`). A daemon started before this build omits `root`, so the check reports
"restart it to enable" instead of crying wolf — it cannot fire spuriously on the daemon that
is running right now.

### Proof of no harm (round 7)
`node tools/parsecheck.mjs` → 0, "42 files parse".
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → 0, 4.9 MB PNG,
all three integrity channels empty. `npm run selftest` → `detected 3, expected 3`.
`node tools/parsecheck-staged.mjs` → 0. `node tools/preflight.mjs` → 0 (2 advisory).

### How to revert
`git checkout -- tools/preflight.mjs tools/captured.mjs package.json
.github/workflows/preflight.yml && rm tools/provcheck.mjs`. Nothing else reads any of it.
Note that three of those four are untracked (G10), so "revert" means "delete the additions".

### Noticed, not done (round 7)
* **`.githooks/pre-commit` only inspects `src/**.js`.** The instruments are edited as fast as
  the renderer — `metrics.py`'s hash changed three times in the 30 minutes that produced the
  last three history rows — and a half-written `tools/metrics.py` or a truncated append to
  `scores/history.jsonl` commits clean. `historycheck` catches a malformed row, but only on a
  push, in a workflow that is not committed. A `tools/stagedcheck.mjs` extending the same
  staged-blob technique to `tools/*.mjs` (`node --check`), `tools/*.py`
  (`python -m py_compile`) and every staged `*.json`/`*.jsonl` is the obvious next round.
* **`citecheck` existence-checks cited paths against the working tree, not against git.** A
  report citing `tools/_gunmask.py` passes while the file is untracked and unreproducible for
  anyone else. One flag (`git ls-files --error-unmatch`) closes it; folded into G10's evidence
  rather than built here.
* **`score.mjs` still writes no fingerprint into the history row itself.** G11 recovers it by
  joining on the tag, which works only while `shots/<tag>` provenance survives. Putting
  `poses`/`tools` into the row at write time is a two-line change in `score.mjs` — owned by a
  concurrent wave this round, so not touched.
* **`--rescore` runs append no provenance at all** (they do not capture), so
  `scores/rescore_wave*.json` cannot be tied to a pose set. They are also excluded from
  `history.jsonl` by design, so nothing compares them — but reports quote them.

---

## Installed 2026-07-31 — round 8 (lens: adherence)

Rounds 1–7 gated the *tree*. This round measured the *brief* against `reports/*.md`: which
instructions agents actually follow, and why the rest are ignored. The pattern is not
carelessness — it is that every followed rule has a command behind it and every ignored rule
is a paragraph. R1 ("write the report first") has 30 reports on disk; the report-side rules
that were never bundled into one command have adherence 0.

Measured before building anything (all read-only, all reproducible):

| rule | adherence | measured with |
|---|---|---|
| R1 checkpoint to `reports/` | 30 of 30 | `ls reports/*.md` |
| R7 provenance block | **0 of 28** | `node tools/reportlint.mjs` |
| R9 `NEEDS: <path>` handoff | **0 of 28**, against 26 handoffs written in prose in 18 reports | `node tools/needscheck.mjs` |
| blind gate cited by the owner of the file it names | **0 of 28** | `node tools/tells.mjs` |
| R10 research cited | 9 of 9 briefs | `grep -rl research/<x>.md reports/ src/` |

### A8. `tools/postflight.mjs` — the mirror of `preflight`
**Files:** `tools/postflight.mjs` (new), `package.json` (`postflight`),
`docs/AGENT_BRIEF.md` ("Before you finish", R7)

Preflight's own header states this project's failure mode: "not 'the check was wrong', it is
'nobody ran it'", and it fixed that by making five checks one command. The *report-side*
rules never got that treatment: an agent finishing a subsystem would have to remember
`reportlint`, `citecheck`, `claimcheck`, `refstamp`, `needscheck` and `tells`. Adherence to
all six was zero.

One command, advisory, no GPU, no capture, never edits a report. It also **writes the R7
provenance block for you**, filled from the `_capture.json` G2 already stamped — R7 has 0%
adherence partly because it asks an agent to reconstruct five facts by hand at the end of a
session, and the machine knows all five.

It carries one check that is new rather than a wrapper: **GLSL errors in your own capture's
`warnings[]`**. That is the fourth integrity channel — G1 made a module that fails to *load*
fatal, and a module that loads, `init()`s, and whose shaders then fail to *link* is invisible
to it. `reports/terrain.md` §1: `patch` is a reserved word in ESSL 3.00, all three terrain
materials failed to link, and the "sand" in the showcase contact sheet was the clear colour —
captured, scored, committed (`65da9df`) and reviewed before anyone read the console. §19:
"capture warnings do get swallowed into `warnings[]`". `score.mjs:104` runs capture with
`stdio: ['ignore','pipe','inherit']` and `JSON.parse`s stdout, so during a scored run those
lines are read into a variable and never shown. R3 says run `shadercheck` instead: named in
**0 of 30** reports.

Deliberately implemented by *reading* the stamped record rather than by editing
`tools/capture.mjs`: capture is the one file every concurrent agent executes, a round 7 was
editing it while this ran, and the lines are already on disk in `_capture.json` and
`scores/provenance.jsonl`. Nothing at capture time changed. Making them **fatal** is still
open — round 5 deferred it because benign and real warnings are mixed in that array, and that
is still true.

### A9. `tools/tells.mjs` — the acceptance gate reaches the file it names
**Files:** `tools/tells.mjs` (new), `package.json` (`tells`), `docs/AGENT_BRIEF.md` (R2b)

`reports/blind.md` is the stated final gate: nine frames judged blind, lost 9-0, eleven tells
ranked by how many frames each decided. Nothing in R1–R10 named it. Consequence, measured:
4 of 30 reports mention the blind test and three of those four are the tooling agents who
built it; **no subsystem report cites the tell that decides its own subsystem**.
`reports/tonemap.md` (02:15) and `reports/terrain.md` (02:14) were written after `blind.md`
landed at 23:56 and contain neither "blind" nor any `T<n>` — T11 is about the tonemap, T2 is
about the beach. Meanwhile T10 records that at `ref_02220` the bridge is **absent from our
render entirely**, "the only finding here that is outright wrong rather than not good enough",
and it is owned by nobody.

`node tools/tells.mjs rocks` prints the tells naming your file, their rank, their full text,
and whether any report has ever cited them. The tell → file map is a ten-line table in the
tool, hand-maintained on purpose: the tells are prose written by a human judge and T3 and T9
name no file at all. Today it reports **9 of 11 tells cited by no report**.

### A10. `tools/needscheck.mjs` — the R9 handoff finally has a channel
**Files:** `tools/needscheck.mjs` (new), `package.json` (`needscheck`),
`docs/AGENT_BRIEF.md` (R9)

R9's first half is followed and its second half does not exist: `NEEDS:` headings across 28
subsystem reports = 0, cross-file fixes handed off in prose = 26, in 18 reports —
`reports/depth.md:372` ("~6-line fix in a file I do not own, with the patch written out
above. Highest priority."), `clouds.md:379`, `integration.md:632`, `structures.md:324`,
`props.md:437`, `vegetation.md:57`, `sky.md:197`, `taa.md:378`. Agents really do stop at the
file boundary; the fix then sits in the middle of a 20–50 KB report with no way to enumerate
it.

The tool finds both forms — the heading, and the six prose patterns actually observed (every
regex was taken from a line that exists in `reports/`, none invented) — so the routing list
exists retroactively for the 18 reports written before the heading was asked for. For a
`NEEDS:` heading it also checks the path resolves and whether the target has been touched
since the report asked, which is the cheapest available proxy for "was this routed?".
Round 6 flagged this as the obvious next round; the new evidence is that the *heading itself*
has never once been used, so a staleness check alone would have had nothing to read.

### Adherence notes written into the brief, not gated
* R3, R4, R7 and R9b were added to `docs/AGENT_BRIEF.md` *after* every report on disk was
  finished, so their 0-of-28 adherence is by construction, not neglect. The brief now says so
  next to the rule, because "an instruction nobody follows" and "an instruction nobody has
  been given yet" need different fixes and look identical in a grep.
* Nothing verifies that the wave script which spawned an agent injected this file rather than
  a re-typed copy. Recorded in the brief's "what this brief still does not say" list; a real
  fix needs the wave scripts, which are not in this repository.

### Proof of no harm (round 8)
`node tools/parsecheck.mjs` → 0, "42 files parse, no GLSL template hazards".
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → 0,
all three integrity channels empty. `node -e "JSON.parse(package.json)"` → ok.
Nothing under `src/` was read-modified. `tools/capture.mjs`, `tools/preflight.mjs`,
`tools/metrics.py`, `tools/score.mjs` and `docs/KNOWN_ISSUES.md` were **not** edited.

### How to revert
`rm tools/postflight.mjs tools/tells.mjs tools/needscheck.mjs` and drop the three script
lines from `package.json`. `docs/AGENT_BRIEF.md` gains only additive sections (R2b, "Before
you finish", the R9 heading spec). Nothing reads any of it at capture or score time.

### Noticed, not done (round 8)
* **`postflight` guesses which report is yours** (newest `reports/*.md` by mtime) and which
  capture is yours (newest `_capture.json`). With a dozen agents sharing the tree those
  guesses can cross. Both are overridable (`node tools/postflight.mjs reports/x.md
  --capture shots/x/_capture.json`) and the printed block says to correct what the machine
  guessed wrong — but an agent-supplied `--key` passed down from the wave script would be
  better than mtime.
* **The tell → owner table in `tells.mjs` is hand-maintained.** Eleven tells, ten lines. At
  thirty tells it should be a front-matter block in `reports/blind.md` written by the judge.
* **Nobody owns "the frame".** T3 (contact, 6 of 9) and T9 (aerial perspective, global) are
  cross-cutting and appear in no agent's file list, which is why they are uncited: there is
  no agent to cite them. That is a wave-composition decision, not a gate.
* **`--strict` is wired but unused.** `postflight --strict` exits 1; no wave script calls it.
  The right moment to turn it on is when a wave's reports are all written under a brief that
  actually contained R2b and the `NEEDS:` spec — i.e. one wave from now, not retroactively.

---

## Installed 2026-07-31 — round 8 (lens: trust — the units under the numbers)

Rounds 2 and 6 gated the *written record* (do citations resolve, do refuted claims stand).
This round found that the record is fine and the **scale under it moved**: `tools/metrics.py`
was re-banded and re-weighted on 2026-07-31 mid-wave, and three instruments that read score
numbers kept reading them as one series.

### U1. `tools/axischeck.mjs` — spans are computed per band epoch, not across the re-band
**Files:** `tools/axischeck.mjs` (edited: epoch split, per-epoch span, exit rule)

G9 shipped to catch §15 — an axis that cannot move. **Before this edit it printed
`all axes have moved.` and exited 0.** That all-clear was manufactured entirely by the
re-band: it spanned `waveH` (spectrum 94.15, old bands) against `rescore_waveH`
(spectrum 11.36, new bands) — *the same PNGs* — and read 95.43 points of movement.

Discriminator is mechanical, not a date or a tag: a run scored by the new metric carries
`axes_legacy`; an old run does not. Spans are now computed inside an epoch and an axis is
dead only if it is dead in **every** epoch that has two or more runs.

After: **exit 1, `grade` dead in both epochs** — span 1.74 legacy, 1.69 new. §15's axis
survived the re-band that was supposed to fix it, and the tool that exists to say so had
been silenced. `--json` keeps the old top-level `axisStats` under the name
`axisStats_ACROSS_EPOCHS_DO_NOT_USE` so no consumer breaks and none can quietly use it.

### U2. `tools/historycheck.mjs` — marker rows are not runs; mixed epochs are named
**Files:** `tools/historycheck.mjs` (edited: `MARKER` filter, band-epoch warning)

The Wave I refit hand-appended `{"tag": "== POSE REFIT LINE ==", "n": 0, ...}` to
`history.jsonl` to record the discontinuity. historycheck counted it as a run and emitted
`rows were scored over different pose counts (n = 9, 0)` — a real warning pointed at the
wrong cause (it blames `score.mjs` for skipping poses). It now reports
`1 marker row(s) not counted as runs` and, in its place, the warning that is actually true:
the file mixes two band epochs, so `score` is not one column.

### U3. `tools/scalecheck.mjs` — the AAA ceiling must be in the units the scorer prints
**Files:** `tools/scalecheck.mjs` (new), `tools/preflight.mjs` (check 9, advisory),
`package.json` (`scalecheck`)

**The claim in the docs that is wrong.** `docs/TARGETS.md:143` — *"`detail`, `geometry` and
`spectrum` above ~80/88/95 means the render carries the same texture and edge statistics as
the real game"* — and `docs/ARCHITECTURE.md:189-194`, which sets floors `structure > 45`
… `spectrum > 92`. Both quote `ref/baseline.json`, written **2026-07-29 22:39** and never
regenerated, while `tools/metrics.py` was re-banded **2026-07-31 02:14**. On the same PNGs
`waveH` reads detail 76.86 / geometry 80.81 / spectrum 94.15 and `rescore_waveH` reads
32.74 / 18.45 / 11.36. An agent who reads TARGETS.md today and then runs `npm run score`
concludes the render collapsed.

`reports/metrics.md` §7 *already* named both documents when it landed the re-band, under the
heading "Documents that are now wrong, owned by someone else". That is precisely the §19
shape — a correction that stops at the report that wrote it never reaches its readers — so
this round made it mechanical instead of prose.

The check is **stateless**, so it cannot itself go stale: if `metrics.py` carries a
`LEGACY_BANDS` block (proof a re-band is on record) and `ref/baseline.json` carries no field
naming its banding, the ceiling is unattributable. It prints the 7 documented axis floors
with line numbers. It goes green when `ref/baseline.json` is regenerated **with a stamp**
(`band_version` / `metrics_sha256`), or when an owner records the decision in
scores/scale_stamp.json (not on disk until someone writes
it) — an escape hatch that is also an attribution. Verified both
directions: with the ack file present, exit 0; without, exit 1.

### U4. `tools/citecheck.mjs` — a content digest is not a dangling commit
**Files:** `tools/citecheck.mjs` (edited: digest-label lookback, digest-length skip)

T1 recorded "9 dangling citations"; the run at the start of this round printed **14**, and
**5 of the 5 new ones were md5 fingerprints** — `reports/posefit.md:133/138/229`, which pins
the scorer as `tools/_posefit_metrics.py, md5 0592ed3f` *precisely so its numbers survive a
mid-experiment re-band*. The single best provenance practice in the repo was the loudest
entry in the trust tool's defect list. Round 4's R1 lesson, in a new costume.

Two rules, both narrow: skip a hex token whose own line or the line **before** it names it a
digest (`md5|sha256|digest|checksum|fingerprint|hash`) — lookback only, because a label
precedes its value and looking forward would let a later sentence mask a real citation; and
skip tokens of length 16 / 32 / 64, which are a truncated sha256, an md5 and a sha256 and are
never a git abbreviation (7–12 here, 40 full). The second rule was added after a concurrent
round-7 agent quoted eight 16-char `provenance.jsonl` stamps and citecheck called every one a
dead commit.

Result: 14 → **10 dangling, 0 false**, and the surviving 10 are the genuine pre-rewrite SHAs
— including a **fresh** one it caught immediately, `docs/META_LEDGER.md:820` citing `41624e7`,
a salvage-commit SHA that no longer exists after the `a9c1e8a` history rewrite.

### Proof of no harm
`node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards`, exit 0.
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → exit 0,
`"ok": true`, `integrity.missing/failedModules/missingPasses` all empty, 4.9 MB PNG.
`node tools/preflight.mjs` → exit 0, `preflight ok (3 advisory: guardrails-committed,
provenance, scale)`. No `src/` file was read for edit, no measurement changed semantics,
no band was altered, nothing new runs at capture time.

### How to turn it off
1. `node tools/scalecheck.mjs --warn` always exits 0; it is already advisory in preflight and
   `add(..., false)` there means it can never fail a wave. Delete check 9 to remove it.
2. `node tools/axischeck.mjs --span 0` disables the dead-axis verdict; the epoch split is
   presentational and safe to keep.
3. `git checkout -- tools/axischeck.mjs tools/historycheck.mjs tools/citecheck.mjs` reverts
   U1/U2/U4 completely. `rm tools/scalecheck.mjs` reverts U3 (preflight's check 9 is guarded
   by `existsSync` and silently disappears).

### Noticed, not done (round 8)
* **`reports/blind.md:32` still contradicts `scores/blind_ledger.jsonl`.** The report's
  positional-bias guard says "our render on side A in 4 pairs and side B in 5"; the ledger,
  read from the key while it still existed, records `renderOnA: 3, renderOnB: 6`. Round 2's
  T5 measured this and left the report unannotated — the exact propagation failure T2b named,
  in the project's acceptance gate. **NEEDS: `reports/blind.md`** — one line beside §0:
  *"CORRECTED: the split was 3/6, not 4/5 — measured from the key in
  `scores/blind_ledger.jsonl`. The conclusion is unaffected: an always-A judge scores 6/9."*
  A `blindledger.mjs --verify` that diffs the prose tally against the ledger is the gate;
  not built here because `tools/blind.mjs` is owned by a concurrent wave.
* **`citecheck` and `claimcheck` never read `research/`.** 638 KB of technique briefs, cited
  97 times from `reports/`+`docs/`, holding 451 URLs — and `docs/RESEARCH.md` itself says "an
  invented citation is worse than no answer, because it will be believed." Measured by
  widening the glob in a scratch copy: it surfaces one genuine dangling commit
  (`research/taa.md:464` cites `6bbf321`, lost in the `a9c1e8a` rewrite) and **10 false
  positives**, all upstream paths — three.js's src/renderers/webgl/WebGLState.js and
  src/nodes/accessors/VelocityNode.js, FSR2's src/ffx-fsr2-api/ffx_fsr2.cpp (left unbackticked
  here on purpose) — which are not this repo, and which `TRACKED_ROOTS`'s `^src/` cannot tell
  apart from a real citation. The
  glob widening is one line; it needs an upstream-path guard first, and the URLs (the actual
  trust surface in a research brief) are unreachable from here without network access.
* **`ref/baseline.json` cannot be re-banded, only re-generated.** It stores banded axes with
  no raw statistics, so the new bands cannot be applied to the old 91 pairs — the calibration
  run has to be taken again. That is a metrics owner's job; `scalecheck` only makes the debt
  visible and attributable.

---

## Installed 2026-07-31 — round 7 (lens: recurrence)

Three failures that happened **more than once**. §20's backtick trap is the project's own
template for this shape, and one of the three is the backtick trap again — through a hole in
the gate that was installed to stop it.

### C1. `tools/parsecheck.mjs` — a backtick in a comment inside a GLSL template is a stray, whatever follows it
**Files:** `tools/parsecheck.mjs` (one block, strictly additive)

**The recurrence.** §20 counts three occurrences (`noise.js`, `ocean.js` twice, `rocks.js`)
and installs `parsecheck`. `reports/ocean_waveH.md` §1a is occurrences **five and six**:
*"It happened to me too, twice, and the second time it got past `node --check`."* An **even**
number of stray backticks re-closes the template, so the file parses; the text between them
becomes JavaScript; the module throws on import and the subsystem vanishes from the frame —
the §20 silence, from a file that `node --check` calls clean. That report asked for exactly
this scan and noted it has **"no owner in `tools/`"**. It still had none.

**The hole, measured.** `parsecheck` examined only the **first** backtick after each
`/* glsl */` opener and exempted it if the next character was `; , ) ]` or `+`. So a comment
quoting a term that begins with one of those — this project's own house phrase, *"carried a
`` `+ 0.5 * uJitter` `` fudge"*, which sits in `src/render/passes/taa.js:67` today, and
`` `0.5 * uJitter` `` in `motionBlur.js:106` — was read as a legitimate `+ CONCAT` end, and
**the rest of that template was never scanned**. Fixture, run against the tool as it stood:

| fixture | old | new |
|---|---|---|
| `// quoting \`h\` here` (§20 classic, odd) | FAIL (parse) | FAIL (parse) |
| `` * The old form was `(0.055 + 0.30*thick) / …` `` (the real `ocean.js` line, even) | WARN | WARN |
| `` // the term `+ 0.5*uJitter` is added downstream `` | **silent, exit 0** | WARN |
| …plus a second stray later in the same template | **silent** | both lines flagged |
| `` ` + /* glsl */` `` genuine two-chunk concatenation | clean | clean |

The third row imports as `ReferenceError: uJitter is not defined` — a dead module, a green
gate. **Zero false positives by construction**: nothing legitimate puts a backtick on a
comment line inside a shader. Measured across all **137** `/* glsl */` templates in `src/`:
0. `node tools/parsecheck.mjs` → `ok — 42 files parse`, exit 0, unchanged.

**Turn it off:** delete the `2a` block; the original tail test is untouched beside it.

### C2. Machine state is stamped on every capture, and preflight says it before the hour is spent
**Files:** `tools/capture.mjs` (provenance stamp gains `machine`), `tools/preflight.mjs`
(sixth check, **soft**)

**The recurrence: every frame-time number in the project has been voided three times.**
§13 — `stats.ms` was a structural zero in every capture ever recorded. §22 — fixed, and still
wrong: an EMA read once at the end, so an `--all` run reports only the last pose (`waveF.json`
5.13 ms against a real 8.3–14.1 range, both in the repo). §29 — a CPU stopwatch on a box at
**load average 24 with 1 GB of 15 GB free and the GPU 27% idle**: one identical build measured
10.23 / 11.60 / 16.40 / 18.80 ms p50 in a single session, a **1.84x spread with no source
change**. §23 and §25 are marked SUSPECT because of it, and §25b's "~400 ms frame hitch on 11
poses" is most likely a scheduler stall written down as a rendering defect.

§29's own remedy — *"record `uptime` and `free` alongside every frame-time table from now
on"* — was never attached to anything, which is the §16/§20/§27 pattern the ledger exists to
break. Now: `_capture.json` and `scores/provenance.jsonl` carry `machine.{loadAtStart, load,
cpus, loadPerCpu, memAvailMb, memTotalMb}`, joined to the score row by outdir exactly as G2
joins the git tree; and `preflight` prints `machine-load` before a capture is spent. Two
syscalls, no subprocess, inside the existing try/catch that already guarantees provenance can
never fail a capture. **Advisory only** — a busy box is the normal state of this repo, and
image metrics, triangle counts and draw calls are unaffected by it.

**Turn it off:** drop the `machine-load` block from `preflight.mjs`; drop `machine:` from the
`rec` object in `capture.mjs`. Nothing reads either field yet.

### C3. `--skip <passname>` never disabled a pass — and one of those results is the project's registered disproof
**Files:** `tools/refuted.json` (new claim `skip-flag-can-disable-a-pass`),
`docs/META_LEDGER.md` + `docs/AGENT_BRIEF.md` (retractions on the copies I own)

`src/render/pipeline.js`'s `PASS_MANIFEST` is a fixed list loaded unconditionally in `init()`;
it never reads `skip` or `only`, at any wave commit (checked braced at `6a19370` `f25d7b9`
`8bceeb5` `f96fae6`). Only `src/modules.js:46` reads the flag, against its own **module**
manifest. So `--skip volumetricFog`, `--skip bloom`, `--skip ssr`, `--skip taa` all skipped
**nothing** and returned a frame identical to the default by construction.

**The recurrence, and why it matters more than the flag.** A byte-identical arm is the
signature of a flag that did nothing *and* of an inert pass, and this project cannot tell them
apart — it has now confused them at least four times:

* `reports/vegetation.md:49` — the finding that `volumetricFog` "writes zero pixels at this
  pose and cannot be the cause of anything". It is the **registered `refutedBy`** for
  `fog-owns-desaturation` in `tools/refuted.json`, it is quoted in T2b above as *"the better
  experiment"*, and it is in the paste-ready §8 correction in T2c that a future wave is meant
  to land in `docs/KNOWN_ISSUES.md`. Its control — *"`--skip bloom` differs at byte 44, so the
  skip mechanism itself works"* — is void the same way: `bloom` is a pass too. Byte 44 is the
  **50%-of-pixels nondeterminism the same report documents 30 lines later**.
* `reports/tonemap.md:70-76` — a five-column table whose `--skip volumetricFog` arm is the
  shipped build, concluding the pass "is worth +0.49 codes".
* `reports/taa.md:164,221` — convergence measured under `--skip volumetricFog,ocean`; the
  `ocean` half worked and the other half did not.
* `tools/_convprobe.mjs:16` (the tool behind §26's convergence table) and `tools/_chab.sh:16`
  (`--skip ssr` in the character A/B) both document the dead form in their usage.
* `reports/ocean_waveH.md` measured it independently and wrote **"(Confirmed again.)"**.

This is §4/§9/§28 in one more costume: *a control arm that cannot fail*. `tools/nulltest.mjs`
and `tools/ablate.mjs` are the instruments that actually toggle a pass, and a concurrent
agent has since made `tools/capture.mjs` **exit 2** on a `--skip` name that is not a module,
so the command is dead going forward. What was missing is the retraction on the results
already drawn from it, which is the propagation failure R9b names. `claimcheck` now lists
them: 8 sites, 4 annotated here, **4 left**.

> **NEEDS: `reports/vegetation.md` (:49-50), `reports/tonemap.md` (:70), `reports/taa.md`
> (:164).** One line beside each: *"`--skip <pass>` reached no pass (`skip-flag-can-disable-a-pass`
> in `tools/refuted.json`); this arm is the shipped build. Re-run with `tools/ablate.mjs`."*
> `vegetation.md` is the one that matters — until it is re-run with `togglePass`, **nobody has
> measured whether `volumetricFog` writes pixels**, and §8's second attribution is unsupported
> rather than disproved. §8's conclusion still stands on §18, which was measured properly.

### Noticed, not done (round 7)
* **`reports/structures.md:292` reaches the right conclusion from the dead flag** ("`--skip
  volumetricFog` at 113.57 → 113.63 ... i.e. noise"). It reads as a successful null result and
  is actually a measurement of nothing. Left alone: not my file, and its conclusion is right.
* **The §8 attribution has now been wrong three times** (albedo → `volumetricFog` → a tonemap
  highlight roll-off), and the heading in `docs/KNOWN_ISSUES.md` still advertises the second.
  T2c's paste-ready block should have its `--skip volumetricFog` sentence replaced by §18's
  depth-clear evidence before anyone lands it.
* **`tools/_chab.sh` and `tools/_convprobe.mjs` now exit 2** on their own documented usage
  lines, because of the (correct) new fatal name check. They are one-line doc fixes for their
  owners; I did not edit other agents' probe tools.
* **A stray backtick in a template not marked `/* glsl */` is still unscanned.** There is
  exactly one in `src/` today (`src/render/passes/dof.js:239`, a one-line
  `` `const vec2 KERN[${TAPS}]…` ``), so the exposure is small; widening the opener regex is a
  one-line change if a second ever appears.

## Verified 2026-07-31 — T3 fire-test (lens: has anyone seen this gate trip)

T3 (`tools/refstamp.mjs`) was installed round 3 and, per its own note, had "would have caught:
nothing yet" — an untripped gate is not a known-working one. This pass constructed the failure
it targets and confirmed the gate behaves as documented, without touching the real `ref/` or
`tools/ref_manifest.json`:

* Copied `tools/refstamp.mjs` unmodified plus a 60-file subset of the real `ref/` tree (all of
  `roi/`, `detail/`, the top-level `*.json`, and three `keyframes/*.png`) into a scratch dir
  under `/tmp`, generated a manifest scoped to that subset, and confirmed `--verify` reports
  `ok` (exit 0) on the untouched copy.
* Simulated a silent re-extraction: appended a byte to one keyframe PNG (**changed**), deleted
  one ROI crop (**removed**), and dropped in a copy of an unrelated file under a new name
  (**added**). `--verify` caught all three in one run, named every path, and exited 1 with
  *"Deltas against scores/history.jsonl and docs/TARGETS.md are no longer meaningful."*
* Reverted the synthetic drift and reran `--verify`: back to `ok`, exit 0 — the gate is not
  stuck failing once the drift is undone.
* `node tools/refstamp.mjs --verify` against the **real** `ref/` (216 files) was run before and
  after the scratch test: `ok` both times, confirming the scratch work never touched it.

No harm: `node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards` (exit 0).
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → `{"ok": true,
"via": "daemon", ...}` (exit 0), PNG written. `git status` before and after this pass is
identical except for pre-existing concurrent-wave edits to `scores/provenance.jsonl` and
`tools/score.mjs` that this session did not make and did not touch.

**Turn it off:** it already is — `refstamp` is not wired into `preflight` or CI, by the design
note in its own T3 entry; it only runs when invoked (`npm run refstamp` or the pre-publish
checklist step in `docs/AGENT_BRIEF.md` R9b). Nothing to disable.

---

## Installed 2026-07-31 — round 9 (lens: the sibling list nobody could see)

### D1. `tools/contracts.mjs` + `tools/contracts.json` — a named registry of cross-file contracts and their implementers

**Files:** `tools/contracts.mjs` (new), `tools/contracts.json` (new). Read-only grep over
`src/`; no capture, no `src/` edit, never fails a build.

**The recurrence this closes.** Every contract in this codebase has 3-5 implementers, a fix
lands in one, and the siblings are rediscovered a wave later:

* **Velocity producers (KNOWN_ISSUES #1).** `scene.js` + `taa.js` were fixed together, but
  there are three velocity *producers*, not one — `terrain.js` and `vegetation.js` opt out
  of `scene.overrideMaterial` and carry their own G-buffer material. `terrain.js` was
  accidentally already correct; `vegetation.js` stayed on the old, jittered pairing for two
  full waves until Wave G measured `meanY +1.570e-04` on matId 5 (foliage) in isolation.
  `motionBlur.js` carried a matching `+0.5*uJitter` compensation that also had to flip in the
  same change.
* **Collider producers (KNOWN_ISSUES #12).** Four producers audited by hand: `rocks.js`
  fixed in Wave E ("every collider `rocks.js` produced was silently discarded — all sea
  stacks, cliffs and boulders were non-solid"), `structures.js` left open (oriented boxes
  `physics.js` has no OBB case for) until a later wave.
* **Shared depth (KNOWN_ISSUES #18).** `dof`, `motionBlur`, `taa`, `ssao`, `ssr` and water
  refraction all sample `pipe.depthTex`; it was silently clobbered by the viewmodel's
  `clearDepth()` and the consumers were discovered and re-tuned one at a time across three
  waves before the source bug in `scene.js` was found and fixed once.
* **`reports/clouds.md` #10.1** records the same class again, inside a file none of the
  above five consumers touch: `cloudComposite.js` linearises `pipe.depthTex` with the MAIN
  camera's `uNear`/`uFar` against depth written through the VIEWMODEL camera's own
  projection — still open, needs an owner of `scene.js`.

**What it is.** A hand-maintained JSON registry, `{contract-id: {pattern, scanDirs,
knownIssue, status, ...}}`, printed by a small CLI — the same shape as `tools/tells.mjs`
(name -> pattern, read-only, `--audit`, `--json`), per the reviewer's note that no simpler
one-line-npm-script substitute exists here: the value is the named, versioned mapping
surviving across agents, not the ripgrep incantation itself.

```
node tools/contracts.mjs                    # every contract, match counts, status
node tools/contracts.mjs <id-or-substring>   # that contract's implementers, with line numbers
node tools/contracts.mjs --audit             # contracts no report has ever named (mirrors tells.mjs)
node tools/contracts.mjs --json
```

Seeded with the three contracts named above: `velocity-producer`
(`uCurrViewProj|vVegCur|prevClip`), `collider-producer`, `depth-consumer`
(`pipe\.depthTex|\btDepth\b`). Verified against the current tree: `velocity-producer` finds
exactly the 4 files KNOWN_ISSUES #1 names (`GBufferMaterial.js`, `scene.js`, `terrain.js`,
`vegetation.js`); `depth-consumer` finds exactly the 12 files that read `pipe.depthTex` or
`tDepth` today, including `cloudComposite.js`.

**The `collider-producer` pattern was corrected, not copied.** The reviewer's suggested
pattern for this contract was `addStatic\(` alone. Run against this tree, that matches
**one file — `src/game/physics.js`** — and none of the three producer files KNOWN_ISSUES #12
actually audits (`props.js`, `structures.js`, `rocks.js`). A pattern that only ever points a
fixer at the file that already validates colliders correctly, and never at the ones that
produce the malformed ones, would have reproduced the exact failure this tool exists to
prevent — silently, since a query that "succeeds" (prints one real file, no error) gives no
signal that it missed the point. Broadened to `colliders\.push\(|addStatic\(`, which is the
literal call every producer makes; re-verified to return all 4 files
(`physics.js`, `props.js`, `rocks.js`, `structures.js`). Documented in the registry's own
`note` field so the next person to touch this entry sees why it isn't the one-liner.

### Proof it fires

Constructed in a scratch tree under `/tmp` (never in this repo), mirroring the real
`collider-producer` shape: `rocks.js` "fixed" (pushes a collider via `colliders.push`),
`structures.js` still holding a plain-array box collider (the exact class of bug
`rocks.js` had), `physics.js` as the registration site.

```
$ node tools/contracts.mjs collider-producer
3 file(s) currently implement this contract:
  src/game/physics.js       (lines 3)
  src/world/rocks.js        (lines 4)
  src/world/structures.js   (lines 4)
```

The still-broken sibling (`structures.js`) is in the printed list, one command, no grep
incantation to re-derive. Also verified: a malformed `pattern` in the registry degrades to a
printed `ERROR:` line and exit 0 rather than throwing (`(unterminated` tested directly); an
empty `reports/` directory makes `--audit` report "0 file(s) in reports/" rather than
crashing. Then re-ran the same three commands (`velocity-producer`, `collider-producer`,
`depth-consumer`, plus `--audit` and `--json`) against the real, clean tree — see the file
counts two paragraphs up, which match `KNOWN_ISSUES.md`'s own audited sibling lists exactly.

### How to run it

```bash
node tools/contracts.mjs <contract-id>
```

One line added to `docs/AGENT_BRIEF.md`: before closing a defect that names a contract, run
this and state in the report what was found in each sibling file.

### How to turn it off if it becomes a nuisance

It cannot block anything — it is not wired into `preflight`, `postflight`, npm scripts, or
CI, and it exits 0 in every case tested above, including a broken registry entry. To remove
it entirely: delete `tools/contracts.mjs`, `tools/contracts.json`, and the one line in
`docs/AGENT_BRIEF.md`. To silence one noisy or stale entry: delete its key from
`tools/contracts.json` — the tool re-derives everything else from what remains.

### Noticed, not done (round 9)

* `tools/contracts.mjs`'s `--audit` citation check is a literal substring match on the
  contract id inside `reports/*.md` (same technique `tells.mjs` uses for tell ids). It is
  brand new, so right now it reports all three contracts as "named by no report" — that is
  the honest, expected state on the day the registry is created, not a defect in the check.
* Not attempted: inferring contracts automatically from the call graph or from
  `KNOWN_ISSUES.md`'s prose. That was the reviewer's exact caution against a registry that
  goes stale — automatic inference here would silently mis-scope a pattern (as the literal
  `addStatic\(` suggestion did) with nobody around to notice, whereas a hand-written entry's
  mistake is visible the first time a human reads its output.
* A fourth candidate contract was visible in the evidence but not registered: whatever
  writes vs. reads `ctx.config.mvLegacyJitter`/`vmLegacyDepth`-style A/B flags — several
  passes each read one of these independently and a new pass that forgets to consult its
  flag would silently stop flipping with its siblings. Left out because, unlike the three
  above, no known defect has actually been traced to it yet; adding a pattern for a contract
  with no documented failure is exactly the speculative surface this tool is supposed to
  avoid.

---

## Installed 2026-07-31 — round 10 (lens: gates — the refusal that was never wired to the fetch)

Three gates already existed in this repository and were installed one step away from the
moment they could fire. This round moved them to that moment. Nothing new was invented.

### G13. `capture.mjs` refuses a daemon that serves a different tree
**Files:** `tools/capture.mjs` (`refuseForeignDaemon()`, called from `daemonPort()`)

Round 5's "Noticed, not done" asked for exactly this, in these words: *"a daemon `/health`
field carrying its own repo root so `capture.mjs` can refuse a daemon whose root !=
process.cwd()"*. G12 built the field and put the refusal in `preflight` — but `preflight`
resolves `ROOT` from its own file, so it can only fire when it is run **inside** the second
checkout, and the documented workflow (`docs/AGENT_BRIEF.md`, "Before you measure anything")
is to run it in the main tree and then capture. For the failure it was written for — a
scratch copy, a git worktree, a bisect — check 7 is structurally unreachable.

`daemonPort()` fetched `/health` and read only `r.ok`, discarding the body. It now parses it
and compares `realpathSync(health.root)` to its own `ROOT`.

Would have caught: the round-5 reviewer's live hit — three deliberately broken files under
`/tmp` captured `ok:true` with all three integrity channels empty, served from `/workspace`,
and they "nearly recorded the gate as failing". Every two-tree operation (`ablate.mjs`,
`nulltest.mjs`, bisecting a regression, verifying a fix) is exposed to the same confident
null result.

Cost: one string compare on a response the function already awaited. It cannot fire in the
main tree (roots match) and cannot fire on a daemon built before G12 (no `root` field →
returns without judging, same guard `preflight` uses). Exit 5. Escape hatch:
`HALO_ALLOW_FOREIGN_DAEMON=1`; the message also names `HALO_NO_DAEMON=1`, which is the fix
that gives you a correct measurement rather than merely an unblocked one.

**Proof it fires:** a 2.9 MB copy of `src tools package.json vite.config.js index.html` under
the scratchpad, `node_modules` symlinked, `node tools/capture.mjs --pose ref_00000 --out
/tmp/foreign_smoke.png --settle 8` → the FATAL block, naming daemon root
`/workspace/zer0/products/halo` (pid 2125532) against the scratch tree. The same command in
`/workspace` → `ok:true`, 4.9 MB PNG, unaffected.

### G14. `capture.mjs` refuses to add one pose to a directory that already holds others
**Files:** `tools/capture.mjs` (block above the integrity gate; `--allow-stale` in `KNOWN_FLAGS`)

`tools/shotcheck.mjs` diagnoses this and is wired into **nothing** — not `preflight`, not
`postflight`, not CI, not a wave script. Its own docblock states the mechanism: this file
never clears `--outdir`, and `score.mjs` measures *every* `ref_*.png` it finds there, so
`node tools/score.mjs --pose ref_00450` — the second invocation in `score.mjs`'s own
docblock — captures one pose into `shots/latest` and averages it with eight frames from
whenever that directory was last full. Every existing gate passes: capture exits 0, all
three integrity channels are clean (the stale frames came from a build that was also
complete), `n` is still 9 so `historycheck`'s pose-count check is satisfied, and the row is
indistinguishable from a real one.

It is on disk right now. `shotcheck` reports `shots/latest` — 9 frames spanning **18,810 s**,
eight at `2026-07-30 16:49:02` and one at `22:02:32` — and `scores/rescore_latest.json` was
written from that mixture with `"n": 9`.

The refusal is deliberately narrow, because `shots/latest` is also the machine's junk drawer
(`ab_*.png`, `ch_*.png`, probe output): it fires only when a single `ref_NNNNN` pose is
written into a directory that already holds a *different* `ref_NNNNN.png`. `--all` rewrites
the whole set, `--out` writes one named file, `--video` writes a numbered sequence, and a
non-`ref_` probe pose is never scored — none of those can produce the mixture and none of
them trips it. `--selftest-integrity` is excluded so the CI verification step stays green.
Exit 6. Escape hatch: `--allow-stale` / `HALO_ALLOW_STALE=1`.

**Proof it fires:** `node tools/capture.mjs --pose ref_00450 --outdir shots/latest --settle 8`
→ exit 6, naming the eight frames it would not have rewritten. With `--allow-stale` it
proceeds past the gate. `--all` into the same directory is unaffected.

### G15. `tools/advisory.mjs` — a crashed check is no longer the same colour as a passing one
**Files:** `tools/advisory.mjs` (new), `.github/workflows/preflight.yml` (four `|| true`
steps replaced by one), `package.json` (`advisory`)

CI ran its four trust checks as `node tools/citecheck.mjs --warn || true`, etc. `|| true`
discards the one bit that says whether the check ran at all: a tool that dies on startup —
a hand-edited `tools/refuted.json` that no longer parses, a renamed input — is swallowed
exactly like a clean pass and the job stays green.

That is this project's signature failure, not a hypothesis. Round 5 of this ledger is titled
"the check that cannot fail" and found that `citecheck` "had a **second** way of never
measuring anything"; `KNOWN_ISSUES` §28's own reproduction runs `git show <bad> | grep -c`,
which prints `0` for a dangling SHA — "indistinguishable from a true negative". Wrapping the
guardrails in `|| true` rebuilds the same hole one level up.

The wrapper keeps the exit code and uses the convention already documented in `provcheck`,
`dupcheck`, `scalecheck`, `shotcheck`, `axischeck` and `contracts`: `0` ok, `1` findings,
`>= 2` the tool broke. Findings stay advisory and never turn CI red. Exit `>= 2`, death by
signal, or a Node stack trace on stderr (uncaught exceptions exit 1, colliding with
"findings", so the trace is matched directly) is reported as **BROKE** and exits 1.
`shotcheck --warn` is in the default set, which is how G14's evidence above was produced.

**Proof it fires:** the four real checks → `advisory ok — 4 check(s) produced a result`,
exit 0, with `shotcheck`'s `shots/latest` finding printed and advisory. A deliberately
crashing command → `BROKE  — uncaught exception (exit 1)`, exit 1.

### G16. The pre-commit gate covers the instruments and the record, not only `src/`
**Files:** `tools/stagedcheck.mjs` (new), `.githooks/pre-commit` (second line)

Round 7's "Noticed, not done" named this. `.githooks/pre-commit` inspected staged `src/**.js`
only, so `tools/*.mjs`, `tools/*.py` and every `*.json` / `*.jsonl` committed unchecked —
including the files the measurements are made *with* and the file they are recorded *in*.
`scores/history.jsonl` is the only longitudinal record, **17** files under `tools/` and
`docs/` read it, and it is hand-edited: its last row is a hand-typed `{"tag": "== POSE REFIT
LINE ==", ...}` marker somebody added after the fact. `tools/refuted.json` and
`tools/contracts.json` are hand-written registries whose only job is to make a gate fire; a
malformed one does not make the gate loud, it makes the gate crash — which until G15 above
CI printed and then discarded. `tools/checkpoint.md`'s own warning ("an agent killed
mid-edit can leave a file that does not parse... it took the whole build down twice here")
was never specific to `src/`.

Same staged-blob technique and the same reason as `parsecheck-staged.mjs`: `git show :<path>`
is the exact bytes about to become a commit, and with a dozen agents on one checkout the
working copy of an unrelated file is routinely mid-write (§16). `node --check` for JS,
`python -m py_compile` for Python (skipped, never failed, if no interpreter is present),
`JSON.parse` per file and per JSONL line, plus a missing-trailing-newline check on JSONL
because the next append would then land on the same line and corrupt both rows. Fail-open on
its own errors. `git commit --no-verify` still bypasses everything, as `2651d8c` needed.

**Proof it fires, and does not cry wolf:** in a scratch git repo, a truncated `.mjs`, a
broken `.py`, a trailing-comma `.json` and a half-written `.jsonl` row are all four reported
and exit 1. Staging **every** real `tools/*.mjs`, `tools/*.py`, `tools/*.json`,
`scores/*.json`, `scores/*.jsonl` and `package.json` in a scratch repo → exit 0, no false
positives.

### Proof of no harm (round 10)
`node tools/parsecheck.mjs` → 0, "42 files parse, no GLSL template hazards".
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → 0, 4.9 MB
PNG, all three integrity channels empty, 5.2 s via daemon.
`npm run selftest` → `detected 3, expected 3`. `node tools/advisory.mjs` → 0.
No `src/` file was read for anything but parsing, and none was written.

### How to revert
`git checkout -- tools/capture.mjs .githooks/pre-commit .github/workflows/preflight.yml
package.json && rm tools/advisory.mjs tools/stagedcheck.mjs`. Nothing else reads any of it.

### Noticed, not done (round 10)

* **`shots/latest` is still a mixture** — 9 frames 5 h 13 m apart, and
  `scores/rescore_latest.json` was written from it with `"n": 9`. G14 stops the *next* one;
  it deletes nothing, because a stale frame is evidence. Whoever owns that number should
  either re-capture the set into a fresh tag or annotate `rescore_latest` as uncomparable.
  Any report quoting it is quoting an average across two builds.
* **`--rescore` bypasses G14 entirely**, because it takes no capture at all — it measures
  whatever PNGs are already in the directory. `score.mjs` is the only place that could gate
  it (one `shotcheck` call before it measures), and it is owned elsewhere. **NEEDS:
  `tools/score.mjs`** — before the `readdirSync(...ref_\d+\.png...)` line, run
  `node tools/shotcheck.mjs <outdir>` and refuse a `--rescore` over a directory that holds
  more than one capture, unless `--allow-stale`.
* **The daemon-root refusal cannot help the standalone path**, which boots its own vite from
  `ROOT` and is correct by construction — but `HALO_NO_DAEMON=1` is now load-bearing for
  scratch-tree work and appears in exactly one place an agent will read it: G13's own error
  message. That is the right place; noted so nobody deletes it from the string.
* **`stagedcheck` does not validate JSONL *schema*, only syntax.** A row with the right
  braces and the wrong keys (a `history.jsonl` row missing `axes`, say) commits clean.
  `historycheck.mjs` is where that belongs and it already runs in CI; not duplicated here.
* **Nothing still gates on `preflight` at capture time.** A concurrent wave added a loud
  NOTE to `capture.mjs` when no preflight stamp exists for the tree, which is the right
  first step. Turning the note into a refusal costs ~1.7 s per invocation and `capture.mjs`
  is spawned in loops by `knobcheck`, `nulltest`, `ablate` and `previewsheet`; it needs a
  per-tree cache keyed on the `src/` content hash before it can be a gate, not a drive-by.

---

## Installed 2026-07-31 — round 10 (lens: recurrence)

Four failures that happened **more than once**, none of them gated. Round 7's C1–C3 covered
the backtick trap, the voided frame-time numbers and the dead `--skip` flag; these are the
next four, found by reading every `reports/*.md` for the words an agent writes when they
have just rediscovered something.

### E1. `tools/nulltest.mjs` — the ALIVE verdict now has a control leg
**Files:** `tools/nulltest.mjs` (one block on the ALIVE path, new exit code 4)

nulltest declares `ALIVE — tuning it is meaningful` on any byte difference between the two
arms. That is only evidence if two captures of the *same* build would have been identical,
and at some poses they are not:

* `reports/vegetation.md` §"FIRST: the renderer is non-deterministic again" — two
  back-to-back captures of the identical build at `ref_00720` differ in **50.0% of pixels**;
  with `--skip vegetation` still **38.5%**. "This is blocking for everyone: it puts a noise
  floor under every A/B in the project."
* `reports/taa.md` §4 — a ~0.63 mean / **55%-of-pixels ±1** floor exists between *any* two
  frames.
* KNOWN_ISSUES §16 — a determinism check returned BROKEN purely because `structures.js` was
  saved between the two captures.
* Round 7's C3 is the same coin's other face: `reports/vegetation.md`'s `--skip bloom`
  control read "differs at byte 44" as proof the mechanism worked, when byte 44 *is* that
  nondeterminism — and the arm skipped nothing anyway, because `--skip` never reached a
  pass (retracted in `tools/refuted.json`; `tools/capture.mjs` exits 2 on it today).

Every "determinism re-verified bit-exact" note on record (§10, and the Wave G and Wave H
status blocks) was measured at **`ref_00000`** — nulltest's default pose — and read as a
whole-project property. Where it does not hold, the DEAD branch is unreachable and ALIVE
prints no matter what the subject does: a PASS that cannot fail, the §4/§9/§28 shape.

Now: on the ALIVE path only, the ON arm is captured a second time and byte-compared. If the
control differs, the verdict is **UNDETERMINED (exit 4)**, naming both causes in order
(`src/` churn per §16 first, genuine pose nondeterminism second) and pointing at
`tools/ablate.mjs`, which toggles inside one page load and has no between-capture window.
`tools/knobcheck.mjs:246` already ran this control for `--ab`; nulltest did not.
Cost: one extra capture, and only where the verdict is at stake.

### E2. `--settle` must be a multiple of 16 — `capture.mjs` says so before the capture
**Files:** `tools/capture.mjs` (one warning, advisory)

`reports/taa.md` §4 measured it: with a fixed `α = 0.09` the converged still is **periodic
with period 16**, not a fixed point. Phase-matched frames (48/64/96/128) agree to 3 code
values; **48 vs 49 differs by up to 53 code values** on exactly the high-contrast rock/sky
silhouettes `detail` and `structure` look at. That report's own words: *"Anyone who just
bumps the settle to 50 will move scores and blame their own subsystem."* KNOWN_ISSUES §26
priced the class at **0.52 composite points** (`waveG` vs `waveG-settle96`, identical code)
and **−3.55 on `ref_01500`** alone.

It has already happened at least three times and every number is still quoted as a result:
`reports/characters.md:73` and `:141` (the whole character A/B at `--settle 24`),
`reports/sky.md:167` (`--settle 24`), `docs/KNOWN_ISSUES.md:308-309` (§9's `exposureEV` A/B
at `--settle 40`). **24 and 40 are both phase 8** — half a period from the settle-48
baseline every row in `history.jsonl` uses. G11's `provcheck` records the settle *after* the
fact by joining provenance to the history row; this says it before the capture is spent.

Advisory, one line, and **silent below 16** — a value that has not completed one TAA period
is obviously a smoke capture (`--settle 8` is this repo's own smoke command), and a gate
that fires on the project's canonical green command is the I1 cry-wolf failure.

### E3. An argv token containing whitespace is fatal
**Files:** `tools/capture.mjs` (one check inside the existing argument-hygiene block)

`reports/ocean_waveH.md` §1: *"zsh does not word-split an unquoted `$args`, so a scripted
sweep silently passes `"--skip ocean"` as one token and every variant comes back
byte-identical."* Every arm of that battery was the shipped build. The existing unknown-flag
*warning* fired and the capture still exited 0 with a perfectly normal frame; the
`--only`/`--skip` name check could not see it, because `arg('skip')` never matched and
`OPT.skip` stayed null. Byte-identical is also the signature of an inert pass
(`skip-flag-can-disable-a-pass`), and this project has confused the two at least four times
(C3). This is the second zsh-quoting hazard on record after R5-A's `:s` modifier.

Fatal (exit 2), zero false positives by construction: no flag this file defines contains a
space. Verified: `node tools/capture.mjs "--skip ocean"` → exit 2; every legitimate command
in the repo unaffected.

### E4. `tools/roicheck.mjs` + `tools/roi_notes.json` — what is actually in the crop
**Files:** `tools/roicheck.mjs` (new), `tools/roi_notes.json` (new), `package.json`
(`roicheck`, `contracts`)

The ROI regions are **fixed screen rectangles, not semantic masks**. That caveat is written
down three times — `docs/TARGETS.md:47`, `docs/LOOP.md:171`, `docs/KNOWN_ISSUES.md:110` —
and attached to nothing, so **four agents rediscovered it independently**, each into their
own report where the next agent could not see it:

| report | what they found |
|---|---|
| `reports/sky.md:17` | "`sky_sun` at ref_00720 **is not sky**" — the crop is terrain |
| `reports/clouds.md:310` | "That crop is not sky. At ref_00000 it contains sea stacks and cliff" |
| `reports/weapons.md:279` | "Do NOT tune to `ref/roi_signatures.json`'s `weapon` row. It is a clip mean over a screen rectangle that is ~65% sand" |
| `reports/ocean.md:115` | "This is the **third time in this file's history** that a number was measured against something that was not water" |

**A statistical gate was tried first and rejected on measurement.** A robust-z outlier scan
of `lap_var`/`lum_mean` per region over the nine scored keyframes does **not** reproduce any
of the four findings — `sky`@`ref_00000` reads −0.5σ and `sky_sun`@`ref_00720` reads −2.2σ,
while the loudest outliers (`rock`@`ref_01500`, +13σ) are crops doing exactly their job. A
check that fires on the wrong regions and misses every documented one is the `addStatic\(`
lesson from round 9. So the registry is hand-written and quotes its source, same shape as
`tells.mjs` and `contracts.mjs`.

`--drift` is the part that *is* mechanical and runs on every invocation: the REGIONS rect
table is duplicated verbatim in **four** files (`tools/roi.py`, `_imdiff.py`, `_cloudstat.py`,
`_vegmask.py`) and `ref/roi_signatures.json` + `docs/TARGETS.md`'s published targets were
computed through `roi.py`'s copy. They agree today on every shared key; a copy that drifts
silently stops being comparable to the published target. A region local to one tool
(`_cloudstat.py`'s `zenith`) is reported as a note, not a failure — nothing published is
measured through it.

Live finding from `--audit`: **`characters.md`, `depthfx.md` and `postfx.md` all quote the
`weapon` region** without citing the caveat that it is ~65% sand.

### E5. `world-material-hook` registered in `tools/contracts.json`
**Files:** `tools/contracts.json` (one entry)

`applyWorldMaterial` ends by calling `lighting.registerMaterial()` → three's
`CSM.setupMaterial()`, which does a bare `material.onBeforeCompile = …` with no chaining and
**discards the hook `applyWorldMaterial` installed one line earlier**.

`reports/weapons.md:267` found it from the viewmodel side in wave 1 and wrote *"This affects
every world material in the project, not just the viewmodel — not my file to fix."*
`reports/characters.md:35` found it **again** from the actor side a wave later: *"reports/
weapons.md found the same bug from the viewmodel side in an earlier wave … It is still
unfixed centrally."* Consequence measured there: `aFx` per-vertex roughness/metalness never
reached the BRDF, so every actor surface shaded at the base `roughness 0.6 / metalness 0.1`
— "one matte plastic for the whole cast" — and `characters.md:224`/`:270` record constants
then tuned against that fallback shade. `props.js:618`, `vegetation.js:414`,
`terrain.js:1481` and `rocks.js:1735` each carry their own local comment explaining the
stomp: five files, five independent discoveries, no sibling list.

`node tools/contracts.mjs world-material-hook` now prints all **10** implementers with line
numbers. Verified the pattern is scoped to call sites: `env.js`, `ocean.js` and `ssao.js`
mention `applyWorldMaterial` only in prose and are correctly not listed.

### Proof of no harm (round 10)
`node tools/parsecheck.mjs` → exit 0, "42 files parse, no GLSL template hazards".
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → **exit 0**,
`"ok": true`, `"via": "daemon"`, all three integrity channels empty, 4.9 MB PNG, and **no new
warning on stderr** (settle 8 is below the multiple-of-16 check by design).
`node tools/parsecheck-staged.mjs` → 0. `node tools/preflight.mjs` → **exit 0**, 12/12 checks
ran, the same 4 advisories as before this round. `package.json` re-serialised and re-parsed;
the concurrent wave's `blindcheck`/`advisory` entries preserved. No `src/` file was read for
edit. `tools/metrics.py`, `tools/score.mjs`, `tools/blind.mjs`, `docs/LOOP.md` and
`docs/KNOWN_ISSUES.md` were **not** touched. No measurement changed semantics, no band moved,
nothing new runs inside the capture loop.

### How to revert
`git checkout -- tools/capture.mjs tools/nulltest.mjs tools/contracts.json package.json`
and `rm tools/roicheck.mjs tools/roi_notes.json`. Nothing else reads any of it; `roicheck`
and `contracts` are not wired into preflight, postflight or CI.

### Turn one thing off
1. E2 is a `process.stderr.write` — delete the `if (OPT.settle >= 16 …)` block.
2. E3 — delete the `glued` block; the pre-existing warning for the same token stays.
3. E1 — delete the control-leg block; `const ctl = …` down to `process.exit(4)`.
4. E4/E5 cannot block anything: they are hand-run and exit 0 except on a direct lookup of a
   flagged region (exit 1) or genuine rect drift.

### Noticed, not done (round 10)
* **`--settle 48` is the whole history's phase, and `tools/knobcheck.mjs` defaults to 16.**
  Both are multiples of 16 so neither warns, but they are *different* phases of the same
  limit cycle, and a knobcheck arm is therefore not comparable to a scored capture. Not
  changed: altering knobcheck's default moves numbers already written into reports.
* **The `weapon` ROI is ~65% sand and three reports quote it anyway** (`--audit` above).
  **NEEDS: `reports/characters.md`, `reports/depthfx.md`, `reports/postfx.md`** — one line
  each: *"the `weapon` region is a screen rectangle that is ~65% sand
  (`reports/weapons.md:279`); this number is not a viewmodel measurement."*
* **Nothing has ever recorded the run-to-run spread of a score axis.** `reports/metrics.md`
  §6.1: *"nobody has ever run the same build twice and recorded the run-to-run spread of any
  axis. Until someone does, no single-wave composite delta under about 2 points should be
  believed — mine included."* E1 gives the per-frame version of this for one pose; the axis
  version needs two full scored runs of one unchanged tree and an owner willing to spend
  them. That is the single cheapest thing that would make every wave's headline number
  interpretable, and it is still not on disk.
* **The `world-material-hook` fix is a `src/` change with no owner.** Chain the hook in
  `src/render/lighting.js:83`'s `registerMaterial`, or in `src/gfx/materialCommon.js:126-127`
  — one place, ten callers. Every local workaround in `props/vegetation/terrain/rocks` can
  then be deleted. Not attempted here: `src/` is owned elsewhere.

---

## Installed 2026-07-31 — round 10 (lens: trust — the two documents nobody ever checked)

Rounds 2, 6 and 8 gated the *written record about measurements* (do citations resolve, do
refuted claims stand, are the units one scale). This round went after the two documents that
are **inputs to the work rather than reports about it**, and which no instrument has ever
read: `docs/API.md` (what every module author codes against) and `README.md`'s rebuild recipe
(the only instruction any second machine will ever have for producing the ground truth).
Both are wrong today, and both were wrong silently.

### V1. `tools/apicheck.mjs` — "These signatures are frozen" is now a checkable claim
**Files:** `tools/apicheck.mjs` (new), `tools/preflight.mjs` (check 11, **advisory**),
`package.json` (`apicheck`)

`docs/API.md` opens with *"**These signatures are frozen.** If you own a module below, you
must implement its interface exactly."* Nothing has ever verified that sentence. It matters
more here than in a normal codebase because the same document tells every consumer to guard
each call — `const y = terrain ? terrain.height(x, z) : 0` — which is correct for a module
that did not load and **silently swallows a member that was never implemented**. `undefined`
propagates as a fallback, never as an error. Same class as §12 (every collider `rocks.js`
produced was silently discarded) and S1 (`H.setConfig(obj)` wrote `config['[object Object]']`
and "returned quietly").

**Live finding — three members of the `sky` contract do not exist in `src/world/sky.js`:**

| documented (`docs/API.md:36`) | readers | consequence |
|---|---|---|
| `sky.envTexture` — "equirect or cube, HDR, for PMREM" | 0 | contract documented, unused both sides |
| `sky.horizonColor` — "used by aerial perspective + fog" | 0 | same |
| `sky.needsEnvUpdate` — "set true when the sky changes" | **1** | `src/render/env.js:724` runs `if (sky?.needsEnvUpdate) { dirty = true; force = true; … }` every frame. `sky.js` never sets it, so **the documented "re-capture the env probe when the sky changes" handshake can never fire.** `env.js` falls back to its own `sunMoveDeg` heuristic plus a time floor, so nothing errors and nothing says so. |

The check is a **name test**, not a signature test, on purpose: a name test has zero false
positives across all 15 documented modules (verified — only the three above are flagged),
while anything cleverer needs a parser and starts inventing findings. It also verifies every
documented `ctx.emit('a:b')` bus event has an emitter in `src/` — all 9 do today.

**Not fixed here.** Implementing `needsEnvUpdate` is a `src/` change owned by a rendering
wave. **NEEDS: `src/world/sky.js` or `docs/API.md`** — either set the flag where the sky
changes, or delete the three lines from the frozen contract. Do not leave the contract
describing code that is not there.

### V2. `tools/refcheck.mjs` — the ground truth's shape, and whether anyone can rebuild it
**Files:** `tools/refcheck.mjs` (new), `tools/preflight.mjs` (check 10, **advisory**),
`package.json` (`refcheck`)

T3 (`refstamp`) fingerprints whatever `ref/` is on disk — the right tool for "did *my*
reference drift". It structurally cannot catch this one: on a fresh machine you generate the
manifest **from your own rebuilt `ref/`**, and it certifies itself green.

**The claim in the docs that is wrong — `README.md:31-33`.** Run verbatim, the documented
rebuild recipe does not reproduce this reference set:

```
$ ffmpeg -i reference.mp4 -vf "select='not(mod(n,15))'" -vsync 0 \
         -frame_pts 1 -frames:v 2 <scratch>/kf_%05d.png     # README.md, verbatim
  -> kf_00000.png   3840x2160,  6.0 MB
$ ref/keyframes/kf_00000.png
  -> 1920x1080,  2.5 MB          (all 157 keyframes on disk are 1920x1080)
```

That is not cosmetic. `tools/metrics.py:298` resizes the **test** image to the **reference's**
size — `test = load(test_path, size=(ref.shape[1], ref.shape[0]))` — so a 4K `ref/` silently
upscales every 1080p render 2x before scoring. `detail`, `lap_ratio`, `edge_ratio` and
`ms_ssim` all move, nothing errors, nothing warns, and the numbers are quietly incomparable to
every row in `history.jsonl`. §26 with a much bigger lever.

Two more defects in the same three-line block, measured the same session:

* `.venv/bin/python tools/roi.py --all ref/keyframes ref/rois` — `roi.py --all` takes an
  **image**, not a directory (`cv2.imread(<dir>)` returns `None` →
  `AttributeError: 'NoneType' object has no attribute 'shape'`, reproduced), and writes to
  `ref/rois` while the tree has `ref/roi`. Run verbatim it crashes.
* That line is captioned *"regenerate signatures"* — but `roi.py` writes crops, not
  signatures. `grep -rn roi_signatures tools/` returns three **readers** (`_pfx.py:15`,
  `nullcheck.py:222`, `refstamp.mjs`) and **no writer**. `ref/roi_signatures.json` has no
  generator in this repository, and neither does `ref/baseline.json` — the AAA ceiling
  `docs/TARGETS.md` and `docs/ARCHITECTURE.md` quote as a pass criterion (see U3), nor
  `ref/detail/*_4k.png`.

So the honest status of the reference set is **MEASURED for the tree on this disk,
UNREPRODUCIBLE anywhere else**, and the tool now says that mechanically instead of in prose.
`refcheck` checks keyframe geometry against the live capture geometry (read from G2's
`_capture.json` `opts.w/h`, falling back to `capture.mjs`'s parsed defaults), the presence of
every artifact something reads, which artifacts have no generator, and both directions of the
README recipe (a `ref/` path named there that is not on disk; a required artifact the recipe
never mentions). `README.md` was **not edited** — it is not this round's file, and the
correction it needs is a measurement someone must own, not a rewording.

### V3. `tools/registrycheck.mjs` — the disproof registry is not exempt from the disproof registry
**Files:** `tools/registrycheck.mjs` (new), `tools/advisory.mjs` (one line in `DEFAULT`),
`package.json` (`registrycheck`)

`claimcheck` scans `reports/*.md` and `docs/*.md`. It does not scan `tools/refuted.json` —
and that file is not passive data: claimcheck **prints its `claim` / `refutedBy` / `truth`
fields verbatim** as the authoritative explanation an agent reads when a claim fires. It is
the most-read prose in the trust chain and the only prose nothing checks.

**Live hit, exactly one, no false positives.** `fog-owns-desaturation.refutedBy` reads
*"reports/vegetation.md:49 is the primary measurement — `--skip volumetricFog` produced a
BYTE-IDENTICAL PNG at ref_00720 (with `--skip bloom` as the control, proving the skip
mechanism works)"*. Every clause of that is refuted by a **different entry in the same file**,
`skip-flag-can-disable-a-pass` (round 7, C3): `PASS_MANIFEST` never consults `skip`, so the
arm *and its control* skipped nothing and byte-identical was guaranteed. C3 corrected the
ledger's prose (T2b item 1 carries the strike-through) and left the registry field standing,
so `claimcheck` still teaches every agent the void experiment as "the primary measurement".
**A disproof that stops at the document that wrote it is §19 — and this is §19 inside the tool
built to stop §19.**

The conclusion of `fog-owns-desaturation` is not in question: §18 measured the real cause and
stands on its own. What is void is one piece of its cited evidence.

**NEEDS: `tools/refuted.json`** — replace that `refutedBy` with the §18 depth-clear evidence,
which was measured properly: *"docs/KNOWN_ISSUES.md §18: `scene.js` cleared the depth texture
shared with the G-buffer, so every world pixel integrated 460 m of haze; fixing it moved
`sat_mean` 55.66 → 61.66. (The earlier `--skip volumetricFog` byte-identical result is void —
`skip-flag-can-disable-a-pass`.)"* **Verified in a scratch copy: that text takes
`registrycheck` to `ok`, exit 0 under `--strict`.** Not applied here because the same sentence
is the registered `refutedBy` a concurrent wave is being asked to land into
`docs/KNOWN_ISSUES.md` §8 via T2c, and the two must move together.

Advisory by default (`--strict` for a human), for round 6's stated reason: this reads prose
and judges it by regex, and its failure mode is blocking an agent over a sentence. An entry is
never flagged for **naming** another entry's id — that is a cross-reference, not a repeat.

### Proof each gate fires
Fixtures built in `/tmp` scratch trees (`src tools docs` only, 2.1 MB — never a `tar` of the
repo, per round 5), never inside the repository:

| tool | test | result |
|---|---|---|
| `apicheck` | real tree | **exit 1**, the 3 `sky` members, `needsEnvUpdate` shown with its reader |
| | doc corrected (3 lines deleted) | `ok — 15 module contract(s)`, **exit 0** |
| | member documented for a module with no file in `src/` | **exit 0**, reported as "not landed", not as a defect |
| | a documented `ctx.emit('ghost:event')` nobody emits | **exit 1**, named |
| | `--warn` on the failing real tree | **exit 0** |
| `refcheck` | real tree | **exit 0**, `ref/` at 1920x1080 ×157, README defects listed advisory |
| | scratch `ref/` holding the **real** README-produced 4K frame | **exit 1**, `1 of 2 keyframe(s) are not 1920x1080` |
| | same, `--warn` | **exit 0** |
| | `ref/roi_signatures.json` deleted | **exit 1**, `MISSING … required by tools/_pfx.py:15` |
| | 4K frame removed again | **exit 0** — not stuck failing |
| `registrycheck` | real registry | 1 hit, `fog-owns-desaturation.refutedBy`, exit 0 / `--strict` **exit 1** |
| | registry with the §18 evidence substituted | `ok — 5 registry entr(ies)`, **exit 0** |
| | `tools/refuted.json` replaced with non-JSON | **exit 2** (BROKE, not a silent pass — `advisory.mjs` reddens on it) |

### Proof of no harm
`node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards`, exit 0.
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → exit 0,
`"ok": true`, all three integrity channels empty.
`node tools/preflight.mjs` → exit 0. `node tools/advisory.mjs` → exit 0, 5 checks produced a
result. `package.json` parses. No `src/` file was opened for edit; `tools/metrics.py`,
`tools/score.mjs`, `tools/blind.mjs`, `docs/LOOP.md` and `docs/KNOWN_ISSUES.md` were not
touched; no band, weight or metric changed; nothing new runs at capture time.

### How to turn it off
1. All three exit 0 under `--warn` (`refcheck`, `apicheck`) or by default (`registrycheck`).
2. Both preflight checks are `add(..., false)` — advisory, they can never fail a wave — and
   each is wrapped in `existsSync`, so deleting the tool makes the check disappear silently.
3. Full revert: `rm tools/refcheck.mjs tools/apicheck.mjs tools/registrycheck.mjs`, drop the
   three script lines from `package.json`, `git checkout -- tools/preflight.mjs
   tools/advisory.mjs`. Nothing else imports any of it.

### Noticed, not done (round 10)
* **`refcheck`'s README audit is path-existence only.** It cannot tell that
  `tools/roi.py --all ref/keyframes …` passes a directory where an image is required — that
  was found by *running* the line. A general "does this documented command actually run"
  gate is the obvious next step and is much bigger than a path test; the specific defect is
  written into the tool's docblock so it survives.
* **`ref/frames_full/` and `ref/contact_sheet.png` are on disk, read by nothing I could find,
  and named in no document.** Left out of the required inventory rather than guessed at.
* **Nothing checks `docs/WORLD.md`, `docs/WEAPON.md` or `docs/ARCHITECTURE.md` against
  `src/`** the way `apicheck` now checks `docs/API.md`. API.md was picked first because it is
  the only one that declares itself frozen and the only one whose consumers are told to guard
  every call.
* **`apicheck` verifies presence, never behaviour.** `terrain.height()` returning `NaN` past
  the sea stacks — which API.md explicitly requires to be defined everywhere — is invisible
  to it, and is exactly the kind of thing a `NaN`-to-framebuffer defect (§24) starts as.

---

## Installed 2026-07-31 — round 10 (lens: adherence — the rule with no command, and the command that could not fail)

Round 8 measured the brief against the reports and bundled the report-side rules into
`postflight`. This round asked the same question of the *machine* side: which gates are
actually reached by the commands people type, and does the hard one still fail when it
should. Two of the four findings are that a gate exists and nothing routes to it; the
fourth is that the project's only hard gate has been unable to fail for as long as this
machine has been on Node 26.

### A11. `tools/parsecheck.mjs` could not detect a syntax error in ANY file under `src/`
**Files:** `tools/parsecheck.mjs`, `tools/parsecheck-staged.mjs` (one argument each)

`node --check <file>.js` **exits 0 on a file that does not parse** whenever that file
contains ESM syntax (measured, Node v26.5.0). `package.json` is `"type": "module"` and 42 of
42 files under `src/` open with `import`, so the parse gate — the **hard** check `preflight`
blocks on, the check `.githooks/pre-commit` enforces, the tool written for §20 and cited in
`docs/AGENT_BRIEF.md`, `docs/LOOP.md` §4 and `blind.mjs --capture` — has been structurally
incapable of failing on this codebase.

Measured, in a scratch copy of `src/` under `/tmp` (never in the repo):

```
$ printf '\nthis is not javascript at all\n'  >> /tmp/ptest/src/world/ocean.js
$ printf '\nconst broken = ;\n'               >> /tmp/ptest/src/render/passes/volumetricFog.js
$ node tools/parsecheck.mjs
ok — 42 files parse, no GLSL template hazards          <- exit 0
$ node -e "import('/tmp/ptest/src/world/ocean.js')"
SyntaxError: Unexpected identifier 'is'                 <- the module is dead
```

That is §20 exactly — `ocean.js` stops parsing, `src/modules.js` skips it silently, the
subsystem vanishes from every frame and gets scored anyway (Waves F and G) — passing green
through the gate built to stop §20. `reports/ocean_waveH.md` §1a already recorded a stray
backtick that "got past `node --check`" and attributed it to an even number of strays
re-closing the template (C1's hole, fixed in round 7). This is a second, wider mechanism
under the same symptom, and C1's scan only covers `/* glsl */` templates.

The pre-commit hook had the same hole through `parsecheck-staged.mjs`, which wrote the
staged blob to a scratch `*.js`. A/B on one fixture in a throwaway git repo under `/tmp`
(a copy of this repo's ocean module, staged at src/ocean.js there, with garbage appended):
**`git show HEAD:tools/parsecheck-staged.mjs` → exit 0** (commit allowed),
patched → exit 1 (commit blocked, correct §20 message). `tools/stagedcheck.mjs:83` already
forced `.mjs` on its own scratch copies "// force ESM parse", so the instruments were
covered and only `src/` was exposed.

**Fix:** parse it as a module — `--input-type=module --check -`, source on stdin, no temp
file, nothing executed. Module mode *only*, not both modes: `"type": "module"` makes the
module goal the correct parse, and keeping the old file-mode check would be a false-positive
generator on any Node that does not auto-detect ESM (CI pins node 22), where
`node --check ocean.js` reports `Unexpected token 'export'` on a perfectly good file.
Verified: real tree 42/42 pass, exit 0, **0.96 s** (was 0.79 s); broken scratch tree names
both files with correct line numbers, exit 1.

### A12. The gate that ran for nobody — `preflight` is wired only to `npm run`
**Files:** `tools/preflight.mjs` (writes `.preflight-stamp.json`), `tools/capture.mjs`
(reads it, prints a NOTE), `.gitignore`, `docs/AGENT_BRIEF.md`

G3 made preflight one command and wired it as `precapture` / `prescore`. Nobody invokes it
that way: across `reports/` and `docs/`, **31** sites run `node tools/capture.mjs` or
`node tools/score.mjs` directly against **3** that mention the npm form — including
`docs/LOOP.md` §4 ("what to do every wave"), which runs `node tools/score.mjs --tag waveX`,
and every proof-of-no-harm in this ledger. Neither `capture.mjs` nor `score.mjs` runs
preflight itself. So posecheck (§17.1), reference coverage (a smaller `n` written to
history with no warning), §16 quiescence, §27's wedged daemon and §29's load check have
been gating a path nobody walks.

Preflight now leaves `.preflight-stamp.json` (gitignored: it describes one tree at one
instant) and `capture.mjs` prints one NOTE when it is absent, failed, or older than the
newest `src/**.js` mtime. **Advisory, and deliberately so** — the §20 outcome is already
fatal at capture through G1's integrity channels, so this is a receipt, not a second gate.
It runs no subprocess and launches nothing (a `stat` walk, ~2 ms), it is inside a
`try/catch`, and it is silent while the stamp is fresh, so it cannot become wallpaper.
Escape: `HALO_NO_PREFLIGHT_NOTE=1`.

### A13. The acceptance gate has been judged once in fourteen scored runs
**Files:** `tools/blindcheck.mjs` (new), `tools/postflight.mjs` (check 8),
`package.json` (`blindcheck`), `docs/AGENT_BRIEF.md` (R2b-2)

`docs/LOOP.md` §5.6: *"Run the blind test every wave, not at the end … Five waves were
spent optimising proxies that a single 30-minute blind test would have invalidated on day
one."* §5.7: *"The blind test is the score."* Measured from the two ledgers: `scores/blind.jsonl`
holds **one** human judgement — `waveH`, whose own note says "backfilled" — against **14**
scored runs in `scores/history.jsonl`. Four runs have landed since, including the
29.44 → 16.85 collapse across the Wave I pose refit, and none was judged.

Why: `docs/AGENT_BRIEF.md` — the file wave scripts inject — **never referenced
`docs/LOOP.md`**, so its seven standing rules reached no agent, and no tool ever compared
the two files. `blindcheck` is that comparison (reads two JSONL files, ~30 ms, never
invokes `tools/blind.mjs`, which is owned elsewhere); `postflight` runs it; R2b-2 in the
brief now points at LOOP §5.2 and §5.7 by name.

### A14. `tools/reportgate.mjs` — the report-side rules get their first automatic trigger
**Files:** `tools/reportgate.mjs` (new), `.githooks/pre-commit` (third stage, advisory)

R7 provenance: 0 of 28. R9 `NEEDS:` routing: 0 of 28, against 26 prose handoffs. Round 8
gave those rules a command (`postflight`) but no trigger — and this project's own diagnosis
is that the failure mode is never "the check was wrong", it is "nobody ran it". Every report
this project keeps passes exactly one machine gate: the orchestrator's commit
(`tools/checkpoint.md`: "the orchestrator should commit after every wave"). The hook already
inspected staged `src/*.js` and staged instruments; it now also prints, for staged
`reports/*.md`, the R7/R9 items — capped at 12 lines, never blocking, **always exit 0**.
It shells out to `reportlint --json` and `needscheck --json` rather than re-implementing
their regexes, so there is one definition of each rule and this cannot drift from it.
Escape: `HALO_NO_REPORT_GATE=1 git commit`; removal is the last two lines of the hook.

### R5 in the brief named the dead instrument
`docs/AGENT_BRIEF.md` R5 — "isolate and measure", the rule the orchestrator quotes most —
told agents to null a term with `--skip <module>`, `--only`, or `--config <term>=0` without
distinguishing modules from passes. `--skip <pass>` reaches no pass (C3,
`skip-flag-can-disable-a-pass`), and `--config k=0` cannot turn off 3 of 7 `*Enabled` gates
(S1). R5 is now a three-row table — module / pass / knob, each with the instrument that
actually works and the one that silently does not — plus the sentence that was missing:
**a byte-identical arm is not a result.**

### Proof of no harm (round 10)
`node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards`, exit 0.
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → exit 0,
`"ok": true`, `"via": "daemon"`, all three integrity channels empty, 4.9 MB PNG, no NOTE
printed (the stamp was fresh — the correct silent case).
`node tools/preflight.mjs` → exit 0. `sh .githooks/pre-commit` on the real tree → exit 0.
`node tools/postflight.mjs`, `node tools/blindcheck.mjs`, `node tools/reportgate.mjs` → all
exit 0. `node -e "JSON.parse(readFileSync('package.json'))"` → ok. No `src/` file was read
for edit; `tools/metrics.py`, `tools/score.mjs`, `tools/blind.mjs`, `docs/LOOP.md` and
`docs/KNOWN_ISSUES.md` were not touched; no measurement changed semantics.

### How to revert
`git checkout -- tools/parsecheck.mjs tools/parsecheck-staged.mjs tools/preflight.mjs
tools/capture.mjs tools/postflight.mjs .githooks/pre-commit .gitignore package.json
docs/AGENT_BRIEF.md && rm tools/blindcheck.mjs tools/reportgate.mjs .preflight-stamp.json`.
Nothing else reads any of it. Note that A11 is the one change that should **not** be
reverted without replacing it: reverting restores a hard gate that cannot fail.

### Noticed, not done (round 10)
* **`score.mjs` still runs no preflight and cannot be edited from here** (owned by a
  concurrent wave). A12's NOTE reaches it only because `score.mjs` spawns `capture.mjs`.
  Two lines in `score.mjs` — spawn `preflight --quiet`, abort on exit 1 — would make the
  gate hard on the path that writes `history.jsonl`. Recommendation for whoever owns it.
* **The `--check` hole is a *class*, not one bug.** Anything in `tools/` that validates
  JavaScript by writing it to a `.js` file and running `node --check` has it.
  `stagedcheck.mjs` is already correct; nothing else in `tools/` does this today, but the
  next tool that does will inherit it silently.
* **`blindcheck` counts runs, not waves.** Four `waveI-*` rows are arguably one wave. It is
  deliberately the harsher reading: `--max-gap N` relaxes it, and the number that matters
  (`0 human judgements since the last refit`) is unchanged either way.
* **Nothing still verifies that the wave script injected `docs/AGENT_BRIEF.md`** rather than
  a re-typed copy. The brief's own "what this brief still does not say" list says so; A12's
  and A13's edits compound only if the file is what agents are actually given.

## Installed 2026-07-31 — round 11 (lens: gates — the green line printed over a hole)

### T4. `tools/preflight.mjs` — a delegating check must say so when its instrument didn't answer

**File:** `tools/preflight.mjs` (edited only; no new file, no semantics changed on any check
that already ran).

**The recurrence this closes.** Three of preflight's ten checks delegate to another script
instead of doing the work inline: check 2 (`posecheck` → `tools/_posecheck.mjs`), check 8
(`provenance` → `tools/provcheck.mjs`), check 9 (`scale` → `tools/scalecheck.mjs`). Before
this round, two of the three were wrapped in `if (existsSync(...))` / `if (d)` — when the
sub-tool was absent, unparseable, or its JSON didn't parse, the whole `if` body was skipped
and the check simply never appeared in `results`. `preflight ok` printed over the hole with no
trace it had ever intended to check pose grounding or scale currency. The third,
`provenance`, was worse: `const n = d?.incomparable ?? 0` never looked at `r.status`, so a
`provcheck.mjs` that crashed, printed a stack trace to stdout, or was deleted still produced
`n = 0` — and preflight printed the *positive* line, `"ok  provenance — adjacent scored runs
share one pose set and one instrument"`, manufactured from a tool that never answered. This is
the exact shape the ledger already names twice — T1/round-1's `git show <dead-sha> | grep -c`
printing `0` (a true-negative's output from a command that could not run) and round-2/§9's
`--config` arms comparing a frame with itself — one level up: a *meta*-gate silently reporting
"the gates are fine" when a gate's own instrument is missing. It is also live-relevant, not
hypothetical: a fresh clone is missing 22 of the 61 files in `tools/` today (round-7's
`guardrails-committed` check, #6 in this same file, measures exactly that), so a fresh clone
hit this hole on three checks simultaneously and `preflight ok` was still the printed verdict.

**What changed.** Added `missing(name, why)`, which records the check as `ran:false` and
prints `SKIP <name> — <why> — THIS CHECK DID NOT RUN` — always advisory (`hard:false`, per
this file's own round-7 precedent: a gate that cannot run must be loud but must never block a
wave, because on a fresh clone *not running* is the normal state for several of these). Wired
into all three delegating checks:
* `posecheck` and `scale` now call `missing()` when their script is absent instead of
  vanishing from `results` entirely.
* `provenance` and `scale` now require a **parseable verdict field** —
  `typeof d.incomparable === 'number'` and `typeof d.status === 'string'` respectively —
  before taking either the pass or the fail branch. A crash, a stack trace on stdout, or `d ==
  null` all route to `missing()`, never to the reassuring branch.
* The verdict line now states its own coverage: `preflight ok — 10/10 checks ran` (or however
  many total checks exist), and a run with holes reads `preflight ok — 7/10 checks ran; 3 DID
  NOT RUN: posecheck, provenance, scale`. `--json` gained `ran`, `total`, `notRun`.

**Fire-tested**, in a scratch copy under `/tmp` built from `git archive HEAD` (never the real
tree):
* Deleted `tools/_posecheck.mjs` and `tools/scalecheck.mjs`, replaced `tools/provcheck.mjs`
  with a script that `throw`s immediately (stdout empty, exit 1, no JSON — the exact shape of
  a crashed instrument). Ran `node tools/preflight.mjs`: printed
  `SKIP posecheck — tools/_posecheck.mjs is not on disk … — THIS CHECK DID NOT RUN`,
  `SKIP provenance — tools/provcheck.mjs --json returned no parseable verdict (exit 1) — THIS
  CHECK DID NOT RUN`, `SKIP scale — tools/scalecheck.mjs is not on disk — THIS CHECK DID NOT
  RUN`, and the verdict line read `[7/10 checks ran]` — the hole is now visible instead of
  silently absorbed into an `ok`.
* Isolated the exact old-vs-new contrast with the three original lines standalone: fed
  `{stdout: "", status: 1}` (a crashed provcheck) through the pre-fix logic
  (`const n = d?.incomparable ?? 0`) and the post-fix logic side by side. Old code prints
  `"ok  provenance — adjacent scored runs share one pose set and one instrument"`. New code
  prints `"SKIP provenance — tools/provcheck.mjs --json returned no parseable verdict (exit
  1) — THIS CHECK DID NOT RUN"`. Same crashed instrument, opposite claim about the tree.
* Restored all three files in the scratch copy and reran: all 10 checks reported `ran:true`
  again (`posecheck` itself then failed on a real defect specific to that partial
  `git-archive` copy — expected, and itself evidence the gate isn't rubber-stamping in either
  direction: present-and-broken still reads differently from absent).
* Real tree, before and after this change: `node tools/preflight.mjs --json` → `total: 12,
  ran: 12, notRun: []` both times — identical checks, identical verdicts, plus the new
  coverage suffix on the text form. No existing check's `ok`/`hard` value moved.

**No harm.** `node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards`
(exit 0). `node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` →
`{"ok": true, "via": "daemon", ...}`, exit 0, PNG written (4.9 MB). No `src/` file touched.

**How to run it:** it already is — `posecheck`/`provenance`/`scale` run every time `node
tools/preflight.mjs` runs, which is every `npm run capture` / `npm run score`
(`precapture`/`prescore`) and the pre-publish checklist. No new invocation to remember.

**Turn it off:** the `missing()` branch is advisory by construction — `hard:false` — so it can
never fail a build or block a wave on its own; the worst it does is add a `SKIP … THIS CHECK
DID NOT RUN` line and shrink the `N/10` coverage count. If the line itself becomes a nuisance
(e.g. deliberately not shipping `tools/_posecheck.mjs` on a lightweight clone), delete the
three-line block that calls `missing()` for that check in `tools/preflight.mjs` and the check
simply stops being attempted — same as before this round, minus the silent hole.

## Installed 2026-07-31 — round 11 (lens: verification — does the E4 gate actually fire)

### V1. E4 re-verified; the "finish it" proposal evaluated and only half-adopted
**Files:** none changed in `tools/`, `tools/roi_notes.json` or `package.json` — this round
added no code. `tools/roicheck.mjs`, `tools/roi_notes.json` and the `roicheck` npm script
already existed in the working tree exactly as E4 describes them, and E4 already documents
them; nothing here duplicates that write-up.

This round was dispatched with a proposal attached: *"finish the one open item — add the
weapon-ROI caveat citation to `reports/characters.md`, `reports/depthfx.md` and
`reports/postfx.md`, then `git add tools/roicheck.mjs tools/roi_notes.json package.json` to
commit the tool — reject this as redundant with E4."* Checked, not taken on faith:

- **The "redundant with E4" framing does not hold.** E4's own "Noticed, not done" section
  lists those three citations as *undone*, not done — an entry documenting a gap is not the
  same as closing it. Rejecting the citation work as "redundant" would have been exactly the
  kind of unverified claim this project keeps warning about propagating.
- **The citation edits were not made anyway — not because they are redundant, but because
  `reports/*.md` is outside this task's file allowlist** (only `tools/` new files,
  `.githooks/*`, `.github/workflows/*`, `package.json` scripts, `docs/META_LEDGER.md`,
  `docs/AGENT_BRIEF.md`, `.gitignore`, and the five named `tools/*.mjs` are in scope). Left
  as a recommendation below, correctly attributed to scope, not to redundancy.
- **The `git add`/commit step was not taken either — because no commit was requested this
  round**, not because it is redundant. `tools/roicheck.mjs`, `tools/roi_notes.json` and the
  `package.json` `roicheck` line remain uncommitted (`git status`: `??`, `??`, `M`) at the end
  of this round. Whoever commits round 10/11's work should include them.

**The gate was made to fail on purpose, off-repo, to check it actually catches something.**
Copied `tools/roicheck.mjs`, `roi_notes.json` and the four `REGIONS`-table files
(`roi.py`, `_imdiff.py`, `_cloudstat.py`, `_vegmask.py`) to a scratch tree under `/tmp`, edited
`_imdiff.py`'s `'sand'` rect from `(0.02, 0.66, 0.55, 0.99)` to `(0.02, 0.60, 0.55, 0.99)`:

```
$ node /tmp/.../roicheck_test/tools/roicheck.mjs --drift
REGION RECT DRIFT — 1 disagreement(s):
  tools/_imdiff.py: 'sand' is (0.02, 0.6, 0.55, 0.99) but tools/roi.py says (0.02, 0.66, 0.55, 0.99)
exit 1
```

Same command against the real, unmodified tree: `ok — 4 REGIONS tables agree with
tools/roi.py on every shared region.`, exit 0. Also re-ran the two lookup paths E4 documents:
`node tools/roicheck.mjs weapon` and `node tools/roicheck.mjs sky_sun ref_00720` both still
exit 1 with the quoted caveat and source; `node tools/roicheck.mjs sand ref_00120` (a region
with no recorded note at that pose) exits 0 with the "nobody has looked yet" line, not a false
flag. `--audit` still reports the same three files (`characters.md`, `depthfx.md`,
`postfx.md`) as quoting `weapon` without citing the caveat — the open item is still open.

### Proof of no harm (round 11)
`node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards`, exit 0.
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → exit 0,
`"ok": true`, `"via": "daemon"`, all three integrity channels (`missing`, `failedModules`,
`missingPasses`) empty, no warnings, 4.9 MB PNG.

### How to revert
Nothing to revert — no file under version control was changed except this ledger entry.
The `/tmp` scratch tree used to force the drift failure was never inside the repo.

### Turn one thing off
Not applicable — E4 was already off by default (hand-run, not wired into preflight,
postflight or CI); this round changed none of that.

### Noticed, not done (round 11)
* **The weapon-ROI citations are still the one concrete remaining edit** (`reports/characters.md`,
  `reports/depthfx.md`, `reports/postfx.md`, one line each near their `weapon` numbers,
  citing `reports/weapons.md:279`'s "~65% sand"). Not done here because `reports/*.md` is
  outside this round's file allowlist; whoever owns those reports should close it.
* **`tools/roicheck.mjs`, `tools/roi_notes.json` and the `package.json` `roicheck` line are
  still uncommitted.** They exist correctly in the working tree; nobody has run `git add` on
  them yet.

## Installed 2026-07-31 — round 12 (lens: gates — the refusal that reads a field that does not exist)

### G17. `tools/gatecheck.mjs` — does blind.mjs's refusal gate check a field capture.mjs emits?
**Files:** `tools/gatecheck.mjs` (new), `tools/preflight.mjs` (one more advisory check, +14
lines, additive)

`tools/blind.mjs:143` (the acceptance gate's own refusal — "a blind test with a missing
subsystem is not a fair fight") reads `info.failedModules?.length` off the JSON.parse'd
`capture.mjs` stdout. Verified against a live capture during this round:
`capture.mjs`'s real stdout contract is `{ ok, via, files, stats, integrity, warnings,
criticalWarnings }`; `info.failedModules` is always `undefined`, so the branch has never
fired. The three real integrity channels — `missing` (§20: killed `ocean.js`/`rocks.js`),
`failedModules` (§11: `physics` dead in every capture), `missingPasses` (§19) — all live
under `info.integrity`, unread. Second, smaller hole in the same file: the `--score` tally
counts only the poses a judge typed (`n++` in the loop) and never compares `n` against
`Object.keys(key.pairs).length`, so a judge who submits 5 of 9 picks gets a clean `n:5` row
appended to `scores/blind.jsonl` with nothing marking it partial.

**Not fixed in `tools/blind.mjs` itself** — it is on this round's do-not-touch list, owned by
a concurrent wave. The two one-line fixes are: (1) refuse on
`[...(info.integrity?.missing||[]), ...(info.integrity?.failedModules||[]), ...(info.integrity?.missingPasses||[])].length`
instead of `info.failedModules?.length`; (2) after the tally loop, if
`n < Object.keys(key.pairs).length`, print `PARTIAL: n of N pairs judged` and record
`partial: true` in `logRow`. `tools/gatecheck.mjs` is the recommendation made checkable
instead of a paragraph: it reads `capture.mjs` and `blind.mjs` as text, checks every
`<parsedVar>.<field>` access in blind.mjs's refusal block against capture.mjs's real
top-level and `integrity`-nested keys, and flags a field that only exists nested (the exact
signature of this bug) or a missing partial-tally guard. Read-only, static, ~20 ms, no GPU,
no capture, no daemon.

**Proof it fires**, `node tools/gatecheck.mjs` against the real, unmodified tree:
```
gatecheck: 2 finding(s) in tools/blind.mjs:
  UNREACHABLE GATE: reads `info.failedModules` but capture.mjs only puts "failedModules"
  under `info.integrity.failedModules` — this condition can never be true.
  PARTIAL TALLY: the --score tally loop never compares its count `n` against
  `Object.keys(key.pairs).length` — a judge who submits fewer picks than pairs shown gets a
  clean row with nothing marking it partial.
```
exit 1. **Proof it stops firing once fixed** — `node tools/gatecheck.mjs --selftest` copies
the real `capture.mjs` and `blind.mjs` into a scratch dir under `/tmp` (read-only on the
repo), applies the exact two-part fix above to an in-memory copy, confirms the copy still
parses (`node --check`), and re-runs the same detector against it:
```
SELFTEST PASSED — detector correctly distinguishes broken from fixed
```
i.e. the unmodified copy trips both findings, the patched copy trips neither. `--selftest`
is left in the tool permanently so the next person to touch `blind.mjs`'s capture-stdout
handling can re-run this proof without hand-editing anything.

Wired into `preflight.mjs` as check 12 (`blind-gate`), advisory (`hard: false`, matching
`api-contract`/`scale`/`provenance`) — it never blocks a wave, and it will go green
automatically the moment `blind.mjs`'s owner applies the fix, no further action needed.

**A reviewer proposed treating this as belt-and-suspenders on `cap.status` plus a summed
integrity-length check, phrased like `capture.mjs`'s own `integrityGate`, rather than
re-deriving the bad-channel list inline** — evaluated and not adopted as a change to the
*recommended blind.mjs fix* (the reviewer agreed the two one-line changes are already
minimal and did not ask to block on it); it is exactly what `checkUnreachableGate`'s
`nestedUnder` reporting already surfaces, so no further tool change was needed either.

### Proof of no harm (round 12)
`node tools/parsecheck.mjs` → `ok — 42 files parse, no GLSL template hazards`, exit 0.
`node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8` → exit 0,
`"ok": true`, `"via": "daemon"`, all three integrity channels (`missing`, `failedModules`,
`missingPasses`) empty, no warnings — and this capture's own JSON is itself a live
confirmation of the finding: `failedModules` appears at `stats.failedModules` (`[]`) and
`integrity.failedModules` (`[]`), never at the top level.

### How to revert
`tools/gatecheck.mjs` is a new, standalone file — `rm tools/gatecheck.mjs` removes it and
the tool entirely. To stop it running inside `preflight`, delete the 14-line
`if (existsSync(join(ROOT, 'tools/gatecheck.mjs')))` block (check 12) from
`tools/preflight.mjs`; every other check is unaffected. Neither `tools/blind.mjs` nor
`tools/capture.mjs` was touched, so there is nothing to revert in either.

### Turn one thing off
The check is already advisory (`hard: false`) — it can never fail a build. If the printed
line becomes noise before `blind.mjs` is fixed, delete check 12 from `preflight.mjs` (above);
`node tools/gatecheck.mjs` still works standalone for anyone who wants to check by hand.

### Noticed, not done (round 12)
* **The actual `tools/blind.mjs` fix is not applied** — it is a two-line change and the file
  is owned by a concurrent wave this round. `tools/gatecheck.mjs` will report clean the
  moment it lands; no further ledger action will be needed.
* **`gatecheck.mjs` only checks `tools/blind.mjs` against `tools/capture.mjs` by default.**
  It accepts `--capture`/`--blind` path overrides, but nothing else in the project currently
  parses `capture.mjs`'s stdout the way `blind.mjs` does, so no second target was added. If
  a future consumer starts parsing capture's JSON, pointing `--blind` at it (name is a
  historical accident of what this was built for, not a hard requirement) reuses the same
  detector for free.

## Installed 2026-07-31 — round 12 (lens: gates — the fallback that never says why)

### G13. `tools/capture.mjs` — `viaDaemon()` states its reason instead of collapsing to `null`

**Files:** `tools/capture.mjs` only (`viaDaemon()`'s three non-success return sites, one
stderr line in `main()`, one field in the standalone JSON and in `writeProvenance()`). No
`src/` file touched, no measurement semantics changed, no new dependency, nothing added at
capture time beyond a string comparison and a `process.stderr.write`.

**What was wrong.** `viaDaemon()` flattened three distinct outcomes to the same `null`:
daemon not running (`daemonPort()` returned nothing), an HTTP/timeout error hitting a daemon
that does exist (`AbortSignal.timeout`, non-2xx status, network failure), and a daemon that
ran the request and answered `{ok:false, err, logs}`. `main()`'s `if (d) { … }` then silently
took the standalone path with nothing on stderr saying a fallback had happened, let alone why.
`tools/captured.mjs`'s own header states the design intent — "silently falls back to
standalone … so nothing breaks if it dies" — and, two lines later, what that costs at scale:
standalone is ~1 GB per agent and "exhausted system memory (measured 14 GB of 15 GB used, 0 GB
available, at 17 agents)", which is the entire reason the daemon exists. A fallback storm under
load therefore reproduces the exact failure the daemon was built to remove, invisibly. §19 is
the precedent for the diagnostic cost of a discarded reason: a pass that had stopped *loading*
was misdiagnosed as "a stale-code daemon bug" and shipped a workaround costing a vite + Chrome
per agent, precisely because the daemon's own diagnostics never reached the caller. G2's
provenance stamp already records *which* path a capture took (`via: daemon | standalone`); the
*reason* for a standalone run was still thrown away unread.

**What changed.** A reviewer's simplification was adopted over the original module-level-flag
sketch: `viaDaemon()` now returns `{ ok: false, reason }` on each of its three non-success
exits instead of `null`, and `main()` destructures `reason` straight off that return value —
no module-level mutable state for a future refactor to stomp on, consistent with how
`integrityReport()`/`integrityGate()` already pass data by return value in this same file.

* `viaDaemon()`: `if (!port) return { ok: false, reason: 'no daemon' };` /
  `if (!r.ok) return { ok: false, reason: \`daemon error: HTTP ${r.status}\` };` /
  `if (!out.ok) return { ok: false, reason: \`daemon returned ok:false: ${String(out.err ||
  '').slice(0, 300)}\` };` / `catch (e) { return { ok: false, reason: \`daemon error:
  ${e.message}\` }; }`. On success it still returns `out` unchanged (`d.ok === true`, no
  `reason` field), so the daemon-success branch in `main()` is untouched.
* `main()`: `if (d.ok) { … }` replaces the old truthiness check; on the non-success branch it
  writes one line to stderr — `[capture] DAEMON UNAVAILABLE (<reason>) — falling back to
  standalone; this spawns its own vite + Chrome (~1 GB). See tools/captured.mjs header.` — and
  carries `daemonFallback: reason` into the standalone run.
* The standalone path's printed JSON and `writeProvenance()` record both gained
  `daemonFallback` (`null` when the daemon path was skipped outright via `--port` or
  `HALO_NO_DAEMON`, since that is a deliberate standalone request, not a silent fallback).
  `scores/provenance.jsonl` is tracked, so this reaches a reviewer even though `shots/` does
  not — same join key G2 already established (outdir + timestamp).

Exit codes are unchanged everywhere. This is a stamp and a message, not a gate — a fallback
still succeeds if standalone capture succeeds, exactly as before.

**Proof it fires**, in two layers, both in a scratch copy under `/tmp` (never in the repo,
never touching the live shared daemon that a concurrent wave is using against this same tree):

1. **Extracted-logic unit test** (`unit_test_viaDaemon.mjs`, verbatim copy of the edited
   function body, driven against a local mock HTTP server so all five paths are exercised in
   under a second, no vite/Chrome/GPU needed):

   | case | mock response | result |
   |---|---|---|
   | no daemon reachable | `port = null` | `reason: 'no daemon'` |
   | daemon up, HTTP error | `/capture` → 503 | `reason: 'daemon error: HTTP 503'` |
   | daemon ran, `ok:false` | `{ok:false, err:'BOOT FAILED: ReferenceError: addStatic is not defined'}` | `reason: 'daemon returned ok:false: BOOT FAILED: …'` |
   | connection refused mid-request | server closed before the fetch | `reason` starts with `'daemon error:'` |
   | success passthrough | `{ok:true, shots:{…}}` | `d.ok === true`, `d.reason === undefined` |

   All five passed on first run.

2. **Full-pipeline integration test**, real `tools/capture.mjs` from a lean scratch copy
   (`rsync --exclude=ref --exclude=shots --exclude=reference.mp4 --exclude=.git
   --exclude=.venv --exclude=.gitnexus`, 96 MB — copying the whole 15 GB tree once filled the
   7.8 GB `/tmp` tmpfs and took down this session's own bash output with ENOSPC, a fresh
   instance of the exact hazard round 5's "Noticed, not done" already recorded; recovered by
   `rm -rf` and re-copying narrower), with `PORT_FILE` in that copy alone repointed at a
   scratch path so the test never talks to the real machine-wide daemon:
   * A fake daemon answering `/health` ok but `/capture` with `{ok:false, err:'BOOT FAILED:
     simulated daemon breakage for gate test'}` → `node tools/capture.mjs --pose ref_00000
     --out …` printed exactly one line on stderr: `[capture] DAEMON UNAVAILABLE (daemon
     returned ok:false: BOOT FAILED: simulated daemon breakage for gate test) — falling back
     to standalone; this spawns its own vite + Chrome (~1 GB). See tools/captured.mjs
     header.`, fell through to a real standalone capture, and **still produced a correct
     1920x1080 PNG** (exit 0) — proving the fallback message does not turn a recoverable
     failure into a hard one. Both the printed JSON and `scores/provenance.jsonl`'s appended
     record carried `daemonFallback: "daemon returned ok:false: BOOT FAILED: simulated daemon
     breakage for gate test"`.
   * **No false positive**, same scratch copy: a fake daemon that answers normally
     (`ok:true`, a 1x1 PNG) produced `via: "daemon"`, no `DAEMON UNAVAILABLE` line on stderr,
     and no `daemonFallback` field at all in the printed JSON — the message and the field
     appear only on an actual fallback.

**Proof of no harm** (real repo, unmodified — the live shared daemon was already up and
serving this exact tree, `root: /workspace/zer0/products/halo`, confirmed via `/health`
before running):

```
$ node tools/parsecheck.mjs
ok — 42 files parse, no GLSL template hazards

$ node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8
captured ref_00000 (daemon)
{ "ok": true, "via": "daemon", "files": ["/tmp/meta_smoke.png"], …
  "integrity": { "missing": [], "failedModules": [], "missingPasses": [] },
  "warnings": [], "criticalWarnings": [] }
```
Exit 0 both times, no `daemonFallback` field printed (correct — the daemon path succeeded),
`/tmp/meta_smoke.png` is a real 1920x1080 PNG (4.9 MB).

**How to run it:** nothing new to remember — it fires on every `node tools/capture.mjs`
invocation automatically, exactly where `via: daemon | standalone` already prints today.

**How to turn it off if it becomes a nuisance:**
1. It is a stderr line and two JSON/provenance fields, not a gate — it cannot fail a build or
   change an exit code, so there is nothing to bypass per-run.
2. If the line itself is unwanted noise (e.g. a machine that deliberately never runs the
   daemon), the underlying condition — `HALO_NO_DAEMON=1` or `--port <n>` — already skips the
   whole daemon-attempt block and `daemonFallback` stays `null`; that is the existing,
   unmodified escape hatch, not a new one.
3. To remove the feature entirely: `git checkout -- tools/capture.mjs`. Nothing else in the
   repo reads the `daemonFallback` field yet, so reverting breaks nothing downstream.

### Noticed, not done (round 12)
* **`scores/provenance.jsonl` now carries a `daemonFallback` field that nothing consumes.**
  `tools/provcheck.mjs` and `tools/postflight.mjs` were both named in this round's brief as the
  intended readers ("so `provcheck`/`postflight` can join it") but both are owned by a
  concurrent wave and out of this round's file allowlist. Wiring a "daemon fell back N times in
  the last M captures" rollup into either is the natural next step and is left for whoever owns
  them.
* **The `!r.ok` (HTTP status) branch is not one of the three outcomes named in the task brief**
  (`'no daemon'`, `daemon error: ${e.message}`, `daemon returned ok:false: …`) but is a real,
  distinct fourth path in the existing code (a daemon that answers with a non-2xx status
  without throwing) that was equally silent before this change. Given a `daemon error: HTTP
  ${r.status}` reason rather than folding it into the catch-block wording, since conflating an
  HTTP-error response with a network-level exception would have re-created exactly the kind of
  flattening this entry exists to undo. Flagged here rather than left unmentioned, since it
  widens the fix slightly past the letter of the three named cases while staying inside its
  spirit.
