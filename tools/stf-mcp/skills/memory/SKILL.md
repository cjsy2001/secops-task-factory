---
name: memory
description: Capture durable cross-session knowledge (lessons, constraints, decisions, open questions) in the stf plane, and run a user-invoked checkpoint sweep of the session. Use when the user says "remember this", "save that", "note for next time", "don't forget", "/stf:memory checkpoint", "what do we know about X", or "forget/correct that memory". Memories load automatically at session start via the SessionStart hook.
---

# stf:memory

Memory is what the NEXT session needs and cannot re-derive from the repo. **A false memory is worse
than a missing one**: it gets injected into every future session as fact.

## Kinds

| kind | use for |
|---|---|
| `lesson` | something that surprised us and cost time: a tool quirk, a failure root cause |
| `constraint` | a rule that must keep holding: "no live malware in the repo", "Azure region = uksouth" |
| `decision` | a choice with its reason, when it's not already a `D-NNN` in the plane |
| `open_question` | something that needs an answer from the user or the world |
| `resolved_open_question` | an answer, with who or what settled it |

## capture

- **The user asks** ("remember…"): store it immediately with `source: "user-initiated"`.
- **You notice something:** at the END of your turn, propose it in one line (kind, title, and why).
  Store it only after a yes, with `source: "agent-proposed"` and `evidence` quoting what you saw.
- Shape: `stf_memory_store {kind, title ≤160, body, tags[], evidence?, seq?}`.
  - The body is **self-contained**: someone reading it cold, a month from now, understands it. Name things; don't write bare IDs.
  - Tags are lowercase-hyphenated.
- **Result handling:**
  - `noop`: already known; say nothing more.
  - `near_match`: show the candidate and ask the user to skip, supersede (`stf_memory_supersede`), or store as new (`forceNew: true`).

## Never propose (the noise list)

- Anything already in the code, CLAUDE.md, rules, spec or plan. Anything git history records.
- Task status or progress. The plane already tracks those.
- One-off debugging steps, guesses, or anything you haven't verified.
- Secrets, tokens, webhook URLs, IPs of real hosts. The server refuses obvious ones; you refuse the rest.

## checkpoint (user-invoked only, never uninvited)

1. Sweep the whole session for unsaved durable knowledge.
2. `stf_memory_retrieve {query}` for each candidate, to dedupe.
3. Present ONE numbered batch, each line as `kind · title · evidence`. The user picks numbers.
4. Store what they picked with `source: "checkpoint"`.

## correct / forget

- Wrong: `stf_memory_supersede {ref, …corrected}`.
- No longer true or useful: `stf_memory_archive {ref, reason}`.
