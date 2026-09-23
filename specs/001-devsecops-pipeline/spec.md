# Automated DevSecOps CI/CD Pipeline with Security Gates

> seq: 001 · slug: devsecops-pipeline · status: draft (specify complete, clarify next) · 2026-09-23

## Overview

A production-style delivery pipeline for a small web API. Every push is built, unit-tested, and scanned
for leaked secrets, insecure code, vulnerable dependencies, and image/IaC misconfiguration. It deploys to
Azure **only** when every gate passes. The point for a reader (a recruiter or hiring manager) is that security is
enforced automatically, it fails closed, and every gate can be demonstrated with a deliberately
vulnerable commit that gets blocked.

The application is a means, not the product: a minimal HTTP API with a database-shaped endpoint, so
SAST has real surface (e.g. an SQL-injection-prone query path that the gate must catch in a demo branch).

## User Scenarios

- **US1: A developer pushes clean code; it ships.** Given a PR with passing tests and no findings above the
  threshold, when it merges to `main`, then the image is built, scanned, pushed and deployed, and the
  public health endpoint serves the new version.
- **US2: A leaked secret is blocked.** Given a commit that adds a fake cloud key, when the pipeline runs, then
  the secret-scan job fails the run, and neither the build nor the deploy happens.
- **US3: Vulnerable code is blocked.** Given a PR that introduces an injection-prone query, when SAST runs, then the PR check
  fails, with the finding annotated on the offending line.
- **US4: A vulnerable dependency or image is blocked.** Given a dependency or base image with a known HIGH/CRITICAL CVE,
  when the dependency and image scans run, then the run fails and the deploy is skipped. Dependabot also proposes the upgrade.
- **US5: The evidence is reviewable.** Given any run, a reviewer can open the scan reports (SARIF in GitHub
  code scanning, plus artefacts) and see which gate passed or failed and why.

## Functional Requirements

- **FR-001** The repo MUST host a minimal web API under `projects/devsecops-pipeline/app` with unit tests.
- **FR-002** CI MUST run on every PR and every push to `main`, via GitHub Actions.
- **FR-003** A secret-scanning gate (Gitleaks, with TruffleHog verified-only as a second opinion) MUST scan the full
  diff history of the PR and fail the run on any finding.
- **FR-004** A SAST gate (Semgrep with OWASP/language rulesets) MUST fail the run on findings at or above the configured
  severity, and upload SARIF to GitHub code scanning.
- **FR-005** A dependency gate (Trivy fs scan) MUST fail on HIGH/CRITICAL CVEs that have a fix available. Dependabot
  MUST be configured for the app's package ecosystem and for GitHub Actions.
- **FR-006** The container image MUST be built once, scanned (Trivy image) before push, and pushed by immutable tag
  (the commit sha) to a registry.
- **FR-007** The IaC for the target environment MUST be scanned (Trivy config / Checkov) and fail on HIGH findings.
- **FR-008** Deployment to Azure MUST depend on (`needs:`) every gate job, and MUST run only on `main`.
- **FR-009** CI MUST authenticate to Azure through GitHub OIDC federated credentials. No long-lived cloud secrets are stored in GitHub.
- **FR-010** A post-deploy smoke test MUST call the health endpoint and verify the deployed version equals the commit sha.
- **FR-011** A `demo/` set of branches or patches MUST reproduce US2–US4, each producing a failing run.

## Non-Functional Requirements

- **NFR-001** Gates fail closed. A scanner crash is a failure, and no security step uses `continue-on-error`.
- **NFR-002** Third-party actions are pinned by commit SHA, and first-party actions by major version at minimum.
- **NFR-003** A full pipeline run on a clean PR completes in ≤ 10 minutes.
- **NFR-004** The idle Azure cost is ≤ $5/month, and a documented one-command teardown exists.

## Success Criteria

- **SC-001** On `main`, a clean commit reaches "deployed" and the smoke test passes (binary, from the run log).
- **SC-002** Each of the 3 demo defects (secret, SAST, CVE) produces a red run with 0 deploy jobs executed (3/3).
- **SC-003** 100% of third-party `uses:` lines are SHA-pinned (checked by a script in CI).
- **SC-004** The GitHub secret store holds 0 Azure credentials (OIDC only). Verified by listing repo secrets.
- **SC-005** The p95 duration of the last 10 clean runs is ≤ 10 min.

## Out of Scope

Multi-environment promotion (dev/stage/prod), DAST, and signed images with policy enforcement are candidates for a follow-up spec.

## Assumptions

- The app language is Python (FastAPI), unless clarify decides otherwise. It is small, has good Semgrep coverage, and Trivy supports it.
- The target is Azure Container Apps (consumption) with a basic Azure Container Registry, or GHCR to save cost.
- The repository is GitHub-hosted (`cjsy2001/secops-task-factory`). CI workflows for this project live under
  `.github/workflows/devsecops-*.yml` with path filters on `projects/devsecops-pipeline/**`.
- GitHub code scanning (SARIF upload) is available for this repo. For a **private** repo it requires GitHub
  Advanced Security. If it is unavailable, reports are uploaded as run artefacts instead.

## Open Questions

- **Q-001** [NEEDS CLARIFICATION: Should SonarQube (SonarCloud) be used in addition to Semgrep for SAST? It is recruiter-visible, but it adds an external service and is free only for public repos.]
- **Q-002** [NEEDS CLARIFICATION: Which registry: ACR (Azure-native, ~$5/mo) or GHCR (free)?]
- **Q-003** [NEEDS CLARIFICATION: Should this project's code eventually live in its own public repo for the portfolio, with this factory repo private?]

## Clarifications

_(filled by clarify)_
