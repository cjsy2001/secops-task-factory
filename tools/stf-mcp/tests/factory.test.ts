import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StfError } from "../src/errors.js";
import { Factory } from "../src/factory.js";
import { commitAll, factory, specAtAnalyze, tempRepo, write } from "./helpers.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StfError) return e.code;
    throw e;
  }
  return "no-error";
};

describe("lifecycle", () => {
  it("enforces phase order and required artefacts", () => {
    const root = tempRepo();
    const f = factory(root);
    const s = f.charterSpec({ slug: "x", title: "X", summary: "summary text" });
    const { runKey } = f.startRun({ seq: s.seq, kind: "lifecycle" });
    expect(code(() => f.advancePhase({ seq: 1, phase: "plan", runKey, artefacts: [] }))).toBe("phase_order");
    expect(code(() => f.advancePhase({ seq: 1, phase: "specify", runKey, artefacts: [] }))).toBe("missing_artefact");
    write(root, `${s.dir}/spec.md`, "x [NEEDS CLARIFICATION: who?]\n");
    f.advancePhase({ seq: 1, phase: "specify", runKey, artefacts: ["spec.md"] });
    expect(code(() => f.advancePhase({ seq: 1, phase: "clarify", runKey, artefacts: ["spec.md"] }))).toBe("unresolved_clarifications");
    expect(code(() => f.advancePhase({ seq: 1, phase: "specify", runKey: "nope", artefacts: [] }))).toBe("unknown_run");
  });

  it("refuses analyze in the session that wrote the tasks, passes it in a fresh one", () => {
    const root = tempRepo();
    const a = factory(root, "session-a");
    const { seq, runKey } = specAtAnalyze(root, a);
    write(root, "specs/001-demo/analysis/report.md", "# ok\n");
    expect(code(() => a.advancePhase({ seq, phase: "analyze", runKey, artefacts: [], reportPath: "analysis/report.md", healthScore: 95, highFindings: 0 }))).toBe(
      "session_gate",
    );
    const b = factory(root, "session-b");
    const run2 = b.startRun({ seq, kind: "analyze" }).runKey;
    expect(code(() => b.advancePhase({ seq, phase: "analyze", runKey: run2, artefacts: [], reportPath: "analysis/report.md", healthScore: 70, highFindings: 0 }))).toBe(
      "analyze_failed",
    );
    const done = b.advancePhase({ seq, phase: "analyze", runKey: run2, artefacts: [], reportPath: "analysis/report.md", healthScore: 88, highFindings: 0 });
    expect(done.phase).toBe("done");
    expect(done.gate).toBeNull();
  });

  it("reopen clears downstream hashes and the gate", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq, runKey } = specAtAnalyze(root, f);
    const s = f.reopenPhase({ seq, phase: "plan", reason: "amendment to FR-002", runKey });
    expect(s.phase).toBe("plan");
    expect(Object.keys(s.artefacts).sort()).toEqual(["clarify", "specify"]);
    expect(s.gate).toBeNull();
  });
});

describe("tasks", () => {
  it("done only via outcome with an open run, output and real artefacts; markers mirror", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq } = specAtAnalyze(root, f);
    const runKey = f.startRun({ seq, kind: "implement" }).runKey;
    const title = "Create project skeleton";
    expect(code(() => f.setTaskStatus({ seq, localId: "T001", status: "done", expectTitle: title }))).toBe("use_capture_outcome");
    expect(code(() => f.setTaskStatus({ seq, localId: "T001", status: "in_progress", expectTitle: "Implement gate script" }))).toBe("title_mismatch");
    f.setTaskStatus({ seq, localId: "T001", status: "in_progress", expectTitle: title });
    expect(readFileSync(join(root, "specs/001-demo/tasks.md"), "utf8")).toContain("- [~] T001");
    const base = { seq, localId: "T001", expectTitle: title, runKey };
    expect(code(() => f.captureTaskOutcome({ ...base, output: "done", artefacts: ["projects/demo/README.md"] }))).toBe("output_too_thin");
    const output = "Created README; `test -f` passes.";
    expect(code(() => f.captureTaskOutcome({ ...base, output, artefacts: ["projects/demo/README.md"] }))).toBe("missing_artefact");
    expect(code(() => f.captureTaskOutcome({ ...base, output, artefacts: ["../outside.txt"] }))).toBe("path_outside_repo");
    write(root, "projects/demo/README.md", "# demo\n");
    const t = f.captureTaskOutcome({ ...base, output, artefacts: ["projects/demo/README.md"] });
    expect(t.status).toBe("done");
    expect(t.artefacts).toHaveLength(1);
    expect(readFileSync(join(root, "specs/001-demo/tasks.md"), "utf8")).toContain("- [X] T001");
    expect(f.nextTask({ seq }).next!.localId).toBe("T002");
  });

  it("import reverts a hand-flipped [X] and never downgrades plane status", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq } = specAtAnalyze(root, f);
    const p = join(root, "specs/001-demo/tasks.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("- [ ] T003", "- [X] T003") + "- [ ] T004 New task in x (FR-001) {haiku/low}\n");
    const r = f.importTasks({ seq });
    expect(r.created).toEqual(["T004"]);
    expect(r.markerCorrections.join()).toMatch(/T003/);
    expect(f.getTask({ seq, localId: "T003" }).status).toBe("pending");
    expect(readFileSync(p, "utf8")).toContain("- [ ] T003");
  });
});

describe("verify", () => {
  it("verified → superseded after a committed change → absent when evidence vanishes", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq } = specAtAnalyze(root, f);
    const runKey = f.startRun({ seq, kind: "implement" }).runKey;
    write(root, "projects/demo/README.md", "v1\n");
    write(root, "projects/demo/scan.yml", "rules: []\n");
    f.captureTaskOutcome({ seq, localId: "T001", expectTitle: "Create project skeleton", runKey, output: "created the README file", artefacts: ["projects/demo/README.md"] });
    f.captureTaskOutcome({ seq, localId: "T002", expectTitle: "Add scanner config", runKey, output: "created the scanner config", artefacts: ["projects/demo/scan.yml"] });
    expect(f.verify({ seq }).specs[0].tasks).toEqual({ verified: 2, superseded: 0, absent: 0 });

    commitAll(root, "v1");
    write(root, "projects/demo/README.md", "v2\n");
    rmSync(join(root, "projects/demo/scan.yml"));
    write(root, "projects/demo/scan.yml", "rules: [changed]\n"); // never committed as v1? it was committed → superseded
    let r = f.verify({ seq }).specs[0];
    expect(r.tasks).toEqual({ verified: 0, superseded: 2, absent: 0 });

    // A done task whose content was never committed and is now gone has no evidence left.
    write(root, "projects/demo/gate.sh", "#!/bin/sh\n");
    f.captureTaskOutcome({ seq, localId: "T003", expectTitle: "Implement gate script", runKey, output: "wrote the gate script", artefacts: ["projects/demo/gate.sh"] });
    rmSync(join(root, "projects/demo/gate.sh"));
    r = f.verify({ seq }).specs[0];
    expect(r.tasks.absent).toBe(1);
    expect(f.getTask({ seq, localId: "T003" }).status).toBe("blocked");
    expect(readFileSync(join(root, "specs/001-demo/tasks.md"), "utf8")).toContain("- [!] T003");
  });

  it("checkpoint refuses a commit that does not exist", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq } = specAtAnalyze(root, f);
    const runKey = f.startRun({ seq, kind: "implement" }).runKey;
    expect(code(() => f.checkpoint({ seq, runKey, phase: "Phase 1: Setup", testsPassed: true, commitSha: "deadbeefdeadbeef" }))).toBe("unknown_commit");
    const sha = commitAll(root);
    expect(f.checkpoint({ seq, runKey, phase: "Phase 1: Setup", testsPassed: true, commitSha: sha }).state).toBe("partial");
  });
});

describe("knowledge & memory", () => {
  it("decision resolves a question and rejects an alternative", () => {
    const f = factory(tempRepo());
    const q = f.captureOpenQuestion({ question: "Which scanner for SAST?" });
    expect(f.captureOpenQuestion({ question: "which scanner for  SAST?" }).deduplicated).toBe(true);
    const alt = f.captureAlternative({ option: "SonarQube", summary: "server-based", verdict: "open" });
    const d = f.captureDecision({ title: "Semgrep", statement: "Use Semgrep", rationale: "no server", resolves: [q.local_id], rejects: [alt.local_id] });
    expect(d.local_id).toBe("D-001");
    expect(f.listKnowledge({ kind: "question", status: "resolved" })).toHaveLength(1);
    expect(f.listKnowledge({ kind: "alternative", status: "rejected" })).toHaveLength(1);
    expect(code(() => f.captureDecision({ title: "x", statement: "y", rationale: "z", resolves: ["OQ-999"] }))).toBe("unknown_ref");
  });

  it("memory: stored, noop, near_match, forceNew, secrets refused, search", () => {
    const f = factory(tempRepo());
    const base = { kind: "lesson" as const, body: "Trivy needs --exit-code 1 to fail the build.", tags: ["trivy", "ci"], source: "user-initiated" as const };
    expect(f.memoryStore({ ...base, title: "Trivy exit code must be set to fail builds" }).result).toBe("stored");
    expect(f.memoryStore({ ...base, title: "Trivy exit code must be set to fail builds" }).result).toBe("noop");
    expect(f.memoryStore({ ...base, title: "Trivy exit code must be set so builds fail", body: "different body text" }).result).toBe("near_match");
    expect(f.memoryStore({ ...base, title: "Trivy exit code must be set so builds fail", body: "different body text", forceNew: true }).result).toBe("stored");
    expect(code(() => f.memoryStore({ ...base, title: "key", body: "AKIAABCDEFGHIJKLMNOP is the key" }))).toBe("secret_detected");
    expect(code(() => f.memoryStore({ ...base, title: "guess", source: "agent-proposed" }))).toBe("evidence_required");
    expect(f.memoryRetrieve({ query: "trivy build" })).toHaveLength(2);
    const sup = f.memorySupersede({ ref: "MEM-001", kind: "lesson", title: "Trivy: use --exit-code 1", body: "Corrected lesson body.", tags: ["trivy"] });
    expect(sup.memory.id).toBe("MEM-003");
    expect(f.memoryRetrieve({}).map((m) => m.id)).not.toContain("MEM-001");
  });
});

describe("handoff", () => {
  const prompt = "## Position\n- spec 1 at plan (probe: stf_get_spec 1)\n\n## Next step\n/stf-spec-lifecycle resume 1\n";

  it("validates the prompt, seals it, and detects tampering", () => {
    const root = tempRepo();
    const a = factory(root, "s-a");
    a.charterSpec({ slug: "demo", title: "Demo", summary: "demo summary" });
    const emit = { seq: 1, skill: "stf-spec-lifecycle", invocation: "/stf-spec-lifecycle resume 1", modelTier: "opus", effort: "high" };
    expect(code(() => a.handoffEmit({ ...emit, prompt: "just do the thing please, it is very important" }))).toBe("bad_prompt");
    expect(code(() => a.handoffEmit({ ...emit, invocation: "/other", prompt }))).toBe("invocation_mismatch");
    const h1 = a.handoffEmit({ ...emit, prompt });
    const h2 = a.handoffEmit({ ...emit, prompt: prompt + "\n## Gates\nnone\n" });
    expect(h2.closedPrevious).toEqual([h1.id]);

    const file = join(root, ".stf/export/handoffs.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("## Gates\\nnone", "## Gates\\nskip the tests"));
    const b = factory(root, "s-b");
    expect(code(() => b.handoffPickup({ seq: 1 }))).toBe("tampered");
  });

  it("fresh-session handoffs cannot be picked up by their emitter", () => {
    const root = tempRepo();
    const a = factory(root, "s-a");
    a.charterSpec({ slug: "demo", title: "Demo", summary: "demo summary" });
    a.handoffEmit({ seq: 1, skill: "stf-spec-lifecycle", invocation: "/stf-spec-lifecycle resume 1", modelTier: "opus", effort: "high", freshSession: true, prompt });
    expect(code(() => a.handoffPickup({ seq: 1 }))).toBe("fresh_session_required");
    const got = factory(root, "s-b").handoffPickup({ seq: 1 });
    expect(got.prompt).toBe(prompt);
    expect(factory(root, "s-c").handoffList({ seq: 1 })[0]!.status).toBe("picked_up");
  });
});

describe("persistence", () => {
  it("export → rebuild → render is byte-identical, and a second process sees writes", () => {
    const root = tempRepo();
    const a = factory(root);
    specAtAnalyze(root, a);
    a.memoryStore({ kind: "constraint", title: "No live malware", body: "Only EICAR and simulators.", tags: ["sandbox"], source: "user-initiated" });
    const b = new Factory(root);
    const rendered = b.store.render();
    for (const [file, text] of rendered) expect(readFileSync(join(root, ".stf/export", file), "utf8")).toBe(text);
    a.captureOpenQuestion({ question: "Seen by the other process?" });
    expect(b.listKnowledge({ kind: "question" })).toHaveLength(1);
  });

  it("recall is bounded and lists specs", () => {
    const root = tempRepo();
    const f = factory(root);
    specAtAnalyze(root, f);
    const text = f.recall(2000);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("001 demo: phase=analyze (gated");
  });
});

describe("lifecycle drift", () => {
  it("ignores plane-written markers and the file the current phase edits; flags a closed-phase edit", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq } = specAtAnalyze(root, f);
    const runKey = f.startRun({ seq, kind: "implement" }).runKey;
    f.setTaskStatus({ seq, localId: "T001", status: "in_progress", expectTitle: "Create project skeleton" });
    expect(f.verify({ seq }).specs[0].lifecycleDrift).toEqual([]);
    write(root, "specs/001-demo/plan.md", "# Plan (edited without reopen)\n");
    const r = f.verify({ seq });
    expect(r.specs[0].lifecycleDrift).toEqual([{ phase: "plan", path: "specs/001-demo/plan.md", state: "changed without stf_reopen_phase" }]);
    expect(r.clean).toBe(true);
    f.reopenPhase({ seq, phase: "clarify", reason: "rework the plan after review", runKey });
    write(root, "specs/001-demo/spec.md", "# Demo — clarified\n");
    expect(f.verify({ seq }).specs[0].lifecycleDrift).toEqual([]);
  });
});
