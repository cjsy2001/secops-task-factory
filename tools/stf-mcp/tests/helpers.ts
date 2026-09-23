import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Factory } from "../src/factory.js";

export function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "stf-test-"));
  mkdirSync(join(root, ".stf"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  return root;
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

export function commitAll(root: string, msg = "wip"): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", msg, "--allow-empty");
  return git(root, "rev-parse", "HEAD");
}

export function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

let clock = 0;
export function factory(root: string, sessionId = "session-a"): Factory {
  return new Factory(root, { sessionId, now: () => new Date(Date.UTC(2026, 8, 23, 12, 0, clock++)).toISOString().replace(/\.\d{3}Z$/, "Z") });
}

export const TASKS_MD = `# Tasks

## Phase 1: Setup
- [ ] T001 Create project skeleton in projects/demo/README.md (FR-001) {haiku/low}
  - objective: a place for the code to live
  - tests: test -f projects/demo/README.md
- [ ] T002 [P] [US1] Add scanner config in projects/demo/scan.yml (FR-002, FR-003) {sonnet/medium}

## Phase 2: Core
- [ ] T003 [US1] Implement gate script in projects/demo/gate.sh (FR-002) {sonnet/high}
`;

/** A spec driven through specify → clarify → plan → tasks in one session. */
export function specAtAnalyze(root: string, f: Factory): { seq: number; runKey: string } {
  const s = f.charterSpec({ slug: "demo", title: "Demo", summary: "A demo spec for tests" });
  const { runKey } = f.startRun({ seq: s.seq, kind: "lifecycle" });
  write(root, `${s.dir}/spec.md`, "# Demo\n\n## Requirements\n- FR-001\n");
  f.advancePhase({ seq: s.seq, phase: "specify", runKey, artefacts: ["spec.md"] });
  f.advancePhase({ seq: s.seq, phase: "clarify", runKey, artefacts: ["spec.md"] });
  write(root, `${s.dir}/plan.md`, "# Plan\n");
  f.advancePhase({ seq: s.seq, phase: "plan", runKey, artefacts: ["plan.md"] });
  write(root, `${s.dir}/tasks.md`, TASKS_MD);
  f.importTasks({ seq: s.seq });
  f.advancePhase({ seq: s.seq, phase: "tasks", runKey, artefacts: ["tasks.md"] });
  return { seq: s.seq, runKey };
}
