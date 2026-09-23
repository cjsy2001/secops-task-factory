# secops-task-factory

Four hands-on security engineering projects, built through a **spec-driven task factory** that keeps
AI-assisted development honest: every claim of "done" must carry verifiable evidence.

| # | Project | Stack | Status |
|---|---|---|---|
| 001 | [DevSecOps CI/CD pipeline with security gates](specs/001-devsecops-pipeline/spec.md) | GitHub Actions · Gitleaks/TruffleHog · Semgrep · Trivy · Dependabot · OIDC → Azure | spec: clarify |
| 002 | [Self-healing hardened server IaC](specs/002-hardened-iac/spec.md) | Terraform · Ansible · Fail2ban/ufw · Docker (non-root) · Cowrie · VMSS auto-repair | spec: clarify |
| 003 | [Malware analysis sandbox](specs/003-malware-sandbox/spec.md) | Docker isolation · Python · auditd/eBPF · YARA · JSON verdicts (benign samples only) | spec: clarify |
| 004 | [Zero-trust cloud audit tool](specs/004-zero-trust-audit/spec.md) | Python · Azure SDK · Microsoft Graph · Event Grid · Functions · webhooks | spec: clarify |

_Live status: `make status` (the table above is a snapshot)._

## How the factory works

```
 spec.md ──specify──▶ clarify ──▶ plan.md ──▶ tasks.md ──┃ session gate ┃──▶ analyze (fresh session) ──▶ implement
                         │                                                                               │
                  decisions D-NNN                                               stf_capture_task_outcome
                  questions OQ-NNN                                     (output + sha256 of every artefact)
                                                                                                         │
                                         stf_verify every session: verified · superseded · absent→blocked
```

- **`tools/stf-mcp/`** is a local MCP server, and the control plane. SQLite runs in memory and is rebuilt from
  `.stf/export/*.json`, a byte-stable export committed with the work. Git history is therefore the audit log.
- **`.claude/skills/`** are the workflows:
  - `stf-spec-lifecycle`: specify, clarify, plan, tasks and analyze;
  - `stf-implement`: TDD, hashed outcomes, checkpoints;
  - `stf-handoff`: sealed next-session prompts;
  - `stf-memory`: cross-session memory;
  - `stf-decide`: decisions, alternatives, evidence;
  - `stf-status`: where we are and what's next.
- **Hooks:**
  - SessionStart injects where the project left off: open questions, spec phases, pending handoff, memories.
  - A PostToolUse hook keeps `tasks.md` and the plane in sync.

### What the server refuses (so the agent can't)

- Marking a task done without an open run, a written outcome, and hashed artefact files.
- Writing a status to a task whose title doesn't match (the wrong-row guard).
- Running phases out of order, or with `[NEEDS CLARIFICATION]` left in the spec.
- Running analyze in the session that wrote the tasks, or passing it below a health score of 80, or with any High finding.
- A checkpoint citing a commit that doesn't exist.
- Picking up a handoff whose prompt was altered, or one marked for a fresh session in the session that wrote it.
- Persisting anything that looks like a key, token, webhook URL or password.

## Getting started

```bash
make setup     # npm ci, build the plane, enable the gitleaks pre-commit hook
claude         # approve the project MCP server "stf" once; the recall block appears at session start
/stf-status
/stf-spec-lifecycle clarify 1
```

Requirements: Node ≥ 20 and Docker (for gitleaks when the binary is missing). Each project's own toolchain
(Terraform ≥ 1.6, Azure CLI, Python ≥ 3.11) is installed by that spec's Setup tasks.
