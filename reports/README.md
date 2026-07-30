# Agent checkpoints

Agents write their report here **as they work**, not only at the end.

This session was killed twice by usage limits mid-flight, losing 19 of 21 agents' final
messages. Every file edit survived — all 23 subsystems were on disk, complete and
parsing — but the measured numbers, costs and "attack this next" notes were gone.

So the report is a deliverable, not a return value. An agent that writes
`reports/terrain.md` at the 70% mark and dies at 90% leaves something usable behind.
One that only returns a string leaves nothing.

Workflow scripts consume these as a fallback when `agent()` returns null, so a dead
builder no longer takes its critic and refiner down with it.

Full rationale and the other recovery mechanisms: `tools/checkpoint.md`.
