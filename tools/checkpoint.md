# Making workflows survive being killed

Long workflows die: session limits, OOM, a machine reboot. This project lost 15 of 17
agents to a usage limit twice in one night. Almost none of the *work* was lost, and the
difference between "almost none" and "none" is worth engineering.

## What survives by default, and what does not

**Survives:** every file an agent edited. Agents write straight to the working tree, so
their code is on disk the moment they write it. After losing 15 agents mid-flight, all
23 subsystems were present, complete, and parsing.

**Does not survive:** the agent's final message — the measured numbers, the cost figures,
the determinism result, and its own assessment of what a reviewer should attack first.
That is exactly the material the next stage needs, and it evaporates.

**Also does not survive:** any downstream stage. A `pipeline()` whose stage 1 returns
null skips the rest of the chain for that item, so a dead builder silently takes its
critic and refiner with it.

## The fix: agents checkpoint their own report

Make writing the report a *deliverable*, not a return value:

```
## Final message
Write your report to `reports/<yourkey>.md` FIRST, then return the same text.
If you are interrupted, that file is the only thing that survives — write it as soon as
you have numbers worth keeping, and update it as you go.
```

An agent that writes `reports/terrain.md` at the 70% mark and dies at 90% leaves a usable
artefact. One that only returns a string leaves nothing.

## The fix: never let a null cascade

`agent()` returns `null` when it dies. Guard every stage boundary:

```js
const safe = (p, o) => agent(p, o).catch(() => null);

// and when consuming a previous stage, fall back to the checkpoint on disk:
const report = prev ?? readReport(t.key) ?? '(builder died; judge the source directly)';
```

A critic handed "the builder died, read the source yourself" still produces a useful
review. A critic handed `null` produces nothing.

## The fix: resume replays what already finished

```bash
Workflow({ scriptPath: '...', resumeFromRunId: 'wf_xxx' })
```

Agents whose `(prompt, opts)` are unchanged replay from cache instantly; only the failed
ones re-run. **Do not edit the script before resuming** unless you mean to invalidate the
cache from that point on — the longest unchanged prefix is what replays.

Check what a run actually returned before assuming there is something to recover:

```bash
grep -c '"type":"result"' <transcriptDir>/journal.jsonl
```

## The fix: commit continuously

The orchestrator should commit after every wave, and on any signal that a wave is dying.
`git` is the real checkpoint — it is what makes "the files survived" into "the files
survived and I can tell what changed."

## What this does not fix

An agent killed mid-edit can leave a file that does not parse. That is a real hazard with
many agents in one tree, and it took the whole build down twice here. Two mitigations,
both now in place:

- `Engine.init` catches per-module init failures, disables the module, records it in
  `__HALO__.failedModules()`, and carries on. One broken subsystem no longer blanks the
  screen for everyone.
- `src/modules.js` already skips modules that fail to import.

So a half-written file costs you that subsystem, not the session.
