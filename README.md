# secops-task-factory

**stf** is a spec-driven task factory for Claude Code. It keeps AI-assisted development honest: every claim of
"done" must carry verifiable evidence. It ships as a Claude Code plugin that works in any git repo. To use it in
yours, see [docs/using-stf.md](docs/using-stf.md).

This repo holds the plugin (`tools/stf-mcp/`), the factory's own plane, and the specs of a security portfolio
built with it.

## Projects built with stf

Each project gets its own repo and plane once it moves out of this one (D-004).

| Project | Stack | Where | Status |
|---|---|---|---|
| DevSecOps CI/CD pipeline with security gates | GitHub Actions · Gitleaks/TruffleHog · Semgrep · Trivy · Dependabot · OIDC → Azure | [cjsy2001/devsecops-pipeline](https://github.com/cjsy2001/devsecops-pipeline) | own repo; [spec 001 here](specs/001-devsecops-pipeline/spec.md) is history |
| CTF learning path and writeups | picoCTF → HTB Starting Point → TryHackMe · writeups with flags redacted | [cjsy2001/ctf-writeups](https://github.com/cjsy2001/ctf-writeups) | own repo; spec: specify |
| Self-healing hardened server IaC | Terraform · Ansible · Fail2ban/ufw · Docker (non-root) · Cowrie · VMSS auto-repair | [specs/002-hardened-iac](specs/002-hardened-iac/spec.md) | spec: clarify |
| Malware analysis sandbox | Docker isolation · Python · auditd/eBPF · YARA · JSON verdicts (benign samples only) | [specs/003-malware-sandbox](specs/003-malware-sandbox/spec.md) | spec: clarify |
| Zero-trust cloud audit tool | Python · Azure SDK · Microsoft Graph · Event Grid · Functions · webhooks | [specs/004-zero-trust-audit](specs/004-zero-trust-audit/spec.md) | spec: clarify |

_Live status: the [plane viewer](https://cjsy2001.github.io/secops-task-factory/viewer/) reads `main` on every load (any public stf repo: `?repo=owner/name`). Locally: `make status` (JSON) or `make dashboard`. The table above is a snapshot._

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
- **The `stf` plugin** (`tools/stf-mcp`, listed in `.claude-plugin/marketplace.json`) bundles the server, the hooks and the workflows:
  - `/stf:spec-lifecycle`: specify, clarify, plan, tasks and analyze;
  - `/stf:implement`: TDD, hashed outcomes, checkpoints;
  - `/stf:handoff`: sealed next-session prompts;
  - `/stf:memory`: cross-session memory;
  - `/stf:decide`: decisions, alternatives, evidence;
  - `/stf:status`: where we are and what's next.
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
claude plugin install stf@secops-task-factory --scope project   # once per machine
claude         # trust the folder; the recall block appears at session start
/stf:status
/stf:spec-lifecycle clarify 1
```

Requirements: Node ≥ 20 and Docker (for gitleaks when the binary is missing). Each project's own toolchain
(Terraform ≥ 1.6, Azure CLI, Python ≥ 3.11) is installed by that spec's Setup tasks.

## Use stf in your own repo

stf is a Claude Code plugin that works in any git repo:

```bash
claude plugin marketplace add cjsy2001/secops-task-factory
claude plugin install stf@secops-task-factory
```

Then `/stf:new-project` scaffolds a new repo, or `! stf init` adds a plane to an existing one. The full guide, with
a worked example from spec to implementation, is in [docs/using-stf.md](docs/using-stf.md).

## License

[MIT](LICENSE)
