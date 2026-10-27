# Using stf in your own repo

`stf` is a Claude Code plugin that runs spec-driven, evidence-backed development in any git repo. It gives you:

- **Skills:** `/stf:spec-lifecycle`, `/stf:implement`, `/stf:handoff`, `/stf:memory`, `/stf:decide`, `/stf:status`,
  `/stf:new-project` and `/stf:pages`.
- **A local MCP server, the "plane",** whose tools appear as `mcp__plugin_stf_stf__stf_*`. It holds lifecycle
  phases, task status, decisions, memory and handoffs. It refuses claims that it can't verify.
- **Hooks:**
  - a SessionStart recall block: where the project left off;
  - a PostToolUse hook that keeps `tasks.md` in sync with the plane.

The plane runs in memory on SQLite and is rebuilt from `.stf/export/*.json`, which you commit with your work. Git
history is the audit log. Nothing is hosted, and there's no account or auth. Each repo has its own plane.

This guide covers installing stf, starting a project, and one feature taken end to end. The example
(`log-triage`) is illustrative. The commands and tool names are real, but the outputs are abridged.

---

## 1. Requirements

| Need | Why |
|---|---|
| Claude Code | the plugin host |
| Node ≥ 20 and npm | on first start, the plugin builds its runtime (`npm ci` → `tsc`, with the native `better-sqlite3`) |
| git | the plane verifies evidence against your repo's git history, so it must sit at a git root |
| Docker, or the `gitleaks` binary | the secret-scanning pre-commit hook and `make gitleaks` that the scaffold installs |
| `gh` (optional) | `/stf:new-project` uses it to create and protect the GitHub repo |

## 2. Install

Pick one path.

### A. A new project repo (recommended)

Install the plugin for your user once, so the `stf` command and the skills are available everywhere:

```bash
claude plugin marketplace add cjsy2001/secops-task-factory
claude plugin install stf@secops-task-factory
```

Then, in any Claude Code session:

```
/stf:new-project
```

It asks for a name, a description, visibility, whether to include the Azure rules, and a license. Then it runs:

```bash
stf new-project ../log-triage --name log-triage \
  --description "Parse auth logs and flag brute-force bursts, with a JSON report per run." \
  --title "Log triage CLI" --no-azure --license mit
```

You get a repo with git, a gitleaks pre-commit hook and CI job, `.claude/settings.json` enabling stf,
per-concern rules in `.claude/rules/`, a `CLAUDE.md`, and an empty plane with **spec 001 chartered**. The skill
makes one initial commit. It asks before each GitHub step: create and push the repo, then protect `main`.

### B. An existing repo

From the repo root:

```bash
claude plugin marketplace add cjsy2001/secops-task-factory
claude plugin install stf@secops-task-factory --scope project   # writes .claude/settings.json; commit it
```

Then create the plane and charter your first spec, inside a Claude Code session:

```
! stf init
/stf:spec-lifecycle charter
```

`stf init` writes an empty `.stf/export/`. Commit it. Add these lines to your `.gitignore`:

```
.stf/*.db*
.stf/dashboard.html
.stf/spec-page-*.html
.stf/hub.html
.stf/export/*.tmp-*
```

### C. Sharing a repo with teammates

Commit `.claude/settings.json` with the marketplace and the plugin enabled. When teammates trust the folder,
Claude Code offers to install stf:

```json
{
  "extraKnownMarketplaces": {
    "secops-task-factory": { "source": { "source": "github", "repo": "cjsy2001/secops-task-factory" } }
  },
  "enabledPlugins": { "stf@secops-task-factory": true },
  "permissions": { "allow": ["mcp__plugin_stf_stf"] }
}
```

### First start

The first session after installing builds the runtime in the background, so for a few seconds the server shows no
tools. When the build finishes, the tools appear by themselves. Check with `/stf:status`.

---

## 3. The workflow

```
 charter ─▶ specify ─▶ clarify ─▶ plan ─▶ tasks ─┃ session gate ┃─▶ analyze ─▶ implement ─▶ checkpoint ─▶ handoff
   spec.md              decisions     plan.md     tasks.md        (new session)  (TDD, hashed     (real commit
                        D-NNN         research.md                  health ≥ 80     outcomes)        sha)
```

| Phase | Session | Skill | Writes | The server checks |
|---|---|---|---|---|
| charter | any | `/stf:spec-lifecycle charter` | `specs/NNN-slug/` | slug and title |
| specify | 1 | `/stf:spec-lifecycle specify N` | `spec.md` | phase order; the file exists |
| clarify | 1 | `/stf:spec-lifecycle clarify N` | `spec.md` Clarifications, decisions | no `[NEEDS CLARIFICATION]` left |
| plan | 1 | `/stf:spec-lifecycle plan N` | `plan.md`, `research.md` | phase order; the files exist |
| tasks | 1 | `/stf:spec-lifecycle tasks N` | `tasks.md` | strict grammar; every task has a tier. **Sets the gate.** |
| analyze | **2, new** | `/stf:spec-lifecycle analyze N` | `analysis/*.md` | refused in session 1; health ≥ 80; no High findings |
| implement | 3+ | `/stf:implement N` | code, tests | outcomes need an open run and hashed artefacts |

### Session start and end

- **Start.** The recall block lists open questions, phases, pending handoffs and memories. If a handoff is
  pending, run `/stf:handoff pickup`. Otherwise run `/stf:status`.
- **End.** The skills end with `/stf:handoff emit`, which seals the next session's prompt (sha256) in the plane.
  Commit `.stf/export/` with the work.

---

## 4. Worked example: `log-triage`, spec 001

### Session 1: specify → clarify → plan → tasks

```
/stf:spec-lifecycle specify 1
```

Claude drafts `specs/001-log-triage/spec.md` before asking you anything:

```markdown
# Log triage CLI
> seq: 001 · log-triage · status: draft · 2026-10-27
## Overview
Security analysts need a fast way to spot SSH brute-force bursts in auth.log…
## User Scenarios
- US1: Given an auth.log, When I run `log-triage scan auth.log`, Then I get a JSON report listing source IPs
  with ≥ N failures in a window.
## Functional Requirements
- FR-001: The CLI MUST parse OpenSSH "Failed password" lines from auth.log.
- FR-002: The CLI MUST flag an IP with ≥ threshold failures within a sliding window.
- FR-003: The report MUST be valid JSON matching `contracts/report.schema.json`.
## Success Criteria
- SC-001: `pytest` passes on the fixture logs in `tests/fixtures/`.
- SC-002: Scanning a 100 MB log takes < 10 s on a laptop (`time log-triage scan …`).
## Assumptions
- Logs are in the Debian/Ubuntu syslog format.
## Open Questions
- Q-001: [NEEDS CLARIFICATION: default threshold and window: 5 in 60 s, or 10 in 5 min?]
```

Each open question is recorded with `stf_capture_open_question`. The phase is completed with
`stf_advance_phase {seq: 1, phase: "specify", artefacts: ["spec.md"]}`.

**Clarify** asks you up to 5 questions, with the recommended option first. Each answer is written under
`## Clarifications`, replaces its marker, and is recorded as a decision (`D-001`) with the rejected options as
alternatives (`ALT-…`). The phase won't advance while any marker remains.

**Plan** writes `research.md` (Decision / Rationale / Alternatives, with tool facts cited to docs or command
output) and `plan.md` (architecture, paths, security controls, test strategy).

**Tasks** writes `tasks.md` in a strict grammar:

```markdown
## Phase 1: Setup
- [ ] T001 Create the Python package skeleton in src/log_triage/ (FR-001) {haiku/low}
  - objective: a package and an entry point the tests can import
  - plan: pyproject.toml with a console script; src/log_triage/__init__.py
  - tests: python -m pip install -e . && log-triage --help

## Phase 3: User Story 1 - scan a log
- [ ] T004 [US1] Write failing tests for burst detection in tests/test_detect.py (FR-002) {sonnet/medium}
  - objective: pin the threshold/window behaviour before writing code
  - plan: fixtures with 4, 5 and 6 failures inside and outside the window
  - tests: pytest tests/test_detect.py
- [ ] T005 [US1] Implement sliding-window detection in src/log_triage/detect.py (FR-002) {sonnet/medium}
  - objective: make T004 pass
  - plan: deque per IP, evict entries older than the window
  - tests: pytest tests/test_detect.py
```

- Phases run Setup → Foundational → one phase per user story → Polish.
- `[P]` marks a parallel-safe task.
- `{tier/effort}` is the model the task should run on: `haiku/low`, `sonnet/medium`, `opus/high` or `fable`.

`stf_import_tasks` parses the file, and `stf_advance_phase … "tasks"` **sets the session gate**. The session emits
a handoff marked `freshSession: true` and stops.

### Session 2 (new): analyze

```bash
claude      # a new session in the same repo
/stf:handoff pickup
/stf:spec-lifecycle analyze 1
```

Six read-only passes run over spec, plan and tasks: duplication, ambiguity, underspecification, invariants,
coverage and inconsistency. Scoring starts at 100: Critical −15, High −8, Medium −4, Low −1. The report goes to
`specs/001-log-triage/analysis/`.

- **Pass:** score ≥ 80 and no High finding. The phase becomes `done` and implementation may start.
- **Fail:** `stf_reopen_phase` back to the phase at fault.

The server refuses analyze in the session that wrote the tasks, so the review is done fresh, without the context
that produced the tasks.

### Session 3+: implement

```
/stf:implement 1
```

1. **Preflight:**
   - pick up the handoff and re-run its Position probes;
   - check the spec is `done`;
   - `stf_verify` re-checks every recorded artefact hash;
   - `stf_next_task` names the next task and its tier.
2. **Run:** `stf_start_run {seq: 1, kind: "implement"}` returns a `runKey`. Work on a `feat/001-log-triage-us1` branch.
3. **Per task, TDD:**
   1. `stf_get_task` returns the exact title, which every later write passes as `expectTitle` (the wrong-row guard).
   2. `stf_set_task_status {status: "in_progress"}`.
   3. Write the test and watch it fail. Implement until it passes.
   4. Close the task:
      ```
      stf_capture_task_outcome {
        seq: 1, localId: "T005", expectTitle: "Implement sliding-window detection in src/log_triage/detect.py",
        runKey: "implement-001-…",
        output: "pytest tests/test_detect.py: 3 failed → 3 passed",
        testsCommand: "pytest tests/test_detect.py",
        artefacts: ["src/log_triage/detect.py", "tests/test_detect.py"]
      }
      ```
      The server records the sha256 of each artefact and flips `[X]` in `tasks.md` itself.
4. **Checkpoint at the end of a phase:** run the phase's tests, then `git commit`, then
   `stf_checkpoint {…, commitSha: "<real sha>"}`. An unknown sha is refused.
5. **Close:** `stf_complete_run`, then `/stf:handoff emit`. Commit `.stf/export/` and open a PR.

From then on, every session's `stf_verify` puts each closed task's evidence into one of three states:

| Verdict | Meaning | Effect |
|---|---|---|
| `verified` | the file still has the recorded hash | none |
| `superseded` | the file changed later, but the recorded content is in git history | information only |
| `absent` | the evidence is gone | the task flips to **blocked** |

---

## 5. Other skills

| Skill | Use it for |
|---|---|
| `/stf:status [N]` | read-only: phase, gate, counts, next task, open questions, pending handoff |
| `/stf:decide` | record a decision with its alternatives and evidence ("why X and not Y") |
| `/stf:memory` | lessons and constraints the next session needs. `/stf:memory checkpoint` sweeps the session for them |
| `/stf:handoff emit` / `pickup` / `list` | the sealed next-session prompt |
| `/stf:pages` | publish read-only status pages: hub, dashboard, one page per spec |

CLI, run inside a Claude Code session (`! stf …`):

```
stf status [seq]        stf verify [seq] [--dry-run]     stf dashboard     stf pages
stf init [dir]          stf import-tasks <seq>           stf export        stf charter <slug> <title> <summary>
stf plane-diff <base> [head]   what a change does to the plane, as Markdown (for a PR comment)
stf new-project <dir> --name <kebab> --description <text> [--title …] [--private] [--no-azure] [--license mit|none]
```

---

### A live view of any public repo

The plane viewer at <https://cjsy2001.github.io/secops-task-factory/viewer/> renders a repo's specs, tasks, decisions,
questions and documents straight from GitHub, with no command to run. Each recorded document carries a badge saying
whether it still has the hash its phase recorded, which is the check `stf verify` makes.

- `?repo=owner/name` picks the repo, and `&ref=<branch>` previews a PR's branch.
- It reads `raw.githubusercontent.com`, so it works for public repos only.

## 6. What the server refuses, and what to do

| Refusal | Why | Fix |
|---|---|---|
| Phase out of order / missing artefact | specify → clarify → plan → tasks → analyze | run the phase that `stf_status` names |
| `[NEEDS CLARIFICATION]` remains | clarify isn't finished | answer the questions, or turn them into Assumptions |
| analyze in the same session | the session gate | start a new session, then `/stf:handoff pickup` |
| analyze below 80, or a High finding | the quality gate | fix the findings; `stf_reopen_phase` to the phase at fault |
| Task outcome without a run, output or artefacts | no done without evidence | `stf_start_run`, and list real files |
| `expectTitle` mismatch | the wrong-row guard | `stf_get_task` and use its exact title |
| Unknown `commitSha` | checkpoints need real commits | commit first, and pass `git rev-parse HEAD` |
| Tampered handoff / own fresh-session handoff | sealed handoffs | pick it up in a new session; never edit `handoffs.json` |
| Text that looks like a key, token, webhook or password | no secrets in the plane | keep secrets in a vault or env vars; reference them by name |
| A hand-flipped `[X]` in `tasks.md` | the plane mirrors the markers | close the task with `stf_capture_task_outcome` |

Never hand-edit `.stf/export/`. It's written only by the server and the CLI.

---

## 7. Updating and removing

- **Update:** `claude plugin marketplace update secops-task-factory`. The runtime rebuilds on the next start.
  Each plugin version builds its own runtime, so repos on different versions don't interfere.
- **Remove:** `claude plugin uninstall stf@secops-task-factory`. Your `.stf/export/` and `specs/` stay in the repo
  as plain JSON and Markdown.

## 8. Troubleshooting

- **No `stf_*` tools in the first minute:** the runtime is still building. Wait for the tools to appear, then run `/stf:status`.
- **The runtime build fails:** check `node --version` (it must be ≥ 20) and that npm can reach the registry.
- **No recall block at start:** the repo has no plane yet. Run `stf init`, or `/stf:new-project` for a new repo.
- **The pre-commit hook refuses with "gitleaks not found":** install gitleaks or start Docker. Don't use `--no-verify`.

Report bugs and ask questions at <https://github.com/cjsy2001/secops-task-factory/issues>.
