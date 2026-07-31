# Agent brief — the two commands, and what they refuse to let you do

One page. Everything here is mechanical; nothing here asks you to remember a rule.

> **THIS FILE IS THE BRIEF. Wave scripts must inject it, never re-type it.**
>
> ```js
> const BRIEF = readFileSync('docs/AGENT_BRIEF.md', 'utf8');
> const prompt = `${BRIEF}\n\n## YOUR SUBSYSTEM\n${taskSpecific}`;
> ```
>
> Until now the common brief was copy-pasted into each wave script. That is why it never
> got better: a lesson learned in Wave F was re-typed into Wave G by hand, unevenly, and
> the versions drifted apart. A fix to a copy-pasted brief does not propagate. A fix to
> this file does. Part 1 below is the mechanical tooling; **Part 2 is the instruction set
> agents are actually given**, and it is the part that has to compound.

## Before you measure anything

```bash
node tools/preflight.mjs
```

Exit 0 means this tree is safe to measure. It runs, in ~2.5 s and with no GPU:

| check | hard? | what it stops |
|---|---|---|
| `parsecheck` | **yes** | a `src/*.js` that does not parse. `src/modules.js` skips it *silently* and the subsystem vanishes from every frame (KNOWN_ISSUES §20 — `ocean.js` and `rocks.js` were dead through Waves F **and** G) |
| `posecheck` | **yes** | a camera pose that has sunk under a re-profiled terrain (§17.1) |
| `references` | advisory | a `ref_` pose with no `ref/keyframes/kf_*.png`. `score.mjs` skips it and still writes the row, with a smaller `n` |
| `src-quiescent` | advisory | measuring while a concurrent wave is mid-write (§16: six files rewritten *during* captures produced findings "that look real and are not") |
| `daemon` | advisory | a wedged capture daemon, which looks identical to a busy one (§27 — one cost 15 minutes) |

`npm run capture` and `npm run score` run it for you (`precapture` / `prescore`) — **and
that is the only way it has ever run.** Counted across `reports/` and `docs/`: 31 sites
invoke `node tools/capture.mjs` / `node tools/score.mjs` directly against 3 that mention the
npm form, including `docs/LOOP.md` §4 ("what to do every wave", which runs
`node tools/score.mjs --tag waveX`) and every proof-of-no-harm in `docs/META_LEDGER.md`. So
the table above has been gating almost nothing. `preflight` now leaves
`.preflight-stamp.json` behind it, and `tools/capture.mjs` prints a one-line NOTE when that
receipt is missing or older than the last `src/` write. The note is advisory and costs
nothing (a `stat` loop, no subprocess); it goes away the moment you run preflight.
`HALO_NO_PREFLIGHT_NOTE=1` silences it.

## The capture itself now refuses to hand you a broken scene

`tools/capture.mjs` exits **3** and prints a loud block if any of the three integrity
channels is non-empty:

* `__HALO_MISSING__` — module failed to import or `create()`
* `stats.failedModules` — module imported, then `init()` threw
* `__HALO_MISSING_PASSES__` — a post pass failed to load

All three existed. None was ever checked. `physics` threw in `init()` and was **dead in
every capture and every score on record** (§11) because nobody read `failedModules`; a Wave E
critic wrote a full 12/100 review of an ocean that was not in the build (§20).

`score.mjs` already aborts on a non-zero capture, so **scoring a broken tree is now
impossible by default**. Deliberately partial build? `--allow-missing`, or
`HALO_ALLOW_MISSING=1`.

## Every capture stamps its own provenance

Each run writes `<outdir>/_capture.json` and appends one line to `scores/provenance.jsonl`
(tracked; `shots/` is not) recording: git SHA and branch, how many `src/` files were dirty
and which were written in the last 10 minutes, the sha256 of `src/world/poses.js`, the
sha256 of `capture.mjs` / `score.mjs` / `metrics.py`, `settle` / `time` / `seed` / `w` / `h`
/ `only` / `skip` / `config`, and **`via: daemon | standalone`**.

Join key is the outdir: `score.mjs` captures into `shots/<tag>/`, so `<tag>` links a
provenance line to `scores/<tag>.json` and to its row in `scores/history.jsonl`.

This exists because no recorded score has ever carried any of it. Poses are refittable and
"applying a fit invalidates every previously recorded score" (§3) — with nothing on a score
saying which pose table made it. `waveG` and `waveG-settle96` are the *same code* and differ
by 0.52 points on `--settle` alone (§26) — and `--settle` appears nowhere in the history row.

## Committing

`.githooks/pre-commit` refuses a commit whose **staged** `src/*.js` blobs do not parse, or
that contains a backtick inside a `/* glsl */` template. It checks the staged blob, not the
working tree, because the working tree here is never quiescent.

It then runs `tools/stagedcheck.mjs`, which applies the same rule to the instruments and the
record: staged `tools/*.mjs` (`node --check`), `tools/*.py` (`py_compile`), and every staged
`*.json` / `*.jsonl` (parsed per line, plus a trailing-newline check so the next append does
not land on the last row). `scores/history.jsonl` is hand-edited and 17 files read it.

Doing a salvage commit of deliberately half-finished work (as in `2651d8c`)?
`git commit --no-verify`.

Install (once per clone; `npm install` does it via `prepare`):

```bash
git config core.hooksPath .githooks
```

## Before you finish

```bash
node tools/postflight.mjs            # auto-detects your report; advisory, never fails a build
node tools/postflight.mjs --provenance   # prints the R7 block, already filled in
```

The mirror of `preflight`. It checks the *written record* the way preflight checks the tree,
and it exists for the same reason: five of these checks already existed as five separate
commands and the measured adherence to all of them was zero.

| check | what it stops |
|---|---|
| R7 provenance block | 28 of 28 reports carried numbers with no header saying which tree produced them (`tools/reportlint.mjs`). It now writes the block for you from your own `_capture.json` |
| R9b MEASURED/INFERRED | a reader cannot tell your digits from your reasoning, so the next agent re-derives or, worse, believes |
| R8 whole frame | `blind.md` T10 — a whole building missing from `ref_02220`, invisible to 26 reports each measuring its own ROI |
| blind gate | `tools/tells.mjs` — the tell that decides *your* subsystem, uncited |
| contract siblings | `tools/contracts.mjs` — the sibling files a fix left untouched, see R2c |
| R9 `NEEDS:` routing | 26 cross-file handoffs written in prose, 0 machine-routable (`tools/needscheck.mjs`) |
| shader errors | GLSL link failures sitting unread in your capture's `warnings[]` — see R3 |
| citecheck / claimcheck / refstamp | dead citations, refuted claims, moved ground truth |

## Reading the history

```bash
node tools/historycheck.mjs
```

Flags an axis that has not moved in the last 5 runs. `grade` scored **0.00 in every run ever
recorded**, including runs where it genuinely improved, for nine runs, and was caught by a
human reading the column (§15). It also flags rows scored over different pose counts and
duplicate run tags.

---

# Part 2 — the instruction set

Everything above is a machine refusing to let you do something wrong. Everything below is
what the orchestrator needs from *you*. Each rule carries the specific failure that
produced it, and an honest note on whether agents actually follow it — so you can tell the
load-bearing rules from the ceremony.

## R1. Write `reports/<yourkey>.md` FIRST, then keep updating it

The report is a **deliverable, not a return value**. Write it the moment you have a number
worth keeping. If you are killed, that file is the only thing that survives; your final
message is not.

> *Why:* this project was killed twice by usage limits mid-flight, losing 19 of 21 agents'
> final messages. Every file edit survived; every measured number and "attack this next"
> note evaporated. Full rationale in `tools/checkpoint.md`.
> *Adherence: good — 26 reports on disk. This rule works, and it is why the project
> survived two deaths.*

## R2. Read `docs/KNOWN_ISSUES.md` for your file before you touch it

Grep it for your owned filename. Then read §16 (concurrency), §20 (silent module death)
and §26 (settle is not a safety margin) whoever you are.

## R2c. Closing a defect that names a contract? Check the siblings first

```bash
node tools/contracts.mjs <contract-id>      # e.g. velocity-producer, collider-producer, depth-consumer
```

Every contract in this codebase (a value convention shared by several files, e.g. "what a
collider producer must emit for `physics.js` to accept it") has had 3-5 implementers and a
fix that landed in one of them, with the rest rediscovered a wave later — `vegetation.js`
stayed on a stale velocity pairing for two waves after `scene.js`+`taa.js` were fixed;
`structures.js`'s colliders are still open a wave after `rocks.js`'s were fixed; the shared
depth texture had six consumers found one at a time. `tools/contracts.mjs` prints, for a
named contract, every file that currently implements it, with line numbers, from
`tools/contracts.json`. State in your report what you found in each sibling file.

## R2b. Read the tell that decides your subsystem — it is the acceptance criterion

```bash
node tools/tells.mjs rocks          # your subsystem key, or bare for all eleven
```

`reports/blind.md` is the stated final gate: nine frames judged blind against the real
game, lost **9-0**, with eleven tells ranked by how many frames each one decided. It is the
only ranked statement in this repo of what actually loses the comparison, and it names files:
T1 rocks (7/9), T3 contact shadows (6/9), T2 the beach (5/9), T6 vegetation, T7 clouds,
T10 `structures.js` — including *"at `ref_02220` the bridge is absent from our render
entirely … it should be triaged first because it is the only finding here that is outright
wrong rather than not good enough."*

> *Adherence: zero, and it is the brief's fault, not the agents'. Four of thirty reports
> mention the blind test and three of those four are the tooling agents who built it. No
> subsystem report cites the tell that decides its own subsystem. `reports/tonemap.md`
> (02:15) and `reports/terrain.md` (02:14) were both written after `blind.md` landed at
> 23:56 and contain neither the string "blind" nor any `T<n>` — T11 is about the tonemap and
> T2 is about the beach. Until this rule existed, nothing in R1–R10 named `reports/blind.md`
> at all, so agents optimised six scored axes while the ranked list of what gives the frame
> away went unread. A movement in an axis that does not move a tell does not move the gate.*

### R2b-2. The other instruction set: `docs/LOOP.md` §5

This brief is not the only standing-rules document, and until now it never said so. Nothing
in R1–R10 referenced `docs/LOOP.md`, whose §5 carries seven rules that are the orchestrator's
own statement of what these numbers are worth. Read them; the two that decide how your
report is used are:

* **§5.2 — never report a composite without its worst axis.** "It has spent five waves
  averaging a dead 0 against a live 94. Quote `axes.structure` and `raw.ms_ssim` alongside
  any score, or quote nothing."
* **§5.7 — the blind test *is* the score.** "Everything in `scores/history.jsonl` is a proxy
  that was picked for being cheap. When a proxy and the blind test disagree, the proxy is
  wrong. It has disagreed once, by 9 pairs to nil."

```bash
node tools/blindcheck.mjs        # how many scored runs since the gate was last judged
```

> *Adherence: §5.6 says "run the blind test every wave, not at the end … five waves were
> spent optimising proxies that a single 30-minute blind test would have invalidated on day
> one." `scores/blind.jsonl` holds **one** human judgement — `waveH`, and its own note says
> "backfilled" — against **14** scored runs in `scores/history.jsonl`. Four runs have landed
> since, including the 29.44 → 16.85 collapse across the Wave I pose refit, and none was
> judged. Same shape as every other rule here: it was a paragraph in a document agents were
> never pointed at, and no tool compared the two ledgers. `blindcheck` is that command, and
> `postflight` runs it for you.*

## R3. Gate every measurement, and say so in the report

`node tools/preflight.mjs` green **before** the capture. `node tools/shadercheck.mjs`
before any number you intend to publish — it boots the scene on the GPU and fails if a
material did not link.

> *Why shadercheck is separate:* `preflight` is CPU-only, so it cannot see the fourth
> integrity channel. A module can import fine, `init()` fine, load every pass — and have
> its shaders fail to compile. `reports/terrain.md` §1: `patch` is a reserved word in
> ESSL 3.00, so **all three** terrain materials failed to link, and the "sand" in the
> showcase contact sheet was **the clear colour**. That frame was captured, scored,
> committed (`65da9df`) and reviewed before anyone read the browser console. One rename
> moved whole-frame `lum_mean` 98.87 → 110.48. The console text was in `warnings[]` in
> `capture.mjs`'s stdout the entire time, and no caller printed it (KNOWN_ISSUES §19:
> "capture warnings do get swallowed into `warnings[]`").
> *Adherence: poor, and instructively so. §20 says "run `parsecheck` before any measurement
> you intend to believe" — it is named in 9 of 26 reports. Not carelessness: it was one more
> line of prose in a long brief with nothing enforcing it. It is a gate now.*

## R4. Prove the thing you are tuning is alive, before you tune it

```bash
node tools/nulltest.mjs --module ssao                     # does this pass change any pixel?
node tools/nulltest.mjs --knob aoStrength --off 0 --on 2  # does this knob change any pixel?
```

Byte-identical frames mean the thing is dead and every constant you fit to it is fiction.

> *Why:* §28 — `ssao` and `ssr` both early-out on `d >= 1.0` ("sky, nothing to do"), and
> under §18 every world pixel read as sky, so **both passes rendered zero pixels for the
> entire project** while `aoStrength`, `aoRadius`, `aoPower` and `ssrStrength` were tuned
> against them for three waves. §9 — `ctx.config.exposure` pinned across a **13× range**
> produced byte-identical frames, `lum_mean` 110.51883342978395 for every value. §21 —
> depth of field was a shipped no-op. `reports/tonemap.md` measured `volumetricFog` as "a
> byte-level no-op". Every one of those is a two-capture, sixty-second check that nobody
> was ever asked to run.

## R5. Isolate and measure. Never conclude from correlation

Null the term out, re-capture, re-measure, conclude. The difference between the two
captures *is* an exact semantic mask of what that term does — **but only if the arm you
think you turned off was actually turned off.** Pick the instrument by what the thing is:

| the thing | how to null it | what NOT to use |
|---|---|---|
| a **module** (`ocean`, `rocks`, `vegetation`, …) | `--skip <module>` / `--only <module>,pipeline` — read by `src/modules.js`, and `capture.mjs` is now **fatal** on a name that is not in the manifest | — |
| a **pass** (`ssao`, `ssr`, `dof`, `taa`, `volumetricFog`, `bloom`, …) | `node tools/ablate.mjs --targets <pass>`, or `__HALO__.togglePass()` | **`--skip <pass>` reaches no pass.** `src/render/pipeline.js`'s `PASS_MANIFEST` is a fixed list loaded unconditionally and never reads `skip`/`only` (`skip-flag-can-disable-a-pass` in `tools/refuted.json`) |
| a **knob** (`aoStrength`, `exposure`, …) | `node tools/knobcheck.mjs --config k=v` to validate the key **before** spending a capture, then `--config <term>=0` | a `*Enabled` gate written `(c.k ?? cfg.k) !== false`: `--config` can only send `0` or `'false'`, never boolean `false`, so **3 of 7 pass switches cannot be turned off this way** (`knobcheck --gates`) |

Do not write "X causes Y" unless you have a capture with X removed. Write "X correlates
with Y; not isolated" — that sentence is allowed, and it is useful.

**A byte-identical arm is not a result.** It is equally the signature of an inert
subsystem *and* of a flag that did nothing, and this project has confused the two at least
four times (`reports/vegetation.md:49`, `reports/tonemap.md:70`, `reports/taa.md:164`,
`tools/_convprobe.mjs:16`) — including in the measurement registered as the disproof of
KNOWN_ISSUES §8. Run a control arm you *know* differs before you believe a null.

> *Why:* §8 is the orchestrator's own mistake, recorded verbatim: "I reasoned from a
> correlation ('everything looks white, so the albedos must be white') instead of running
> the controlled experiment. The agent that zeroed the albedo and re-measured got the
> answer in one step." The wrong diagnosis propagated for two waves. §19 is the same shape
> from an agent: `reports/fog.md` opened by telling everyone to measure with
> `HALO_NO_DAEMON=1` on a stale-module-cache theory that was **tested and false** — and the
> workaround it recommended is the exact configuration that exhausted system memory at 17
> agents. It had already spread into `reports/tonemap.md` before anyone tested it.
> *Adherence: the highest-variance rule in the brief. The terrain agent forced its own
> albedo to black and disproved the orchestrator in one step. Others reasoned from a single
> capture and were wrong for two waves.*

## R6. Report structure, not means

`lum_mean` matching tells you the exposure is in the right place and nothing else. Quote
`lap_var`, `edge_density`, `local_contrast`, `lum_std`, the min/max tails, `spectral_slope`.
If you quote a mean, quote its std and tails beside it. See `docs/TARGETS.md`,
"Means are not an image". A score movement under **±0.5 points is noise** (§26) — do not
claim it.

> *Adherence: good. Most reports now lead with `lap_var` and `spectral_slope`. This one
> landed, because `docs/TARGETS.md` made the failure concrete instead of abstract.*

## R7. Open your report with the provenance block

```
<!-- provenance
owner:         src/world/rocks.js
pose(s):       ref_01500, ref_00000
settle:        48
preflight:     pass
shadercheck:   pass
src-quiescent: no — clouds.js and terrain.js were written during §3, so §3 is same-window A/B only
capture:       shots/rocks-waveH/_capture.json
-->
```

`node tools/reportlint.mjs` lists reports missing it. **Do not type it by hand** —
`node tools/postflight.mjs --provenance` fills every field from the `_capture.json` your
capture already wrote (G2) and prints the block ready to paste. That is the whole of the
work this rule asks of you.

> *Why:* §16 — six `src/` files were rewritten *while* captures ran, producing findings
> "that look real and are not": three phantom parse errors and two false `BROKEN`
> determinism results, all recorded as real. §25 — "the `--skip rocks` / `--skip props`
> A/B still has not been run, for the third wave running, because `src/` has never been
> quiescent."
> *Adherence: 4 of 26 reports mention quiescence at all. `reports/structures.md` and
> `reports/ocean_waveH.md` open by declaring that the scene moved under them and restricting
> themselves to same-window A/Bs. Those two reports are trustworthy in a way the other
> twenty-four cannot be shown to be, and the entire difference is six lines of header.*

## R8. Look at one whole frame, at full size, before you finish

Not your ROI. Not your difference mask. One entire frame, opened with the Read tool. Say
in your report that you did it and what you saw that your metrics did not.

> *Why:* `reports/blind.md` T10 — at pose `ref_02220` **the bridge is absent from our
> render entirely**. The pose is documented as "bridge silhouette against bright sky"; our
> frame is an empty beach. Twenty-six subsystem reports, every one measuring its own ROI or
> its own mask, and a missing building was found only by the final blind test. §17.3 —
> character models still stand in three showcase cells and read as placeholder junk. Nobody
> owned "the frame", so nobody reported it.

## R9b. Mark every load-bearing sentence MEASURED or INFERRED, and register what you disprove

    MEASURED  sat_mean 55.66 -> 61.66 at ref_00000 --settle 48 (tools/metrics.py --stats)
    INFERRED  the remaining 22% is probably the same haze term — not isolated

`MEASURED` means a command in this repo produced those digits and the command is in the
report. Everything else is `INFERRED`, however good the reasoning. The next agent may build
on MEASURED without re-deriving it; INFERRED must be tested before anyone spends a wave on it.

When you disprove another report, do three things **in the same commit**:

1. Say so loudly, with the controlled experiment that separates the candidates.
2. Add the dead claim to **`tools/refuted.json`** — the wording regex (`near`/`alsoNear`)
   and a `cleared` regex for what counts as a retraction beside it.
3. Run `node tools/claimcheck.mjs`, which then lists every *other* place the claim is
   still standing, and annotate those too. A one-line retraction beside each is enough;
   you are not rewriting someone else's analysis, you are stopping it steering the next
   wave. If a site is in a file a concurrent wave owns, put the exact replacement text in
   your report under a `NEEDS: <path>` heading (R9) and leave the site flagged.

Step 3 is the one that matters. Steps 1 and 2 were already being done — `reports/fog.md`
retracted its own `HALO_NO_DAEMON=1` claim — and the claim still cost the project two more
waves, because the copy in `reports/tonemap.md` was never touched.

### A verification command must be able to fail — and in zsh, must be braced

A negative result is only evidence if the command could have produced a positive one. The
canonical failure here is KNOWN_ISSUES §28 / `reports/integrationH.md` §7, which "checked
against git rather than taking it on faith":

```bash
for c in 865e972 76237b2 8ed94d7; do          # DO NOT COPY — all three are dangling
  git show $c:src/render/passes/ssao.js | grep -c "export function ensureOpaqueDepth"
done                                          # -> 0  0  0
```

It printed `0 0 0` and it could not have printed anything else, for **two** independent
reasons:

1. **The SHAs do not exist** (history was rewritten at `a9c1e8a`/`b92decf`). `git show`
   writes `fatal:` to *stderr*, `grep -c` reads the empty stream and prints `0` — byte-for-byte
   what a true negative prints. `set -o pipefail` does **not** rescue this: on a dead object
   `grep` exits 1 as well, so the pipeline status is identical either way.
2. **`$c:path` is not what you think in zsh**, which is this repo's shell. It is a parameter
   expansion followed by the `:s` substitution modifier, **and double quotes do not disable
   it**. Measured, no rc file, with a SHA that *does* resolve:

   ```
   $ zsh -f -c 'c=f25d7b9; echo "$c:src/render/passes/ssao.js"'
   f25d7b9/passes/ssao.js
   ```

   So `git show` was handed `<sha>/passes/ssao.js` — neither a rev nor a path — and would
   have failed on a *valid* SHA too.

Write it so a dead object stops the run, and brace the expansion:

```bash
for c in 6a19370 f25d7b9 8bceeb5 f96fae6; do
  git rev-parse --verify "${c}^{commit}" >/dev/null || exit 1   # fails loudly, first
  git show "${c}:src/render/passes/ssao.js" | grep -c "export function ensureOpaqueDepth"
done                                          # -> 0  1  1  0
```

Those are the real numbers: the pass §28 called absent was **live in Waves F and G**. Before
you publish a null result, run the same command against a case you *know* is positive. If it
also comes back null, you have measured your shell, not the repository.

Two more mechanical checks on the written record, both read-only and instant:

```bash
node tools/citecheck.mjs         # do the commits and paths you cite actually resolve?
node tools/claimcheck.mjs        # are you repeating something already disproved?
node tools/refstamp.mjs --verify # is ref/ still the ground truth your numbers assume?
```

> *Why:* `reports/fog.md`'s `HALO_NO_DAEMON=1` claim was believed for two waves and had
> already spread into `reports/tonemap.md` before anyone tested it — and only fog.md carries
> the retraction. §8 named the wrong file twice (albedo, then `volumetricFog.js`) while
> `reports/vegetation.md` had already measured `--skip volumetricFog` as **byte-identical**
> — a measurement now itself refuted (`skip-flag-can-disable-a-pass` in `tools/refuted.json`):
> `src/render/pipeline.js`'s `PASS_MANIFEST` never reads `skip`, so that arm **skipped
> nothing** and byte-identical was guaranteed. §8 is still not `volumetricFog`, but nothing
> here has measured that. `docs/RESEARCH.md` still teaches the refuted version as its
> motivating example.
> *Why citecheck:* git history here was rewritten, so every SHA quoted before that is
> dangling — including the KNOWN_ISSUES §28 evidence
> `git show 865e972:.../ssao.js | grep -c ...` → `0`, which is what a **missing object**
> prints too. A verification command that cannot fail has verified nothing (see R4).
> *Why refstamp:* `ref/` is gitignored, was extracted by hand, and "no script survives" for
> rebuilding it (README). Nothing recorded which bytes every score in `history.jsonl` was
> measured against until `tools/ref_manifest.json`.

## R9. Do not edit a file you do not own

One agent, one file. If your fix needs another file, write the exact change into your
report under a `NEEDS: <path>` heading and stop. The orchestrator routes it. The tree and
the GPU are shared; your save is visible in everyone else's capture the moment you make it.

The heading is literally this, on its own line, at the point of the handoff:

```
NEEDS: src/render/passes/scene.js
<the exact change, as you would have made it>
```

`node tools/needscheck.mjs` enumerates them, and flags a handoff written in prose instead.

> *Adherence: the first half is followed and the second half is not, which is the worst of
> both. `NEEDS:` headings across 28 subsystem reports: **0**. Cross-file fixes handed off in
> prose: **26**, in 18 reports — `reports/depth.md:372` ("~6-line fix in a file I do not
> own, with the patch written out above. Highest priority."), `reports/clouds.md:379`,
> `reports/integration.md:632`, `reports/structures.md:324`, `reports/props.md:437`,
> `reports/vegetation.md:57`, `reports/sky.md:197`, `reports/taa.md:378`. Agents really do
> stop at the file boundary; the fix then sits in the middle of a 20–50 KB report and the
> orchestrator has no way to enumerate it. This is the same shape as the disproof that
> never reached the copies (R9b step 3), one level up.*

## R10. Research narrows the search; it never closes it

`docs/RESEARCH.md` has the protocol. Cite what you used as `research/<topic>.md` so the
next agent inherits the reading instead of repeating it, then measure anyway.

> *Adherence: good. All nine `research/*.md` briefs are cited by the report or the source
> file of the subsystem they were written for.*

---

## What this brief still does not say, and should

Kept honest so the next revision has somewhere to start:

- **How to decide a subsystem is done.** There is no exit criterion, so agents optimise
  until the session ends. `ref/baseline.json` records what the reference scores against
  *itself* — `detail` 79.0, `geometry` 88.5, `spectrum` 97.8 — which is the honest ceiling,
  and nothing in the brief points an agent at it.
- ~~**What to do when your measurement contradicts an existing report.**~~ Answered by R9b:
  say it loudly with the controlled experiment, cite the line, update
  `docs/KNOWN_ISSUES.md`, and add the dead claim to `tools/refuted.json` so
  `tools/claimcheck.mjs` can find the copies you did not know about.
- **That `--settle` is a world-clock knob, not a safety margin** (§26). Two captures at
  different settle counts are different moments in the animation, not the same frame
  converged further. Never compare across settle values.
- ~~**Which of these rules an agent is actually graded on.**~~ Answered mechanically:
  `postflight` is the list. Note what it cost to learn this — R3, R4, R7 and R9b were
  written into this brief *after* every report on disk was finished, so their measured
  adherence is 0 of 28 by construction and not by neglect. When you add a rule here, say
  which command enforces it, or expect the same number.
- **Whether the wave script that spawned you injected this file or a re-typed copy of it.**
  Nothing checks. The extraction (top of this file) fixed drift going forward; it cannot
  prove the prompt you were given came from here. If your prompt disagrees with this file,
  this file wins — say so in your report.
