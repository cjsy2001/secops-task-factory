# Cloud Zero-Trust Secrets & Network Audit Tool

> seq: 004 · slug: zero-trust-audit · status: draft (specify complete, clarify next) · 2026-09-23

## Overview

A Python tool that continuously audits an Azure environment for exposure and identity misconfiguration.
It runs both as a CLI and as a serverless function that reacts to new resources, and sends alerts to
Discord or Slack. It shows cloud-governance thinking: zero trust means verifying configuration continuously, not trusting that it is correct.

## User Scenarios

- **US1: On-demand audit.** Given read access to a subscription, when the operator runs `zt-audit scan`, then a
  report lists every finding, with its resource ID, rule ID, severity, evidence and a remediation hint (JSON and a
  human-readable table).
- **US2: Exposure detection.** Given a storage account with public blob access, or an NSG allowing 22/3389 from
  `0.0.0.0/0` or `Internet`, then each is reported with severity HIGH.
- **US3: Identity hygiene.** Given users without MFA registered, guest accounts with privileged roles, or
  service principals holding Owner/Contributor at subscription scope, then each is reported.
- **US4: Real-time alert.** Given someone creates a non-compliant resource, then within minutes a webhook alert
  names the resource, the rule, and who created it.
- **US5: Demo safely.** Given the included Terraform "bad resources" fixture, then applying it triggers the expected alerts, and destroying it cleans up.

## Functional Requirements

- **FR-001** Scanning MUST use the official Azure SDK for Python (`azure-identity`, `azure-mgmt-*`) and Microsoft Graph, authenticating with `DefaultAzureCredential` (managed identity in the cloud, the CLI locally).
- **FR-002** The rules MUST be modular (one module per rule, with ID, title, severity, check and remediation), and MUST include at least:
  - storage: public blob access; shared-key access; minimum TLS below 1.2;
  - NSG: 22/3389/any-port inbound from any;
  - Key Vault: purge protection off; public network access on;
  - SQL/PostgreSQL servers with public access and a `0.0.0.0` firewall rule;
  - identity: users without MFA registration; privileged role assignments to guests; SPs with Owner/Contributor at subscription scope; SP credentials with no expiry or long expiry.
- **FR-003** The output MUST be JSON (with a schema) and a console table. The exit code is non-zero when findings at or above `--fail-on` exist, so the tool can gate CI.
- **FR-004** The event-driven mode MUST subscribe to the subscription's resource write events (Event Grid system topic:
  `Microsoft.Resources.ResourceWriteSuccess`) and evaluate the affected resource with an Azure Function (Python, consumption plan).
- **FR-005** Alerts MUST go to Discord and/or Slack webhooks. The webhook URLs come from Key Vault or app settings (never from code),
  with dedup and suppression so a single resource alerts once per rule per window.
- **FR-006** The tool MUST be strictly read-only. Its identity has only Reader, Security Reader and the required Graph read permissions.
- **FR-007** A Terraform fixture MUST create deliberately non-compliant resources in an isolated resource group, for demos and integration tests.
- **FR-008** Unit tests MUST cover every rule with recorded or fake SDK responses, so no cloud access is needed for `pytest`.

## Non-Functional Requirements

- **NFR-001** A full scan of a small subscription (≤ 200 resources) finishes in ≤ 2 min.
- **NFR-002** A throttled or failing API call is reported as an `error` finding, never silently skipped (fail visible).
- **NFR-003** The idle cost of the event-driven deployment is ≈ $0 (consumption plan + Event Grid free tier).

## Success Criteria

- **SC-001** Every rule in FR-002 has a unit test for both compliant and non-compliant cases (100%).
- **SC-002** Applying the bad-resources fixture produces an alert for each planted issue (≥ 95% recall) within ≤ 5 min.
- **SC-003** Running against a clean resource group produces 0 false-positive HIGH findings.
- **SC-004** The deployed identity has no role above Reader or Security Reader (verified by a role-assignment listing).

## Out of Scope

Auto-remediation, multi-cloud (AWS/GCP), and CSPM dashboards.

## Assumptions

- There is one Azure subscription the operator controls. MFA status comes from the Graph
  `reports/authenticationMethods/userRegistrationDetails` endpoint, which requires an Entra ID P1/P2 licence. Without one,
  that rule degrades to "unknown", with an explanation.
- Python ≥ 3.11. The CLI is packaged with `uv`/`pyproject.toml`.

## Open Questions

- **Q-001** [NEEDS CLARIFICATION: Does your Entra tenant have a P1/P2 licence (for MFA registration data), or should the MFA rule be designed around the free-tier limits?]
- **Q-002** [NEEDS CLARIFICATION: Discord, Slack, or both, as the primary alert channel?]

## Clarifications

_(filled by clarify)_
