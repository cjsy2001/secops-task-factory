---
name: stf-decide
description: Record decisions, open questions, alternatives and evidence in the stf plane, and keep an append-only reasoning journal per topic. Use when the user says "record this decision", "we decided", "why did we choose X", "log the options", "open question", "capture the trade-offs", or "journal this".
---

# stf-decide

Decisions are the backbone of anti-hallucination. When a later session wonders "why Semgrep and not
SonarQube?", the answer is a `D-NNN` with its rejected `ALT-NNN`s and `EV-NNN` evidence, not a guess.

## Record a decision

1. For each option that was considered: `stf_capture_alternative {seq, option, summary, tradeoffs, verdict}`.
2. Settle it: `stf_capture_decision {seq, title, statement, rationale, resolves: [OQ-…], rejects: [ALT-…], supersedes: [D-…], consequences}`.
3. Back it up: `stf_capture_evidence {seq, claim, source, detail, link, evidences: "D-NNN"}`. The source can be a doc URL, a command and its output, or a `file:line`.
4. If the decision changes a spec or plan that is already past that phase, run `stf_reopen_phase`. Don't edit silently.

## Open questions

`stf_capture_open_question {seq, question, context, specRef}`. They appear at the top of every session's recall until
a decision `resolves` them.

## Journal (`specs/NNN-slug/sessions/<topic>.md`)

For reasoning that spans sessions, keep an append-only journal:

```
---
topic: <topic>
spec: NNN
status: open | sealed
decisions: [D-…]
---
## YYYY-MM-DD
- Considered: … (ALT-…)
- Decided: … (D-…) because …
- Evidence: … (EV-…)
- Still open: … (OQ-…)
```

Never rewrite past entries; add a new dated one. Set `status: sealed` when the topic is closed.

## Lookup

`stf_list_knowledge {kind: decision|question|alternative|evidence, seq?, status?}`.
