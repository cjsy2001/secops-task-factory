import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dashboardData, renderDashboard } from "../src/dashboard.js";
import { StfError } from "../src/errors.js";
import type { Factory } from "../src/factory.js";
import { renderHub } from "../src/hub.js";
import { renderSpecPage } from "../src/spec-page.js";
import { Store } from "../src/store.js";
import { commitAll, factory, specAtAnalyze, tempRepo, write } from "./helpers.js";

const REPO = "cjsy2001/devsecops-pipeline";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof StfError) return e.code;
    throw e;
  }
  return "no error";
}

/** A spec at analyze with tasks, a decision to cite, a question and an alternative, then moved. */
function movedSpec(): { root: string; f: Factory; seq: number } {
  const root = tempRepo();
  const f = factory(root);
  const { seq, runKey } = specAtAnalyze(root, f);
  f.captureOpenQuestion({ seq, question: "Which registry: ACR or GHCR?", specRef: "Q-002" });
  f.captureAlternative({ seq, option: "GHCR", summary: "free registry", verdict: "open" });
  f.captureDecision({ title: "One repo per project", statement: "Each project moves to its own repo.", rationale: "evidence checks need one git root" });
  f.completeRun({ runKey, outcome: "completed", summary: "lifecycle done for the test" });
  f.moveSpec({ seq, repo: REPO, targetSeq: 1, decision: "D-001", reason: "split into its own public repo" });
  return { root, f, seq };
}

describe("stf_move_spec", () => {
  it("records where the spec went and logs it", () => {
    const { f, seq } = movedSpec();
    const s = f.getSpec({ seq });
    expect(s.moved).toMatchObject({ repo: REPO, seq: 1, decision: "D-001", reason: "split into its own public repo" });
    expect(f.listSpecs()[0]).toMatchObject({ seq, moved: { repo: REPO, seq: 1 } });
    const events = readFileSync(join(f.root, ".stf", "export", "events.jsonl"), "utf8");
    expect(events).toContain(`moved → ${REPO}#1 (D-001): split into its own public repo`);
  });

  it("refuses a bad repo, a bad target seq, an unknown decision, an unknown spec and a second move", () => {
    const root = tempRepo();
    const f = factory(root);
    const s = f.charterSpec({ slug: "demo", title: "Demo", summary: "a demo spec" });
    f.captureDecision({ title: "Move", statement: "Move it.", rationale: "because it is time" });
    const base = { seq: s.seq, repo: REPO, targetSeq: 1, decision: "D-001", reason: "split into its own public repo" };
    expect(code(() => f.moveSpec({ ...base, repo: "not a repo" }))).toBe("bad_repo");
    expect(code(() => f.moveSpec({ ...base, repo: "https://github.com/cjsy2001/x" }))).toBe("bad_repo");
    expect(code(() => f.moveSpec({ ...base, targetSeq: 0 }))).toBe("bad_seq");
    expect(code(() => f.moveSpec({ ...base, decision: "D-999" }))).toBe("unknown_ref");
    expect(code(() => f.moveSpec({ ...base, seq: 42 }))).toBe("unknown_spec");
    f.moveSpec(base);
    expect(code(() => f.moveSpec(base))).toBe("already_moved");
  });

  it("refuses while a run on the spec is open", () => {
    const root = tempRepo();
    const f = factory(root);
    const s = f.charterSpec({ slug: "demo", title: "Demo", summary: "a demo spec" });
    f.captureDecision({ title: "Move", statement: "Move it.", rationale: "because it is time" });
    const { runKey } = f.startRun({ seq: s.seq, kind: "lifecycle" });
    const move = () => f.moveSpec({ seq: s.seq, repo: REPO, targetSeq: 1, decision: "D-001", reason: "split into its own public repo" });
    expect(code(move)).toBe("open_runs");
    f.completeRun({ runKey, outcome: "completed", summary: "closed before the move" });
    expect(code(move)).toBe("no error");
  });

  it("refuses a secret in the reason", () => {
    const root = tempRepo();
    const f = factory(root);
    const s = f.charterSpec({ slug: "demo", title: "Demo", summary: "a demo spec" });
    f.captureDecision({ title: "Move", statement: "Move it.", rationale: "because it is time" });
    const reason = "moved; token ghp_" + "a".repeat(36);
    expect(code(() => f.moveSpec({ seq: s.seq, repo: REPO, targetSeq: 1, decision: "D-001", reason }))).toBe("secret_detected");
  });
});

describe("a moved spec", () => {
  it("refuses every new lifecycle, task, run, capture and handoff write", () => {
    const { root, f, seq } = movedSpec();
    const task = { seq, localId: "T001", expectTitle: "Create project skeleton in projects/demo/README.md" };
    write(root, "projects/demo/README.md", "x\n");
    const sha = commitAll(root);
    const prompt = "## Position\n- moved (probe: stf_get_spec 1)\n\n## Next step\n/stf:status 1\n";
    const writes: [string, () => unknown][] = [
      ["start_run", () => f.startRun({ seq, kind: "implement" })],
      ["advance_phase", () => f.advancePhase({ seq, phase: "analyze", runKey: "r", artefacts: [] })],
      ["reopen_phase", () => f.reopenPhase({ seq, phase: "plan", reason: "amend the plan after review", runKey: "r" })],
      ["import_tasks", () => f.importTasks({ seq })],
      ["set_task_status", () => f.setTaskStatus({ ...task, status: "in_progress" })],
      ["set_task_model", () => f.setTaskModel({ seq, localId: "T001", modelTier: "opus", effort: "high" })],
      ["capture_task_outcome", () => f.captureTaskOutcome({ ...task, runKey: "r", output: "created the readme and checked it exists", artefacts: ["projects/demo/README.md"] })],
      ["checkpoint", () => f.checkpoint({ seq, runKey: "r", phase: "Phase 1: Setup", testsPassed: true, commitSha: sha })],
      ["append_event", () => f.appendEvent({ seq, kind: "note", summary: "a new note" })],
      ["capture_decision", () => f.captureDecision({ seq, title: "New", statement: "A new decision.", rationale: "it should go to the new repo" })],
      ["capture_open_question", () => f.captureOpenQuestion({ seq, question: "A new question?" })],
      ["capture_alternative", () => f.captureAlternative({ seq, option: "ACR", summary: "Azure registry", verdict: "open" })],
      ["capture_evidence", () => f.captureEvidence({ seq, claim: "A claim", source: "https://example.com", evidences: "D-001" })],
      ["handoff_emit", () => f.handoffEmit({ seq, skill: "stf:status", invocation: "/stf:status 1", modelTier: "sonnet", effort: "medium", prompt })],
    ];
    for (const [name, fn] of writes) expect([name, code(fn)]).toEqual([name, "spec_moved"]);
  });

  it("names the repo it moved to in the refusal", () => {
    const { f, seq } = movedSpec();
    expect(() => f.startRun({ seq, kind: "lifecycle" })).toThrow(/moved to cjsy2001\/devsecops-pipeline \(spec 001 there, per D-001\)/);
  });

  it("keeps its history readable and unchanged", () => {
    const { f, seq } = movedSpec();
    expect(f.listKnowledge({ kind: "question", seq }).map((q: { question: string }) => q.question)).toEqual(["Which registry: ACR or GHCR?"]);
    expect(f.listKnowledge({ kind: "alternative", seq })).toHaveLength(1);
    expect(f.listTasks({ seq }).map((t: { localId: string }) => t.localId)).toEqual(["T001", "T002", "T003"]);
    expect(f.getSpec({ seq }).phase).toBe("analyze");
  });

  it("still allows project-wide writes that name no spec", () => {
    const { f } = movedSpec();
    expect(code(() => f.startRun({ kind: "other" }))).toBe("no error");
    expect(code(() => f.captureOpenQuestion({ question: "A factory-wide question?" }))).toBe("no error");
  });

  it("shows as moved in status and recall, without its open questions or next task", () => {
    const { f, seq } = movedSpec();
    const s = f.status().specs[0];
    expect(s).toMatchObject({ seq, moved: { repo: REPO, seq: 1 }, openQuestions: [], nextTask: null, gated: false });
    const recall = f.recall();
    expect(recall).toContain(`- 001 demo: moved → ${REPO}#1 (history only here)`);
    expect(recall).not.toContain("Which registry");
  });

  it("is skipped by verify, so its tasks are never flipped to blocked here", () => {
    const { f, seq } = movedSpec();
    const r = f.verify({ apply: true });
    expect(r.clean).toBe(true);
    expect(r.specs[0]).toMatchObject({ seq, moved: { repo: REPO, seq: 1 }, problems: [] });
  });

  it("shows moved → repo on the dashboard, the hub and its spec page", () => {
    const { f, seq } = movedSpec();
    const data = dashboardData(f);
    expect(data.specs[0]).toMatchObject({ moved: { repo: REPO, seq: 1 } });
    expect(renderDashboard(data)).toContain("s.moved.repo");
    const hub = renderHub(f, {});
    expect(hub).toContain(`moved → <a href="https://github.com/${REPO}"`);
    expect(hub).toContain('<span class="n">0</span><span class="l">open questions</span>');
    expect(renderSpecPage(f, seq)).toContain(`moved → <b><a href="https://github.com/${REPO}"`);
  });

  it("round-trips byte-identically, and an export without the field loads as not moved", () => {
    const { root, f } = movedSpec();
    const file = join(root, ".stf", "export", "specs.json");
    const before = readFileSync(file, "utf8");
    expect(new Store(root).render().get("specs.json")).toBe(before);
    expect(before).toContain('"moved": {');
    // a plane exported before the column existed has no "moved" key at all
    const legacy = JSON.stringify(JSON.parse(before).map(({ moved: _m, ...s }: Record<string, unknown>) => s), null, 2) + "\n";
    write(root, ".stf/export/specs.json", legacy);
    expect(factory(root).getSpec({ seq: 1 }).moved).toBeNull();
    expect(f).toBeDefined();
  });
});
