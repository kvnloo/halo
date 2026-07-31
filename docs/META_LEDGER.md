# Meta ledger — process gates already installed

Anything listed here is **done**. Do not re-propose it. Each entry names the past failure it
would have caught, so a future auditor can judge whether it is still earning its place.

Everything here is additive: no measurement changed semantics, no `src/` file was touched,
and every gate has a one-flag escape hatch.

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
