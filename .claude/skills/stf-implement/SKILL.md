---
name: stf-implement
description: Execute a spec's tasks.md phase by phase with TDD, hash-verified outcomes, run tracking and checkpoints in the stf plane, then hand the session off through the plane. Use when the user asks to "implement spec N", "start the build", "resume implementation", "continue spec N", or "do the next task". Requires the spec's lifecycle phase to be done (analyze passed).
---

# stf-implement

The plane is the source of truth for STATUS. A task is done only when `stf_capture_task_outcome` accepts
it, which needs an open run, a real output, and artefact files whose sha256 the server records. Everything
you "remember" from earlier sessions is a claim until a probe confirms it.

## Phase 0: preflight (every session, before any code)

1. **Pickup.** `stf_handoff_pickup {seq}` if a handoff is pending. Re-run every probe in its `## Position`
   section, trying the opposite hypothesis as well. If a claim fails, say so and route from the current state instead.
2. **Gate.** `stf_get_spec {seq}` must show `phase: "done"`. If it doesn't, stop and route to stf-spec-lifecycle, unless the user explicitly overrides.
3. **Evidence.** `stf_verify {seq}`. Report its results before starting:
   - any `absent` tasks (these are now blocked and need redoing);
   - `superseded` tasks (information only);
   - lifecycle drift;
   - marker mismatches.
4. **Context.** Read `plan.md`, `research.md`, the relevant `.claude/rules/*`, and `stf_memory_retrieve {query: <spec topic>}`.
5. **Next.** `stf_next_task {seq}`. Present the phase and its tasks with their tiers, then confirm scope with the user.
6. **Tier check.** If a task's tier is higher than this session's model, stop and ask whether to switch models or dispatch it. If it is lower, say so and proceed.

## Phase 1: open the run

`stf_start_run {seq, kind: "implement"}` → keep the `runKey`. If `openPeerRuns` is non-empty, tell the user.
Work on a branch named `feat/NNN-<slug>-<phase>`, never on `main`.

## Phase 2: execute (strict phase order; within a phase, file order)

For each task:
1. `stf_get_task {seq, localId}`. Use its exact `title` as `expectTitle` from now on.
2. `stf_set_task_status {…, status: "in_progress"}`.
3. **TDD.** Write the failing test (or check) first, run it, and **see it fail**, recording the failure output.
   Then implement until the test passes. For infrastructure, the "test" is a command: `terraform validate`/`plan`, `ansible-lint`, `trivy config`, `pytest`, or a workflow dry-run.
4. `stf_capture_task_outcome {seq, localId, expectTitle, runKey, output, artefacts, testsCommand}`:
   - `output`: what changed, plus the observed test result (fail → pass) with the command.
   - `artefacts`: every repo file the task created or changed. Missing files are refused.
5. If the task fails: `stf_set_task_status {status: "blocked", reason}`. Stop the phase when that failure blocks the next step.

Dispatching subagents: pass the task's `modelTier`/`effort` as the model override. Put the objective, plan,
tests command and exact paths in the prompt. **You** capture the outcome after re-running the tests yourself; the subagent's report is a claim.

Never flip `tasks.md` markers by hand. The server mirrors them.

## Phase 3: checkpoint at every phase boundary

1. Run the phase's full test set.
2. `git commit` with a conventional message that lists the task IDs.
3. `stf_checkpoint {seq, runKey, phase: "<exact heading>", testsPassed, testsCommand, commitSha: <real sha>}`.
   The server refuses a sha that doesn't exist and computes complete or partial itself.
4. Commit the `.stf/export/` changes with it (or in the next commit). The export is the durable record.

## Phase 4: close and hand off

1. `stf_verify {seq}` must come back clean.
2. `stf_complete_run {runKey, outcome, summary}`.
3. **stf-handoff emit** for the next session. The route comes from durable state (see stf-handoff), never from memory of the chat.
4. Offer **stf-memory** for anything durable you learned: lessons, constraints.

## Never

- Say "done", "tests pass" or "deployed" without the command output from THIS session.
- Mark done from a subagent's report without re-running its tests.
- Put secrets, keys or webhook URLs in code, output, memories, or the plane. Use GitHub/Azure secrets and Key Vault.
