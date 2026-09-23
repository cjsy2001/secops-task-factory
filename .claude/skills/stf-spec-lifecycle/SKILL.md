---
name: stf-spec-lifecycle
description: Drive a spec through specify → clarify → plan → tasks in ONE session, stop at the session gate, and run the read-only analyze pass in a FRESH session. Use when the user asks to "spec a project", "charter a spec", "clarify spec N", "plan spec N", "generate tasks", "resume the lifecycle", or "analyze spec N". Modes - charter | specify | clarify | plan | tasks | analyze | resume. Every phase completion goes through stf_advance_phase, which hashes the artefacts and enforces order and the gate.
---

# stf-spec-lifecycle

The spec's CONTENT lives on disk in `specs/NNN-slug/`; its STATE (phase, gate, artefact hashes) lives in the
plane. You never decide on your own that a phase is done: `stf_advance_phase` does, and it refuses
out-of-order phases, missing files, unresolved clarification markers, untiered tasks, and an analyze
run in the session that wrote the tasks.

## Phase 0: where are we (always)

1. `stf_status` (or `stf_get_spec {seq}`). Read `phase`: it is the NEXT phase to run.
2. If a handoff is pending for this spec, run **stf-handoff pickup** first.
3. `stf_start_run {seq, kind: "lifecycle"}` (or `"analyze"`). Keep the returned `runKey`: every write needs it.
   If `openPeerRuns` is non-empty, tell the user before you continue.

Resume = run the phase that `phase` names. Never re-run a completed phase silently; to redo one,
`stf_reopen_phase {seq, phase, reason, runKey}` after telling the user why.

## Mode charter

`stf_charter_spec {slug, title, summary}` registers the spec and creates the folder. The phase is then `specify`.

## Phase 1: specify → `spec.md`

Draft the spec BEFORE asking the user anything. Required sections:

```
# <Title>
> seq: NNN · slug · status: draft · date
## Overview            (problem, who it's for, what "portfolio-ready" means here)
## User Scenarios      (US1..USn: Given/When/Then, each independently demonstrable)
## Functional Requirements   (FR-001..: one testable "MUST" each)
## Non-Functional Requirements (NFR-001..: security, cost, operability)
## Success Criteria    (SC-001..: numeric or binary, measurable by a command)
## Key Entities        (only if data is involved)
## Out of Scope
## Assumptions         (every guess you made instead of asking)
## Open Questions      (Q-001..: the ≤3 [NEEDS CLARIFICATION: …] items that genuinely need the user)
## Clarifications      (filled by clarify)
```

Rules:
- IDs are stable. Never renumber.
- Use at most 3 `[NEEDS CLARIFICATION: …]` markers. Everything else becomes an Assumption.
- Every SC must be checkable by a command or an observable artefact.
- For each Open Question, call `stf_capture_open_question {seq, question, specRef: "Q-00N"}`.

Before completing the phase, score the draft: Completeness 25, Clarity 25, Testability 20, Alignment 15, Feasibility 15. Below 70 means fix the draft first.

Then `stf_advance_phase {seq, phase: "specify", runKey, artefacts: ["spec.md"]}`.

## Phase 2: clarify

1. Rate the ambiguity in scope, data, security, cost, operations, UX, integrations and testing.
2. Rank the questions by impact × uncertainty × rework risk.
3. Ask **at most 5**, using AskUserQuestion. Put the recommended option first, labelled "(Recommended)".
4. For each answer:
   - Append it under `## Clarifications` → `### Session YYYY-MM-DD` → `- Q: … → A: … (source: user)`.
   - Replace the matching `[NEEDS CLARIFICATION]` marker in the body.
   - `stf_capture_alternative` for each option that was not chosen (verdict `rejected`).
   - `stf_capture_decision {seq, title, statement, rationale, resolves: [OQ-…], rejects: [ALT-…]}`.
5. Then `stf_advance_phase {… phase: "clarify", artefacts: ["spec.md"]}`. It refuses while any marker remains.

## Phase 3: plan → `research.md`, `plan.md` (+ `data-model.md`, `contracts/` if relevant)

- `research.md`: for each technical choice, write Decision / Rationale / Alternatives. Verify library and tool
  facts against their docs. Don't rely on memory; cite a URL or a command output. Record the load-bearing
  choices with `stf_capture_decision`.
- `plan.md`: architecture (a mermaid diagram), components with their exact paths under `projects/<name>/`,
  the Azure resources, the security controls, the test strategy, and the phases.
- Put an `<!-- Source: spec.md#FR-00N -->` trace marker next to each section.
- Checklist before completing: every FR is covered by a plan section, no entity is invented, and every output
  says how it is delivered (command, workflow, or resource).
- Then `stf_advance_phase {… phase: "plan", artefacts: ["plan.md", "research.md"]}`.

## Phase 4: tasks → `tasks.md`

Grammar (the parser is strict):

```
## Phase 1: Setup
- [ ] T001 [P] [US1] Verb component in projects/x/path (FR-001, FR-002) {sonnet/medium}
  - objective: why this task exists, in one line
  - plan: the concrete steps
  - tests: the exact command that proves it
```

- Phases run in this order: Setup → Foundational → one phase per user story → Polish.
- Within a phase: tests first, then implementation.
- `[P]` only when the task touches different files and has no dependency.
- Every task has a `{tier/effort}` suffix:
  - `haiku/low`: a mechanical single edit.
  - `sonnet/medium–high`: contract-driven implementation (the default).
  - `opus/high+`: design across several constraints, or security-critical logic.
  - `fable`: judgment-heavy review.
- Every FR is covered by at least one task.

Then:
1. `stf_import_tasks {seq}`. Fix any errors and re-import.
2. `stf_advance_phase {… phase: "tasks", artefacts: ["tasks.md"]}`. This **sets the session gate**.
3. `stf_complete_run`.
4. **stf-handoff emit** with `skill: stf-spec-lifecycle`, `invocation: "/stf-spec-lifecycle analyze N"`, `freshSession: true`.
5. **STOP.** Tell the user that analyze needs a new session.

## Phase 5: analyze (fresh session only; read-only on the artefacts)

Run six passes over spec, plan and tasks:
1. duplication
2. ambiguity (vague adjectives, TODOs)
3. underspecification
4. invariants and constraints (security, `.claude/rules/`)
5. coverage (each FR has a task; each task has an FR)
6. inconsistency (terms, paths, counts)

Scoring starts at 100: Critical −15, High −8, Medium −4, Low −1. Write the report to
`analysis/cross-artifact-analysis-YYYY-MM-DD.md`, with a table of the findings.

- **Passes** (score ≥80 and 0 High): `stf_advance_phase {… phase: "analyze", reportPath, healthScore, highFindings}`. The spec is then `done`, and implementation may start.
- **Fails:** show the findings, then `stf_reopen_phase` to the earliest phase at fault. Never inflate a score to pass the gate.

## Never

- Write a phase's artefact and skip `stf_advance_phase`, then carry on as if the phase were done.
- Run analyze in the same session as tasks. The server refuses it; don't try to route around it with a new run.
- Invent facts about tools, APIs or Azure SKUs. Mark them as Assumptions, or verify them and cite the source.
