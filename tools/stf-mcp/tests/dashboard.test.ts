import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dashboardData, renderDashboard, writeDashboard } from "../src/dashboard.js";
import { factory, specAtAnalyze, tempRepo } from "./helpers.js";

/** The plane data embedded in a rendered page, parsed back. */
function embedded(html: string): Record<string, unknown> {
  const m = html.match(/<script type="application\/json" id="plane">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!);
}

function exportBytes(root: string): Record<string, string> {
  const dir = join(root, ".stf", "export");
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

describe("dashboard", () => {
  it("renders an empty plane", () => {
    const f = factory(tempRepo());
    const html = renderDashboard(dashboardData(f));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    const d = embedded(html);
    expect(d.specs).toEqual([]);
    expect(d.tasks).toEqual([]);
  });

  it("shows each spec's slug and phase, and its tasks", () => {
    const root = tempRepo();
    const f = factory(root);
    const { seq } = specAtAnalyze(root, f);
    const d = embedded(renderDashboard(dashboardData(f))) as { specs: Record<string, unknown>[]; tasks: Record<string, unknown>[] };
    expect(d.specs).toMatchObject([{ seq, slug: "demo", phase: "analyze" }]);
    expect(d.tasks.map((t) => t.local_id)).toEqual(["T001", "T002", "T003"]);
  });

  it("writes the page and nothing under .stf/export", () => {
    const root = tempRepo();
    const f = factory(root);
    specAtAnalyze(root, f);
    const before = exportBytes(root);
    const r = writeDashboard(f);
    expect(r).toEqual({ out: join(root, ".stf", "dashboard.html"), specs: 1, tasks: 3 });
    expect(readFileSync(r.out, "utf8")).toContain('"slug":"demo"');
    expect(exportBytes(root)).toEqual(before);
  });

  it("escapes plane text so it cannot close the data block", () => {
    const f = factory(tempRepo());
    const title = "Evil </script><script>alert(1)</script>";
    f.charterSpec({ slug: "evil", title, summary: "a spec whose title tries to break out" });
    const html = renderDashboard(dashboardData(f));
    expect(html).not.toContain("</script><script>alert(1)");
    expect((embedded(html).specs as { title: string }[])[0]!.title).toBe(title);
  });

  it("leaves sealed handoff prompts out of the page", () => {
    const f = factory(tempRepo());
    f.charterSpec({ slug: "demo", title: "Demo", summary: "demo summary" });
    const prompt = "## Position\n- spec 1 at plan (probe: stf_get_spec 1)\n\n## Next step\n/stf:spec-lifecycle resume 1\n";
    f.handoffEmit({ seq: 1, skill: "stf:spec-lifecycle", invocation: "/stf:spec-lifecycle resume 1", modelTier: "opus", effort: "high", prompt });
    const html = renderDashboard(dashboardData(f));
    const [h] = embedded(html).handoffs as Record<string, unknown>[];
    expect(h).toMatchObject({ local_id: "H-001", invocation: "/stf:spec-lifecycle resume 1" });
    expect(h).not.toHaveProperty("prompt");
    expect(html).not.toContain("probe: stf_get_spec 1");
  });
});
