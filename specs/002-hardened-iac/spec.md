# Self-Healing, Hardened Server Infrastructure as Code

> seq: 002 · slug: hardened-iac · status: draft (specify complete, clarify next) · 2026-09-23

## Overview

Code alone (no portal clicks) provisions, hardens and protects a small multi-node game/web server on Azure:
- **Terraform** creates the network, firewalls and VMs.
- **Ansible** hardens the OS at boot.
- The server runs in a **non-root Docker** container.
- A **Cowrie honeypot** captures and logs brute-force attempts.
- Instances that fail health checks are **repaired or replaced automatically**.

It turns a Minecraft-server hobby into a demonstration of IaC and Linux hardening. Everything can be
destroyed and rebuilt, and a scripted attack simulation proves the controls work.

## User Scenarios

- **US1: One command, whole environment.** Given an empty resource group, when `make apply` runs,
  then the network, VMs and server come up, and a Minecraft client (or a TCP probe) can connect to the game port.
- **US2: The box is hardened.** Given a provisioned node, when an automated compliance check runs, then SSH is
  key-only (no password or root login), the host firewall allows only the declared ports, and Fail2ban is active.
- **US3: Brute force is punished.** Given repeated failed SSH logins from one IP, when the threshold is crossed,
  then that IP is banned for the configured time, and the ban is logged.
- **US4: Attackers are recorded.** Given an attacker who connects to the exposed decoy SSH port, their session is
  captured by Cowrie (credentials tried, commands typed) and shipped to a log destination the honeypot cannot modify.
- **US5: It heals itself.** Given a node whose game container or health endpoint dies, the platform
  detects it and restores service within the SLO, with no human action.

## Functional Requirements

- **FR-001** Terraform (≥1.6, or OpenTofu) MUST define: a resource group, a VNet with separate subnets for the
  service and the honeypot, NSGs with deny-by-default rules, and a VM Scale Set (≥2 instances) behind a load
  balancer. Remote state lives in Azure Storage with locking.
- **FR-002** Management SSH MUST NOT be exposed to `0.0.0.0/0`. It uses a restricted source IP or Azure Bastion / just-in-time access.
- **FR-003** Ansible MUST configure each node:
  - sshd: `PasswordAuthentication no`, `PermitRootLogin no`, key-only, and a non-default admin user;
  - automatic security updates;
  - ufw default deny with an explicit allow list;
  - Fail2ban with an sshd jail.
- **FR-004** The game server MUST run as a Docker container as a non-root user, with dropped capabilities,
  `no-new-privileges`, and a named volume for world data.
- **FR-005** Cowrie MUST run in its own container on the honeypot subnet or port, with no route to the game service. Its logs MUST ship to Log Analytics (or another append-only sink).
- **FR-006** Self-healing MUST use VMSS automatic instance repairs driven by the Application Health extension
  (an HTTP or TCP probe), plus Docker `restart: unless-stopped` for container-level faults.
- **FR-007** A compliance check (e.g. `lynis`/InSpec or a scripted assertion suite) MUST verify FR-003 and FR-004 on every node, and run in CI against a test instance.
- **FR-008** An attack-simulation script MUST reproduce US3 (a Hydra-style failed-login burst from a test runner) and US4, and assert the expected outcome.
- **FR-009** CI MUST run `terraform fmt -check`, `validate`, a `tflint`/Trivy config scan and `ansible-lint` on every PR.

## Non-Functional Requirements

- **NFR-001** Idle cost is ≤ $15/month, running B-series sizes. `make destroy` removes everything.
- **NFR-002** A rebuild from nothing takes ≤ 20 minutes.
- **NFR-003** No secret appears in Terraform variables committed to git. Admin keys come from the operator's machine or Key Vault.

## Success Criteria

- **SC-001** `make apply` from an empty subscription scope reaches a connectable game port (binary).
- **SC-002** The compliance suite passes on 100% of nodes.
- **SC-003** The attack simulation causes a ban within ≤ 60 s of crossing the threshold, and Cowrie records ≥1 session.
- **SC-004** A killed container or node is back to healthy within ≤ 10 minutes, with no manual step (measured).
- **SC-005** The IaC scan in CI reports 0 HIGH findings.

## Out of Scope

Kubernetes, multi-region, and a custom Minecraft plugin ecosystem.

## Assumptions

- Ubuntu 24.04 LTS images.
- Ansible runs via cloud-init at boot (ansible-pull from this repo), so scaled-out or repaired instances self-configure.
- The Minecraft server image is `itzg/minecraft-server`, pinned by digest, with EULA acceptance via env.
- Cowrie is the official `cowrie/cowrie` image.

## Open Questions

- **Q-001** [NEEDS CLARIFICATION: Should the workload be Minecraft (Java edition, heavier RAM) or a lightweight web server, given the ≤ $15/month budget?]
- **Q-002** [NEEDS CLARIFICATION: Should management access use Azure Bastion (Basic is well over budget; the Developer SKU may be free, but region support needs checking), a source-IP-restricted NSG rule, or Tailscale?]

## Clarifications

_(filled by clarify)_
