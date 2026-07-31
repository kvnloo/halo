export const meta = {
  name: 'metaloop',
  description: 'Meta-awareness loop: inspect how this project fails, verify each finding adversarially, apply only obvious low-risk guardrails. Never touches src/.',
  whenToUse: 'Run between waves, or any time the process feels leaky. Safe to run repeatedly — it converges via a ledger and stops when it finds nothing new.',
  phases: [{ title: 'Inspect' }, { title: 'Verify' }, { title: 'Apply' }, { title: 'Report' }],
};

/* ===========================================================================
   THE POINT OF THIS WORKFLOW

   Every other wave fixes the GAME. This one fixes the PROCESS that builds the
   game. It exists because the same classes of failure kept recurring:

     - A backtick in a GLSL comment silently deleted a subsystem. Three times.
       A critic scored the ocean 12/100 before noticing there was no ocean.
     - A wrong claim in one agent's report ("the daemon serves stale code")
       propagated into two whole waves before anyone tested it. It was false.
     - Five waves were steered by a scoreboard whose three comparative axes were
       structurally pinned near zero, and nobody checked the axes themselves.
     - The one instrument that ever told the truth (blind A/B) was run once, at
       the very end, as a ceremony.

   Each of those was cheap to catch and expensive to miss. That asymmetry is the
   whole justification for this loop.
   =========================================================================== */

const SAFETY = `
# HARD SAFETY RULES — violating any of these is a failed task, not a judgement call

**You may NOT edit anything under \`src/\`.** Ever. Not one line, not a comment. Rendering
agents own those files and several are being edited RIGHT NOW by a concurrent wave. If your
finding requires an \`src/\` change, that is a legitimate finding — WRITE IT DOWN as a
recommendation for a future wave and move on. Do not implement it.

**You may NOT touch these files** — a concurrent wave owns them:
  tools/metrics.py  tools/score.mjs  tools/blind.mjs  docs/LOOP.md  docs/KNOWN_ISSUES.md

**You may NOT:**
- rewrite git history, force-push, or touch \`.git/\` internals
- delete or move existing tools, tests, reports, research or scores
- change any measurement's SEMANTICS — re-banding an axis or altering a metric changes what
  every historical number means. Out of scope here by construction.
- add npm dependencies, network calls, or anything that runs at capture time and could slow
  or destabilise a capture
- "improve" working code you were not asked about. Refactors are not guardrails.

**You MAY create and edit:**
  tools/preflight.mjs and other NEW tool files    .githooks/*    .github/workflows/*
  package.json (scripts only)                     docs/META_LEDGER.md
  docs/AGENT_BRIEF.md                             .gitignore
  tools/parsecheck.mjs  tools/capture.mjs  tools/captured.mjs  tools/previewsheet.mjs

**Every change must be strictly additive and reversible.** A guardrail that breaks the build
is worse than the bug it catches, because it blocks every agent at once.

**Prove you did no harm.** Before you finish, run and report:
    node tools/parsecheck.mjs
    node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8
If either regresses, revert your change and report that instead. Do not leave the tree worse.
`;

const CONTEXT = `
# Project: a Three.js FPS matching Halo: Campaign Evolved, built by fan-out agent waves

Working dir: /workspace/zer0/products/halo (ALWAYS absolute paths)

## How the work actually happens
Waves of parallel agents each own one file. They capture deterministic frames, score them on
six axes against reference frames, and a harsh critic reviews each subsystem. Reports land in
\`reports/\`, research in \`research/\`, defects in \`docs/KNOWN_ISSUES.md\`.

## The evidence base for THIS task — read what is relevant, do not skim it all
- docs/KNOWN_ISSUES.md   — 20+ numbered defects, several of which are process failures wearing
                           a bug costume. Sections 8, 15, 18, 19, 20 are the richest.
- reports/blind.md       — the blind A/B: we lose 9-0. The ranked tells are ground truth.
- reports/*.md           — every agent's checkpoint. Compare CLAIMS against what other agents
                           later measured. At least one confident report was flat wrong and
                           propagated for two waves.
- research/*.md          — technique briefs. Are they cited? Were they actually used?
- scores/history.jsonl   — 10 runs. Look for axes that never move.
- docs/RESEARCH.md, docs/TARGETS.md, tools/checkpoint.md — the process docs that exist already.
- git log                — 30+ commits. What kept coming back?
- tools/                 — the instruments. What do they NOT check?
`;

const FINDING_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'evidence', 'fix', 'files', 'risk', 'value'],
        properties: {
          id: { type: 'string', description: 'short kebab-case slug, stable across rounds' },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'the SPECIFIC past failure this would have caught, with file/report/commit references' },
          fix: { type: 'string', description: 'the concrete surgical change' },
          files: { type: 'string', description: 'exact files it would create or edit' },
          risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
          value: { type: 'string', enum: ['high', 'medium', 'low'] },
          srcOnly: { type: 'boolean', description: 'true if it CANNOT be done without editing src/ — recommendation only' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['real', 'safe', 'reasoning'],
  properties: {
    real: { type: 'boolean', description: 'is this a genuine gap, not already covered elsewhere' },
    safe: { type: 'boolean', description: 'is the proposed fix genuinely low-risk and additive' },
    reasoning: { type: 'string' },
    betterFix: { type: 'string' },
  },
};

const LENSES = [
  {
    key: 'recurrence',
    q: `**Find the failures that happened MORE THAN ONCE.** A bug that recurs is a process gap
wearing a bug costume, and it is the highest-value thing you can find.

Read \`git log\`, \`docs/KNOWN_ISSUES.md\` and every \`reports/*.md\`. Build the actual list of
repeated failures. One is already known and gated (backticks in GLSL templates, three
occurrences, now caught by tools/parsecheck.mjs) — use it as the template for what a good
finding looks like, and then find the OTHERS.

Look especially for: things fixed in one file that were never checked in sibling files;
defects rediscovered by a later agent because the first fix was never recorded; and anything
where a report says "I found X again".`,
  },
  {
    key: 'silence',
    q: `**Find the failures that produce NO ERROR.** Silent failure is what has hurt this
project most, because agents then measure the broken thing and report confident numbers.

Documented cases to learn the shape from, then go find more:
- A file that fails to parse is skipped silently; its subsystem vanishes from the frame with
  no error in the image (KNOWN_ISSUES 20).
- \`ssao.js\` and \`ssr.js\` rendered ZERO pixels for four waves. Both compiled fine.
- The capture daemon swallows shader-source errors into a \`warnings[]\` array that most
  callers never print, and emits "passes not loaded" lines nobody greps for.
- \`ctx.config.exposure\` was byte-identically dead across a 13x range.

Where else can a subsystem silently contribute nothing while everything reports success?
What would make each of those LOUD? Prefer failing fast and visibly over documenting.`,
  },
  {
    key: 'trust',
    q: `**Audit the trust chain: which claims does this project act on without verifying?**

At least one confident, well-argued agent report was flat WRONG and propagated into two waves:
\`reports/fog.md\` told everyone to measure with \`HALO_NO_DAEMON=1\` on a stale-cache theory.
It was tested later and is false (KNOWN_ISSUES 19); adopting it costs one Chrome per agent and
previously OOMed the machine at 17 agents.

So: reports are treated as ground truth by later agents and by the orchestrator. Research
briefs are treated as authoritative — are their citations real and checkable? \`docs/\` is read
by every agent — is any of it now stale or contradicted by later measurement?

Cross-check specific load-bearing claims against what was later measured. Propose a mechanism
that makes claims checkable or clearly marked as unverified — for example a convention that
separates MEASURED from INFERRED in reports, applied where it matters most.

Name any claim currently in the docs that you believe is wrong, with your evidence.`,
  },
  {
    key: 'gates',
    q: `**Find the missing gate: what SHOULD be impossible but currently is not?**

Concrete things that have actually happened and were caught late or by luck:
- Measuring against a tree where a subsystem failed to parse (caught only after a critic wrote
  a full review of a subsystem that was not in the build).
- Recording scores against camera poses that were later refitted, with no provenance stamp on
  the score record to say which pose set produced it.
- Committing a half-written file while a dozen agents edit one tree.
- Reading a capture that silently fell back to a different code path.

\`tools/parsecheck.mjs\` exists but nothing ENFORCES it — no hook, no npm script, no CI.
Consider: a single \`tools/preflight.mjs\` that every agent and workflow runs first and that
fails loudly; a git pre-commit hook; a GitHub Actions workflow (the repo is now public at
github.com/kvnloo/halo); provenance stamping so a score record carries the fingerprint of the
poses, the git SHA and the tool versions that produced it.

Prefer ONE well-placed gate over five checks nobody runs. Say which single gate would have
caught the most past failures.`,
  },
  {
    key: 'adherence',
    q: `**Audit workflow adherence: what do the agent briefs ask for that agents do not do?**

Every wave ships a long COMMON brief — checkpoint to reports/, run the parse gate, read
KNOWN_ISSUES first, isolate-and-measure rather than reason from correlation. Compare what the
briefs demand against what \`reports/*.md\` shows actually happened.

Which instructions are reliably followed? Which are ignored, and WHY — too long, buried, no
enforcement, or genuinely impractical? An instruction nobody follows is worse than none: it
creates false confidence in the orchestrator.

The brief is currently COPY-PASTED into each wave script, so a fix to it does not propagate
and the versions have drifted. Consider extracting the canonical brief to
\`docs/AGENT_BRIEF.md\` that wave scripts reference, so improvements compound instead of being
re-typed.

Also: what does the brief NOT say that it should, given how agents have actually failed? Be
concrete and quote the relevant reports.`,
  },
];

const safe = (p, o) => agent(p, o).catch(() => null);
const LEDGER = 'docs/META_LEDGER.md';

let round = 0, dry = 0;
const applied = [], recommendations = [], rejected = [];
const seen = new Set();

while (round < 2 && dry < 1) {
  round++;

  /* ---------------------------------------------------------------- inspect */
  phase('Inspect');
  const proposals = (await parallel(LENSES.map((l) => () => safe(
`You are auditing the PROCESS of a software project, not its code quality.

${CONTEXT}
${SAFETY}

## YOUR LENS: ${l.key}
${l.q}

## What counts as a good finding
It names a SPECIFIC past failure (cite the file, report, commit or issue number), and proposes
a change that would have caught it, which is small, additive and obviously safe. "Add more
tests" is not a finding. "The daemon swallows shader errors into warnings[] that no caller
prints, which is why X shipped broken for four waves — print them to stderr and exit non-zero
in preflight" is a finding.

Bias hard toward the boring and mechanical. A one-line check that runs automatically beats a
paragraph of guidance nobody reads.

If a finding requires editing \`src/\`, set \`srcOnly: true\` and describe it as a
recommendation — do NOT implement it.

Read \`${LEDGER}\` if it exists: everything listed there is already known. Do not re-propose it.
Return at most 6 findings, ordered by (value / risk). Fewer, better findings beat more.`,
    { label: `inspect:${l.key}`, phase: 'Inspect', effort: 'high', schema: FINDING_SCHEMA })
  ))).filter(Boolean).flatMap((r) => r.findings || []);

  const fresh = proposals.filter((f) => f?.id && !seen.has(f.id));
  fresh.forEach((f) => seen.add(f.id));
  log(`round ${round}: ${proposals.length} proposed, ${fresh.length} new`);

  if (!fresh.length) { dry++; log('nothing new — converged'); break; }

  /* ----------------------------------------------------------------- verify */
  phase('Verify');
  const verdicts = await parallel(fresh.map((f) => () => safe(
`You are a skeptical reviewer. **Default to rejecting.** Working dir: /workspace/zer0/products/halo

A process-audit agent proposes this change:

  TITLE:    ${f.title}
  EVIDENCE: ${f.evidence}
  FIX:      ${f.fix}
  FILES:    ${f.files}
  RISK:     ${f.risk}   VALUE: ${f.value}   srcOnly: ${f.srcOnly ? 'yes' : 'no'}

Check, by actually reading the repo — not by reasoning about it:

1. **Is the evidence true?** Open the files, reports and commits it cites. Agents in this
   project have confidently cited failures that did not happen the way they described. If the
   evidence does not hold up, reject.
2. **Is it already covered?** By an existing tool, an existing doc, or \`${LEDGER}\`?
   Duplicate guardrails are noise and erode trust in the real ones.
3. **Is the fix genuinely safe and additive?** Could it break a capture, slow one down, make
   the build fail, or block every agent at once? Would it produce false positives — a gate
   that cries wolf gets disabled and is worse than nothing.
4. **Does it require editing \`src/\`?** Then it is recommendation-only, whatever its merit.
5. **Is there a simpler fix?** If a one-line npm script does what a CI pipeline was proposed
   for, say so in \`betterFix\`.

Set \`real\` and \`safe\` independently. \`real: true, safe: false\` is a useful verdict — it means
a genuine problem with a dangerous fix. If uncertain, reject.`,
    // sonnet: the answer is checkable — open the cited files and see whether the claim holds.
    // See docs/MODEL_TIERS.md. Effort stays high; the cheapening is the model, not the care.
    { label: `verify:${f.id}`, phase: 'Verify', model: 'sonnet', effort: 'high', schema: VERDICT_SCHEMA })
    .then((v) => ({ f, v }))));

  const ok = verdicts.filter(Boolean).filter((x) => x.v?.real && x.v?.safe && !x.f.srcOnly);
  const recs = verdicts.filter(Boolean).filter((x) => x.v?.real && (x.f.srcOnly || !x.v.safe));
  rejected.push(...verdicts.filter(Boolean).filter((x) => !x.v?.real)
    .map((x) => ({ id: x.f.id, title: x.f.title, why: String(x.v?.reasoning ?? '').slice(0, 300) })));
  recommendations.push(...recs.map((x) => ({ id: x.f.id, title: x.f.title, fix: x.f.fix,
    why: String(x.v?.reasoning ?? '').slice(0, 300), srcOnly: !!x.f.srcOnly })));

  log(`round ${round}: ${ok.length} confirmed, ${recs.length} recommendation-only, ${verdicts.filter(Boolean).length - ok.length - recs.length} rejected`);
  if (!ok.length) { dry++; continue; }

  /* ------------------------------------------------------------------ apply */
  phase('Apply');
  const order = { high: 0, medium: 1, low: 2 };
  const todo = ok.sort((a, b) => (order[a.f.value] ?? 3) - (order[b.f.value] ?? 3)).slice(0, 4);

  const results = await parallel(todo.map(({ f, v }) => () => safe(
`${CONTEXT}
${SAFETY}

## YOUR TASK: implement exactly this guardrail, and nothing else

  ${f.title}

  WHY:   ${f.evidence}
  FIX:   ${f.fix}
  FILES: ${f.files}
${v.betterFix ? `\n  A reviewer suggested a simpler approach — evaluate it and use it if it is better:\n  ${v.betterFix}\n` : ''}
Scope discipline is the whole job here. Implement this one thing, well, and stop. Do not
bundle in improvements you noticed along the way — write those into \`${LEDGER}\` under
"Noticed, not done" instead.

**Test that it actually fires.** A gate nobody has seen trip is not known to work: construct
the failure it targets (in a scratch copy under /tmp, never in the repo), confirm the gate
catches it, then confirm it passes on the clean tree. Report both.

Then prove you did no harm, and quote the output:
    node tools/parsecheck.mjs
    node tools/capture.mjs --pose ref_00000 --out /tmp/meta_smoke.png --settle 8

Append your entry to \`${LEDGER}\` (create it with a header if missing): what you added, what
past failure it catches, how to run it, and how to turn it off if it becomes a nuisance. That
last part matters — an un-disableable gate that misfires will simply be deleted by someone in
a hurry, and then it protects nothing.

Return: what you added, proof it fires, proof of no harm.`,
    // sonnet: a named guardrail, with a spec and a proof-it-fires test. Narrow search space.
    { label: `apply:${f.id}`, phase: 'Apply', model: 'sonnet', effort: 'high' })
    .then((r) => ({ id: f.id, title: f.title, result: String(r ?? '(died)').slice(0, 1200) }))));

  applied.push(...results.filter(Boolean));
}

/* ------------------------------------------------------------------- report */
phase('Report');

// haiku: pure transcription. Run the commands, quote what they print. No judgement — the
// reporter below decides whether the numbers are acceptable. See docs/MODEL_TIERS.md.
const health = await safe(
`Working dir: /workspace/zer0/products/halo

Run each command and report its EXACT output and exit code. Do not interpret, fix, or
comment on the results — another agent judges them. If a command fails, that is a valid
result: quote the error verbatim.

    node tools/parsecheck.mjs; echo "exit=$?"
    node tools/preflight.mjs 2>&1 | tail -20; echo "exit=$?"
    node tools/capture.mjs --pose ref_00000 --out /tmp/meta_final.png --settle 8 2>&1 | tail -15
    git status --short | head -30
    npm run 2>&1 | head -20

Return the raw output under a heading per command.`,
  { label: 'health-transcript', phase: 'Report', model: 'haiku' });

const summary = await safe(
`Working dir: /workspace/zer0/products/halo

A meta-audit loop just ran over this project's PROCESS and applied guardrails.

APPLIED THIS RUN:
${applied.map((a) => `- ${a.id}: ${a.title}`).join('\n') || '(none)'}

RECOMMENDATIONS NOT APPLIED (need an src/ change or were judged unsafe here):
${recommendations.map((r) => `- ${r.id}: ${r.title}${r.srcOnly ? ' [src/]' : ' [unsafe as proposed]'}\n    ${r.fix}`).join('\n') || '(none)'}

REJECTED (evidence did not hold up, or already covered):
${rejected.map((r) => `- ${r.id}: ${r.why}`).join('\n') || '(none)'}

A cheap transcription agent already ran the health commands. Here is its raw output —
verify it rather than trusting it, but do not re-run everything from scratch:

${String(health ?? '(transcript agent died — run the commands yourself)').slice(0, 3000)}

Your job:
1. Judge that health output. This loop touched tooling every agent depends on, so a
   regression here blocks everyone at once. If anything is broken, find the guardrail that
   did it and revert THAT ONE — not the whole run.
2. Run every gate this loop added and confirm each passes on the clean tree. A gate that
   fails on a healthy tree will be disabled by the next person in a hurry.
3. Tidy \`${LEDGER}\` into something a future agent can act on: what is now gated, what is
   recommended but not done (with enough detail to act on), and what was rejected and why —
   so it is not re-proposed every run.
4. State plainly: **which single remaining process gap is most likely to cause the next silent
   failure?** One paragraph, specific, with the evidence.

Return that summary.`,
  { label: 'meta-report', phase: 'Report', effort: 'high' });

return { rounds: round, applied, recommendations, rejected, summary: String(summary ?? '').slice(0, 6000) };
