---
paths: ["projects/**", ".github/**"]
---
# Security rules (this is a security portfolio: the repo itself must pass its own gates)

- **Secrets:** never in code, tests, docs, commits, the plane, or memories. Use GitHub Actions secrets or OIDC,
  Azure Key Vault, and `.env` files (gitignored, with a committed `.env.example` holding placeholders). The gitleaks
  pre-commit hook and the CI job must stay on. Never bypass them with `--no-verify`.
- **Least privilege:** containers run as non-root with a read-only rootfs where possible, dropped capabilities,
  and `no-new-privileges`. Azure identities get scoped roles, never Owner or Contributor at subscription scope.
- **Pin versions:** GitHub Actions pinned to a major tag at minimum (a SHA for third-party actions), base
  images pinned by tag (a digest for release builds), and a Terraform provider lockfile committed.
- **Gates fail closed:** a scanner that errors must fail the job, not skip it. No `continue-on-error` on security steps.
- **Malware sandbox (spec 003):** only benign test artefacts may exist in the repo or be downloaded by
  automation: the EICAR string, and self-written simulators of behaviours (file encryption of a temp dir,
  a reverse shell to the sandbox's own loopback sink). No live malware, no droppers, no C2 frameworks.
  The sandbox runs with the network disabled by default.
- **Honeypot (spec 002):** Cowrie is isolated on its own port and network segment, logs go out one-way, and it has no path to the real service.
- **Audit tool (spec 004):** read-only permissions (Reader + Security Reader + Graph read scopes). It never remediates automatically.
