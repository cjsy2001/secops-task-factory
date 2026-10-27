import { describe, expect, it } from "vitest";
import { StfError } from "../src/errors.js";
import { MARKER, diffPlane, readExportAt, renderPlaneDiff } from "../src/plane-diff.js";
import { TASKS_MD, commitAll, factory, tempRepo, write } from "./helpers.js";

/** A committed plane with spec 001 chartered and its tasks imported. */
function base(): { root: string; sha: string } {
  const root = tempRepo();
  const f = factory(root);
  f.charterSpec({ slug: "demo", title: "Demo", summary: "A demo spec for the plane diff." });
  write(root, "specs/001-demo/tasks.md", TASKS_MD);
  f.importTasks({ seq: 1 });
  return { root, sha: commitAll(root, "base") };
}

describe("plane diff", () => {
  it("reports no changes between identical planes", () => {
    const { root, sha } = base();
    const d = diffPlane(readExportAt(root, sha), readExportAt(root));
    expect(d.empty).toBe(true);
    expect(renderPlaneDiff(d)).toContain("No plane changes");
  });

  it("lists a new decision with its links, and the question and alternative it settles", () => {
    const { root } = base();
    const f = factory(root);
    const q = f.captureOpenQuestion({ seq: 1, question: "Which log format?" });
    const alt = f.captureAlternative({ seq: 1, option: "JSON lines", summary: "One object per line.", verdict: "open" });
    const sha = commitAll(root, "question and option");
    f.captureDecision({ seq: 1, title: "Use syslog", statement: "Parse syslog.", rationale: "It is what hosts emit.", resolves: [q.local_id], rejects: [alt.local_id] });
    const md = renderPlaneDiff(diffPlane(readExportAt(root, sha), readExportAt(root)));
    expect(md.startsWith(MARKER)).toBe(true);
    expect(md).toMatch(/\*\*D-001\*\* \(spec 001\) Use syslog/);
    expect(md).toContain(`resolves ${q.local_id}`);
    expect(md).toContain(`rejects ${alt.local_id}`);
    expect(md).toContain(`${q.local_id}: resolution: ∅ → `);
    expect(md).toContain("status: open → resolved");
    expect(md).toContain(`${alt.local_id}: verdict: open → rejected`);
  });

  it("shows a question's status when it is new", () => {
    const { root, sha } = base();
    factory(root).captureOpenQuestion({ seq: 1, question: "Which log format?" });
    expect(renderPlaneDiff(diffPlane(readExportAt(root, sha), readExportAt(root)))).toContain("Which log format? (open)");
  });

  it("shows task status flips and phase moves, not timestamp churn", () => {
    const { root, sha } = base();
    const f = factory(root);
    const task = f.getTask({ seq: 1, localId: "T001" });
    f.setTaskStatus({ seq: 1, localId: "T001", expectTitle: task.title as string, status: "in_progress" });
    f.setTaskStatus({ seq: 1, localId: "T001", expectTitle: task.title as string, status: "blocked", reason: "waiting on a fixture" });
    const md = renderPlaneDiff(diffPlane(readExportAt(root, sha), readExportAt(root)));
    expect(md).toContain("001/T001:");
    expect(md).toContain("status: pending → blocked");
    expect(md).toContain("waiting on a fixture");
    expect(md).not.toContain("updated_at");
  });

  it("flags removed rows, which the plane never does on its own", () => {
    const { root, sha } = base();
    write(root, ".stf/export/tasks.json", "[]\n");
    const d = diffPlane(readExportAt(root, sha), readExportAt(root));
    expect(d.removed).toBeGreaterThan(0);
    expect(renderPlaneDiff(d)).toMatch(/removed/i);
  });

  it("reads an export at a ref, and treats a ref without a plane as empty", () => {
    const root = tempRepo();
    const empty = commitAll(root, "no plane yet");
    const { local_id } = factory(root).captureDecision({ title: "T", statement: "S.", rationale: "R." });
    const d = diffPlane(readExportAt(root, empty), readExportAt(root));
    expect(d.empty).toBe(false);
    expect(renderPlaneDiff(d)).toContain(`**${local_id}**`);
  });

  it("refuses an unknown ref instead of reading it as an empty plane", () => {
    const { root } = base();
    let code = "";
    try {
      readExportAt(root, "0000000");
    } catch (e) {
      if (e instanceof StfError) code = e.code;
    }
    expect(code).toBe("unknown_ref");
  });
});
