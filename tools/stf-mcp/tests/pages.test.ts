import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dashboardData, renderDashboard } from "../src/dashboard.js";
import { renderHub } from "../src/hub.js";
import { pagesHook, refreshPages } from "../src/pages.js";
import { linkify, renderDoc, renderSpecPage } from "../src/spec-page.js";
import { factory, tempRepo, write } from "./helpers.js";

const SPEC_MD = `# Demo pipeline

> seq: 001 · demo · status: draft · 2026-09-25

## Overview

Covers FR-001 and US1; see D-001.

### US1 A developer ships

## Functional Requirements

- **FR-001** The repo MUST build.
- **NFR-001** Gates fail closed.

<!-- Source: spec.md#FR-001, spec.md#NFR-001 -->

Inline \`FR-001\` stays code. **Assumption A-001** the app is small.

\`\`\`mermaid
graph TD; A-->B
\`\`\`

| a | b |
|---|---|
| 1 | 2 |
`;

const TASKS_MD = `# Tasks

## Phase 1: Setup

- [X] T001 Create skeleton (FR-001) {haiku/low}
- [ ] T002 Add gate (FR-001) {sonnet/medium}
`;

function specWithDocs() {
  const root = tempRepo();
  const f = factory(root);
  const s = f.charterSpec({ slug: "demo", title: "Demo pipeline", summary: "a demo spec for pages" });
  write(root, `${s.dir}/spec.md`, SPEC_MD);
  write(root, `${s.dir}/tasks.md`, TASKS_MD);
  return { root, f, seq: s.seq as number };
}

describe("spec page", () => {
  it("renders a tab per existing file plus decisions, and strips the doc's own H1 and meta line", () => {
    const { f, seq } = specWithDocs();
    const html = renderSpecPage(f, seq);
    const tabs = [...html.matchAll(/class="tab" role="tab" href="#(\w+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(["spec", "tasks", "decisions"]);
    expect(html).toContain("<title>STF · Spec 001 demo</title>");
    expect(html).not.toContain("<h1 id=");
    expect(html).not.toContain("seq: 001 · demo");
  });

  it("anchors definitions and links references to them, but not inside code", () => {
    const { body } = renderDoc("spec", SPEC_MD);
    // the ID inside its own definition is linked too, exactly as the Python renderer did
    expect(body).toContain('<li id="fr-001"><strong><a class="ref ref-FR" href="#fr-001">FR-001</a></strong>');
    expect(body).toContain('<h3 id="us1"><span class="anchor-alias" id="spec-us1-a-developer-ships"></span><a class="ref ref-US" href="#us1">US1</a>');
    expect(body).toContain('<strong id="a-001">Assumption <a class="ref ref-A" href="#a-001">A-001</a>');
    expect(body).toContain('<a class="ref ref-FR" href="#fr-001">FR-001</a> and <a class="ref ref-US" href="#us1">US1</a>');
    expect(body).toContain("<code>FR-001</code>");
    expect(linkify('<a href="#x">FR-001</a> <pre>T001</pre> T002')).toBe('<a href="#x">FR-001</a> <pre>T001</pre> <a class="ref ref-T" href="#t002">T002</a>');
  });

  it("turns trace markers, mermaid fences, tables and task boxes into their page forms", () => {
    const spec = renderDoc("spec", SPEC_MD).body;
    expect(spec).toContain('<p class="trace"><span class="trace-label">Traces to</span> <span>spec.md#<a class="ref ref-FR" href="#fr-001">FR-001</a></span>');
    expect(spec).toContain('<div class="diagram"><pre class="mermaid">');
    expect(spec).toContain('<div class="tablewrap"><table>');
    const tasks = renderDoc("tasks", TASKS_MD).body;
    expect(tasks).toMatch(/<li id="t001" class="task task-done"><span class="box">✓<\/span> <a class="ref ref-T" href="#t001">T001<\/a>/);
    expect(tasks).toMatch(/<li id="t002" class="task task-open"><span class="box"><\/span> <a class="ref ref-T" href="#t002">T002<\/a>/);
  });

  it("gives headings python-markdown ids, prefixed per tab and de-duplicated, and lists h2 in the contents", () => {
    const { body, toc } = renderDoc("plan", "# P\n\n## Café & Co\n\n### Sub\n\n## Café & Co\n");
    expect(body).toContain('<h2 id="plan-cafe-co">');
    expect(body).toContain('<h2 id="plan-cafe-co_1">');
    expect(toc.map((t) => t.id)).toEqual(["plan-cafe-co", "plan-cafe-co_1"]);
    expect(toc[0]!.children.map((t) => t.id)).toEqual(["plan-sub"]);
  });

  it("shows decisions with their rejected alternatives, and escapes plane text", () => {
    const { f, seq } = specWithDocs();
    const alt = f.captureAlternative({ seq, option: "GHCR <script>", summary: "free registry", verdict: "rejected" });
    f.captureDecision({ seq, title: "Use ACR <b>now</b>", statement: "ACR per FR-001", rationale: "Azure-native, costs $&", rejects: [alt.local_id] });
    const html = renderSpecPage(f, seq);
    expect(html).toContain("Use ACR &lt;b&gt;now&lt;/b&gt;");
    expect(html).toContain(`<li id="${alt.local_id.toLowerCase()}"><b>${alt.local_id}</b> GHCR &lt;script&gt;</li>`);
    expect(html).toContain('ACR per <a class="ref ref-FR" href="#fr-001">FR-001</a>');
    expect(html).toContain("costs $&amp;");
  });

  it("never treats placeholder-looking text in a document as a placeholder", () => {
    const { root, f, seq } = specWithDocs();
    write(root, "specs/001-demo/plan.md", "# Plan\n\nLiteral {{TITLE}} and {{PANELS}} stay.\n");
    const html = renderSpecPage(f, seq);
    expect(html).toContain("Literal {{TITLE}} and {{PANELS}} stay.");
  });
});

describe("hub", () => {
  it("links every recorded page and says which are not published yet", () => {
    const { f } = specWithDocs();
    const html = renderHub(f, { dashboard: "https://claude.ai/artifact/dash", specs: {} });
    expect(html).toContain('href="https://claude.ai/artifact/dash"');
    expect(html).toContain('<span class="nolink">not published yet</span>');
    expect(html).toMatch(/<title>STF · stf-test-\w+<\/title>/);
    const linked = renderHub(f, { specs: { "1": "https://claude.ai/artifact/spec1" } });
    expect(linked).toContain('href="https://claude.ai/artifact/spec1"');
  });

  it("summarises the plane and shows each spec's next phase", () => {
    const { f } = specWithDocs();
    const html = renderHub(f, {});
    expect(html).toContain('<span class="n">1</span><span class="l">specs</span>');
    expect(html).toContain("next phase: <b>specify</b>");
    expect(html).toContain("chartered: Demo pipeline");
  });

  it("lists factory decisions with their links both ways, and leaves spec decisions to the spec page", () => {
    const { f, seq } = specWithDocs();
    expect(renderHub(f, {})).toContain("No factory decisions yet.");
    const alt = f.captureAlternative({ option: "GHCR <script>", summary: "x", verdict: "rejected" });
    const old = f.captureDecision({ title: "Old <b>way</b>", statement: "s", rationale: "costs $&", rejects: [alt.local_id] });
    const now = f.captureDecision({ title: "New way", statement: "s", rationale: "r", supersedes: [old.local_id] });
    f.captureDecision({ seq, title: "Spec-only choice", statement: "s", rationale: "r" });
    const html = renderHub(f, {});
    expect(html).toContain("Old &lt;b&gt;way&lt;/b&gt;");
    expect(html).toContain("costs $&amp;");
    expect(html).toContain(`<li><b>${alt.local_id}</b> GHCR &lt;script&gt;</li>`);
    expect(html).toContain(`supersedes <a href="#${old.local_id.toLowerCase()}">${old.local_id}</a>`);
    expect(html).toContain(`superseded by <a href="#${now.local_id.toLowerCase()}">${now.local_id}</a>`);
    expect(html).toContain(`class="decision s-superseded" id="${old.local_id.toLowerCase()}"`);
    expect(html.indexOf(now.local_id)).toBeLessThan(html.indexOf(`id="${old.local_id.toLowerCase()}"`));
    expect(html.split('aria-label="Factory decisions"')[1]!.split("</section>")[0]).not.toContain("Spec-only choice");
  });
});

describe("dashboard title", () => {
  it("names the repo so status pages group in the gallery", () => {
    const f = factory(tempRepo());
    const html = renderDashboard(dashboardData(f));
    expect(html).toMatch(/<title>STF · stf-test-\w+ dashboard<\/title>/);
  });
});

describe("refresh and hook", () => {
  it("rebuilds the dashboard, every spec page and the hub, and points at the recorded URLs", () => {
    const { root, f } = specWithDocs();
    write(root, ".stf/pages.json", JSON.stringify({ hub: "https://claude.ai/artifact/hub", specs: { "1": "https://claude.ai/artifact/s1" } }));
    const r = refreshPages(f);
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatch(/^dashboard: rebuilt .*dashboard\.html; no page recorded yet \(add its URL to \.stf\/pages\.json/);
    expect(r.lines[1]).toMatch(/^spec 001: rebuilt .*spec-page-001\.html; republish with Artifact publish file_path=.* url=https:\/\/claude\.ai\/artifact\/s1$/);
    expect(r.lines[2]).toMatch(/url=https:\/\/claude\.ai\/artifact\/hub$/);
    for (const page of ["dashboard.html", "spec-page-001.html", "hub.html"]) expect(existsSync(join(root, ".stf", page))).toBe(true);
  });

  it("answers the hook with what to republish, and reports failures without failing the tool call", () => {
    const { f } = specWithDocs();
    const ok = pagesHook(f, "stf_capture_decision", 1) as { hookSpecificOutput: { additionalContext: string } };
    expect(ok.hookSpecificOutput.additionalContext).toMatch(/^stf plane changed \(stf_capture_decision\)\. Status pages rebuilt:/);
    const bad = pagesHook(f, "stf_advance_phase", 42) as { systemMessage: string };
    expect(bad.systemMessage).toMatch(/^status-pages hook failed: spec 42:/);
  });

  it("builds nothing and prints nothing where the project lacks a plane export or a pages.json", () => {
    // the launcher against a plugin copy with no runtime: any build attempt would create the data dir
    const base = mkdtempSync(join(tmpdir(), "stf-pages-hook-"));
    const plugin = join(base, "plugin");
    mkdirSync(join(plugin, "scripts"), { recursive: true });
    cpSync(join(import.meta.dirname, "..", "scripts", "run.mjs"), join(plugin, "scripts", "run.mjs"));
    const data = join(base, "data");
    const run = (project: string, event: object) =>
      spawnSync(process.execPath, [join(plugin, "scripts", "run.mjs"), "pages-hook"], {
        input: JSON.stringify(event),
        env: { ...process.env, STF_ROOT: "", CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project },
      });
    const stfTool = { tool_name: "mcp__plugin_stf_stf__stf_verify", tool_input: {} };

    const noPlane = mkdtempSync(join(tmpdir(), "stf-noplane-"));
    const { root } = specWithDocs();
    for (const [project, event] of [
      [noPlane, stfTool], // plugin enabled in a repo with no .stf/
      [root, stfTool], // a plane, but no .stf/pages.json
      [root, { tool_name: "Bash", tool_input: {} }], // not an stf tool
    ] as const) {
      const res = run(project, event);
      expect(res.status).toBe(0);
      expect(res.stdout.toString()).toBe("");
    }
    expect(existsSync(data)).toBe(false);
    expect(readdirSync(join(root, ".stf")).filter((n) => n.endsWith(".html"))).toEqual([]);
    expect(readFileSync(join(root, ".stf", "export", "specs.json"), "utf8")).toContain('"slug": "demo"');
  });
});
