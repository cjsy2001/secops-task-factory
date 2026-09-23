---
name: stf-handoff
description: Persist the next session's prompt in the stf plane (sha256-sealed), route it from durable state, and pick it up byte-exact in a fresh session. Use when the user says "hand off", "emit the handoff", "end the session", "pick up my handoff", "resume where we left off", "what's next", or "list/archive handoffs". Also called by stf-implement and stf-spec-lifecycle at their ends.
---

# stf-handoff

A handoff is a **baton**, not a memory: one prompt that tells the next session exactly where to start,
and how to check that the start is still true.

## emit

1. **Probe durable state.** Don't rely on chat recall. Run `stf_status {seq}`, `stf_next_task {seq}`,
   `git status -sb`, `git log -1 --oneline`, and `stf_verify {seq, apply: false}`.
2. **Route.** The first rule that matches wins:
   | # | Signal (from the probes) | skill / invocation | tier | fresh |
   |---|---|---|---|---|
   | R1 | open questions on the spec | `stf-spec-lifecycle` · `/stf-spec-lifecycle clarify N` | opus/high | no |
   | R2 | phase = specify/clarify/plan/tasks | `stf-spec-lifecycle` · `/stf-spec-lifecycle resume N` | opus/high | no |
   | R3 | phase = analyze (gate set) | `stf-spec-lifecycle` · `/stf-spec-lifecycle analyze N` | opus/high | **yes** |
   | R4 | phase = done, no task started | `stf-implement` · `/stf-implement N` | tier of the next task | no |
   | R5 | tasks in progress / pending | `stf-implement` · `/stf-implement N` | tier of the next task | no |
   | R6 | all tasks done/cancelled | `stf-status` · `/stf-status N` (report, then retro) | sonnet/medium | no |
   | R7 | nothing matches | refuse, and name the signal that is missing | | |
3. **Write the prompt** using this template:
   ```
   ## Position
   - <claim> (probe: `<command or stf tool call that proved it>`)
   ## Next step
   <invocation, verbatim>
   ## Gates
   - <anything that must be true before continuing, e.g. "analyze must run in a fresh session">
   ## Operator context
   - <the user's latest instruction or open decision, quoted verbatim>
   ## Provenance
   - emitted by <skill> in run <runKey>, commit <sha>
   ```
4. `stf_handoff_emit {seq, skill, invocation, modelTier, effort, freshSession, prompt}`. The server refuses a prompt
   without Position or Next step, or whose Next step doesn't contain the invocation. It closes the previous head.
5. Tell the user the handoff id and the exact first message for the next session:
   *"/stf-handoff pickup N"*.

## pickup

1. `stf_handoff_pickup {seq}` (or `{id}`). The server verifies the sha256. `tampered` or
   `fresh_session_required` means STOP and tell the user.
2. Echo the prompt verbatim.
3. **Re-probe every Position claim.** If one is false, say which, and route from the current state.
4. Check the tier: if `modelTier` doesn't match this session's model, say so. Under-tier means stop and ask.
5. Run the routed invocation in this session.

## list / archive

`stf_handoff_list {seq}` shows the chain. `stf_handoff_archive {id, reason}` removes a baton that should not be run.
