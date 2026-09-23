import { describe, expect, it } from "vitest";
import { canComplete, canTransition } from "../src/domain/status.js";
import { parseTasks, setMarker } from "../src/domain/tasks-parser.js";
import { TASKS_MD } from "./helpers.js";

describe("status machine", () => {
  it("never lets a caller jump to done, and never revives cancelled", () => {
    for (const from of ["pending", "in_progress", "blocked", "cancelled"] as const) expect(canTransition(from, "done")).toBe(false);
    expect(canTransition("cancelled", "in_progress")).toBe(false);
    expect(canTransition("done", "in_progress")).toBe(true);
    expect(canTransition("done", "pending")).toBe(false);
  });
  it("completes only from open states", () => {
    expect(canComplete("in_progress")).toBe(true);
    expect(canComplete("done")).toBe(false);
    expect(canComplete("cancelled")).toBe(false);
  });
});

describe("tasks.md parser", () => {
  it("extracts ids, phases, flags, requirements, tier and sub-bullets", () => {
    const { tasks, errors } = parseTasks(TASKS_MD);
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.localId)).toEqual(["T001", "T002", "T003"]);
    const [t1, t2, t3] = tasks;
    expect(t1).toMatchObject({ phase: "Phase 1: Setup", title: "Create project skeleton in projects/demo/README.md", requirements: ["FR-001"], modelTier: "haiku", effort: "low" });
    expect(t1!.objective).toBe("a place for the code to live");
    expect(t1!.testsCommand).toBe("test -f projects/demo/README.md");
    expect(t2).toMatchObject({ parallel: true, story: "US1", requirements: ["FR-002", "FR-003"] });
    expect(t3!.phase).toBe("Phase 2: Core");
  });
  it("reports duplicates and rewrites a single marker byte", () => {
    expect(parseTasks("- [ ] T001 a\n- [ ] T001 b\n").errors[0]).toMatch(/duplicate/);
    const { text, found } = setMarker(TASKS_MD, "T002", "X");
    expect(found).toBe(true);
    expect(text).toContain("- [X] T002 [P]");
    expect(text.replace("- [X] T002", "- [ ] T002")).toBe(TASKS_MD);
  });
});
