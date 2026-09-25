---
name: status
description: Read-only "where are we / what's next" across all specs or for one spec, from the stf plane plus disk and git. Use when the user asks "status", "where are we", "what's next", "progress on spec N", "what's blocked", or "brief me".
---

# stf:status (read-only)

1. `stf_status {seq?}` for phase, gate, counts, next task, open questions, pending handoff and open runs.
2. `stf_verify {seq?, apply: false}` for evidence health. It is read-only in this mode.
3. `git status -sb` and `git log --oneline -5`.
4. Report in this order:
   - a one-line position per spec;
   - blockers (blocked tasks with reasons, `absent` evidence, drift);
   - open questions;
   - the single recommended next step, with its invocation (use the stf:handoff routing table).

If the user wants to see it rather than read it, run `stf dashboard` (Bash tool; it only reads the plane) and give them the
path it prints (`.stf/dashboard.html`, gitignored) to open in a browser.

Every claim you report carries the probe it came from. If the plane and disk disagree, say so and cite
both. Never smooth over a divergence. Don't write anything; for fixes, point at the skill that owns them.
