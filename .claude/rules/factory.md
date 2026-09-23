---
paths: ["tools/stf-mcp/**", ".stf/**", "specs/**"]
---
# Factory (stf plane) rules

- `tools/stf-mcp` layering: `tools.ts` holds argument shapes only; every rule lives in `factory.ts`, so the MCP server,
  the CLI and the tests all exercise the same code. Adding a tool means adding a Factory method, a `tools.ts` entry,
  **and** the name in `tests/contract.test.ts`, plus a test for its refusals.
- Every guard ships with a test that fails when the guard is removed. Mutation-check new guards.
- `.stf/export/` is written only by the server/CLI. Never hand-edit it. A hand edit to a handoff is
  detected as tampering; an edit elsewhere is simply a lie in git history.
- Export must stay byte-stable: sorted keys, stable row order, LF, trailing newline. `make roundtrip` proves it.
- Identity is `seq` (spec) + `localId` (task). IDs like D-/OQ-/ALT-/EV-/MEM-/H- are minted by the server.
- The tasks.md grammar is strict (see the stf-spec-lifecycle skill). If the parser rejects a line, fix the line rather than loosening the parser.
