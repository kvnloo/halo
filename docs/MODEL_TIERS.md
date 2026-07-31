# Which model does which job

Waves here run 15-20 agents and burn 2-4M tokens each. Most of that is justified. Some of it
is paying a diagnostician's rate to run `node tools/parsecheck.mjs` and report the output.

This file says which tier to put an agent on. It is evidence-based: the assignments come from
looking at where this project's real wins and real losses actually came from, not from a
general sense of task difficulty.

## The tiers

### `haiku` — mechanical. No judgement required.
The task is "run this, report what it says" or "collect these numbers into this shape". A
correct answer is checkable by anyone in one glance, and being wrong is immediately obvious.

- running gates and smoke checks, quoting output verbatim
- determinism checks (`cmp` two captures, report same/different)
- collecting frame ms, draw calls, triangle counts into a table
- file inventories, tallying which reports exist, which poses are covered
- reformatting a ledger, sorting entries, fixing a table's columns

Do NOT put anything on haiku that requires deciding whether a number is *right*. Reading a
value is mechanical; judging it is not.

### `sonnet` — well-specified work with a measurable check.
Someone else has already decided what "done" looks like and there is an instrument that says
whether you got there. The work is real but the search space is narrow.

- implementing a fix from a critic's explicit numbered problem list
- verifying a claim against the files it cites (open them, does it hold up?)
- research synthesis — web search, read sources, write the brief with citations
- integration reporting: run the suite, compare to last wave, write it up
- building a new tool to a clear spec
- single-file refines where the target metric and its target value are both given

### `opus` — diagnosis, and anything where being subtly wrong is expensive.
The failure mode is a confident, plausible, *wrong* answer that everyone then builds on. That
has happened repeatedly here and cost whole waves each time.

- **critics.** Every genuinely valuable finding in this project came from a critic:
  "the best-written subsystem in the repo and it renders exactly zero pixels."
- **diagnosis of any kind** — two candidate causes and an experiment needed to separate them
- **coupled multi-file changes** (motion vectors across `scene.js` + `taa.js`; the shared
  depth texture across `scene.js` + `RenderPipeline.js`). Single-file agents cannot even see
  these bugs.
- anything touching the measurement instruments, where a mistake silently corrupts every
  number downstream
- work where the brief itself might be wrong. Three agents last wave produced their best
  output by *disproving their instructions*; that is not a cheap behaviour.

## Why this split and not a cheaper one

The temptation is to move implementers down a tier, since "the critic already said what to
fix." Resist it for anything measurement-adjacent. The most expensive failures here were not
bad implementations — they were **confident wrong conclusions**:

- The scene-wide desaturation was attributed to material albedo by reasoning from correlation.
  Four agents spent a wave on it. The disproof took one step: force albedo to black, re-measure.
- `reports/fog.md` told every agent to measure with `HALO_NO_DAEMON=1` on a stale-cache theory.
  It was false, and it propagated into two waves before being tested.
- Five waves were steered by three scoring axes that were structurally pinned near zero.

None of those were typing problems. Every one was a *thinking* problem, and each cost far more
than the tokens saved by cheapening the agent that made it.

Conversely, "run the gate and quote the output" has never once needed to be smart.

## Rule of thumb

> Cheapen the agent when the task has a checkable right answer.
> Never cheapen the agent whose job is to decide what the right answer is.

## Applying it

```js
agent(prompt, { label: 'verify:x', model: 'sonnet', effort: 'medium' })
agent(prompt, { label: 'smoke',    model: 'haiku'  })
agent(prompt, { label: 'critic:x', effort: 'high' })   // omit model — inherits the session's
```

Omitting `model` inherits the session model, which is the right default for anything you have
not deliberately classified. Do not tier an agent you are unsure about — the saving is small
and the downside is a plausible wrong answer nobody catches.
