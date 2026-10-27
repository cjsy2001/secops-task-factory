import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StfError } from "../src/errors.js";
import { diffPlane, readExportAt, renderPlaneDiff } from "../src/plane-diff.js";
import { renderSpecPage } from "../src/spec-page.js";
import { commitAll, factory, tempRepo } from "./helpers.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof StfError) return e.code;
    throw e;
  }
  return "no error";
}

/** A plane with one accepted decision and one alternative that a later decision corrects. */
function planeWithOriginal() {
  const root = tempRepo();
  const f = factory(root);
  f.charterSpec({ slug: "demo", title: "Demo", summary: "A demo spec for corrections." });
  const alt = f.captureAlternative({ seq: 1, option: "Copy commit abc1234", summary: "Start from abc1234.", verdict: "open" });
  const orig = f.captureDecision({ seq: 1, title: "Scaffold from abc1234", statement: "The scaffold matches abc1234.", rationale: "It is the first commit.", rejects: [alt.local_id] });
  return { root, f, orig: orig.local_id as string, alt: alt.local_id as string };
}

describe("decision corrects", () => {
  it("records what a decision corrects and leaves the corrected records as they were", () => {
    const { f, orig, alt } = planeWithOriginal();
    const fix = f.captureDecision({ seq: 1, title: "abc1234 is now def5678", statement: "History was rewritten.", rationale: "Author email change.", corrects: [orig, alt] });
    expect(JSON.parse(fix.corrects as string)).toEqual([orig, alt]);
    const d = f.store.read((db) => db.prepare("SELECT status FROM decision WHERE local_id = ?").get(orig)) as { status: string };
    const a = f.store.read((db) => db.prepare("SELECT verdict FROM alternative WHERE local_id = ?").get(alt)) as { verdict: string };
    expect(d.status).toBe("accepted");
    expect(a.verdict).toBe("rejected");
  });

  it("refuses an unknown id, an id that is not a decision or an alternative, and a decision correcting itself", () => {
    const { f, orig } = planeWithOriginal();
    const q = f.captureOpenQuestion({ seq: 1, question: "Which commit?" });
    const base = { seq: 1, title: "Fix", statement: "S.", rationale: "R." };
    expect(code(() => f.captureDecision({ ...base, corrects: ["D-999"] }))).toBe("unknown_ref");
    expect(code(() => f.captureDecision({ ...base, corrects: [q.local_id as string] }))).toBe("unknown_ref");
    expect(code(() => f.captureDecision({ ...base, localId: orig, corrects: [orig] }))).toBe("self_ref");
  });

  it("can be added to an existing decision later", () => {
    const { f, orig } = planeWithOriginal();
    const later = f.captureDecision({ seq: 1, title: "Note", statement: "S.", rationale: "R." });
    const updated = f.captureDecision({ localId: later.local_id as string, seq: 1, title: "Note", statement: "S.", rationale: "R.", corrects: [orig] });
    expect(JSON.parse(updated.corrects as string)).toEqual([orig]);
  });

  it("shows up in the plane diff, the event feed and the spec page, from both ends", () => {
    const { root, f, orig } = planeWithOriginal();
    const sha = commitAll(root, "before the correction");
    const fix = f.captureDecision({ seq: 1, title: "abc1234 is now def5678", statement: "History was rewritten.", rationale: "Author email change.", corrects: [orig] });
    const md = renderPlaneDiff(diffPlane(readExportAt(root, sha), readExportAt(root)));
    expect(md).toContain(`corrects ${orig}`);
    const events = readFileSync(join(root, ".stf/export/events.jsonl"), "utf8");
    expect(events).toContain(`(corrects ${orig})`);
    const html = renderSpecPage(f, 1);
    expect(html).toContain(`<dt>Corrects</dt><dd><a href="#${orig.toLowerCase()}">${orig}</a></dd>`);
    expect(html).toContain(`<dt>Corrected by</dt><dd><a href="#${String(fix.local_id).toLowerCase()}">${fix.local_id}</a></dd>`);
  });

  it("loads an export written before corrects existed, and the diff doesn't call the new empty field a change", () => {
    const { root, f } = planeWithOriginal();
    const p = join(root, ".stf/export/decisions.json");
    const rows = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>[];
    for (const r of rows) delete r.corrects;
    writeFileSync(p, JSON.stringify(rows, null, 2) + "\n");
    const sha = commitAll(root, "old export");
    f.store.reload();
    f.captureAlternative({ seq: 1, option: "Another", summary: "A later write re-exports every decision.", verdict: "open" });
    expect(JSON.parse(readFileSync(p, "utf8"))[0].corrects).toEqual([]);
    const d = diffPlane(readExportAt(root, sha), readExportAt(root));
    expect(d.tables.find((t) => t.file === "decisions.json")).toBeUndefined();
  });
});

describe("an export from a newer stf", () => {
  it("is refused with a clear message instead of a raw SQL error, and nothing is rewritten", () => {
    const { root, f } = planeWithOriginal();
    const p = join(root, ".stf/export/decisions.json");
    const rows = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>[];
    rows[0]!.future_field = ["x"];
    const text = JSON.stringify(rows, null, 2) + "\n";
    writeFileSync(p, text);
    expect(code(() => f.store.reload())).toBe("newer_plane");
    expect(readFileSync(p, "utf8")).toBe(text);
  });
});
