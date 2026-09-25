import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StfError } from "../src/errors.js";
import { Factory } from "../src/factory.js";
import { GITLEAKS_VERSION, newProject, renderTemplate, type NewProjectOptions } from "../src/new-project.js";

const base = (over: Partial<NewProjectOptions> = {}): NewProjectOptions => ({
  dir: join(mkdtempSync(join(tmpdir(), "stf-new-")), "repo"),
  name: "zero-trust-audit",
  description: "An Azure misconfiguration and identity auditor with webhook alerts.",
  title: "Cloud zero-trust audit tool",
  author: "Test Author",
  year: 2026,
  ...over,
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof StfError) return e.code;
    throw e;
  }
  return "no error";
}

function allFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) allFiles(root, p, out);
    else out.push(p.slice(root.length + 1));
  }
  return out.sort();
}

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args]).toString().trim();

describe("stf new-project", () => {
  it("writes the scaffold, a plane and chartered spec 001, with every placeholder filled", () => {
    const r = newProject(base());
    expect(r.files).toEqual([
      ".claude/rules/azure.md",
      ".claude/rules/factory.md",
      ".claude/rules/security.md",
      ".claude/settings.json",
      ".githooks/pre-commit",
      ".github/workflows/secrets.yml",
      ".gitignore",
      ".gitleaks.toml",
      "CLAUDE.md",
      "LICENSE",
      "Makefile",
      "README.md",
    ]);
    for (const f of r.files) expect([f, readFileSync(join(r.root, f), "utf8")]).not.toEqual([f, expect.stringMatching(/\{\{[A-Z_]+\}\}/)]);
    expect(allFiles(r.root).filter((f) => f.endsWith(".tmpl"))).toEqual([]);
    expect(r.spec).toEqual({ seq: 1, slug: "zero-trust-audit", dir: "specs/001-zero-trust-audit" });
    const spec = new Factory(r.root).getSpec({ seq: 1 });
    expect(spec).toMatchObject({ title: "Cloud zero-trust audit tool", phase: "specify", summary: base().description });
    expect(readFileSync(join(r.root, "CLAUDE.md"), "utf8")).toMatch(/^# zero-trust-audit\n\nAn Azure misconfiguration/);
    expect(readFileSync(join(r.root, "LICENSE"), "utf8")).toContain("Copyright (c) 2026 Test Author");
  });

  it("sets up git for the hook: main branch, hooksPath, an executable pre-commit", () => {
    const r = newProject(base());
    expect(git(r.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(r.root, "config", "core.hooksPath")).toBe(".githooks");
    expect(statSync(join(r.root, ".githooks", "pre-commit")).mode & 0o111).not.toBe(0);
    expect(git(r.root, "rev-list", "--all")).toBe(""); // nothing committed: the skill's first commit runs the hook
  });

  it("enables the stf plugin in a settings.json that parses", () => {
    const r = newProject(base());
    const s = JSON.parse(readFileSync(join(r.root, ".claude", "settings.json"), "utf8"));
    expect(s.enabledPlugins).toEqual({ "stf@secops-task-factory": true });
    expect(s.extraKnownMarketplaces["secops-task-factory"].source).toEqual({ source: "github", repo: "cjsy2001/secops-task-factory" });
  });

  it("pins gitleaks to one version everywhere it runs, never :latest", () => {
    const r = newProject(base());
    expect(GITLEAKS_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const f of [".githooks/pre-commit", ".github/workflows/secrets.yml", "Makefile"]) {
      const text = readFileSync(join(r.root, f), "utf8");
      expect(text).toContain(`zricethezav/gitleaks:${GITLEAKS_VERSION}`);
      expect(text).not.toContain("gitleaks:latest");
    }
  });

  it("leaves out the Azure rules and the license when asked, and words the rules for a private repo", () => {
    const r = newProject(base({ azure: false, license: "none", visibility: "private" }));
    expect(r.files).not.toContain(".claude/rules/azure.md");
    expect(r.files).not.toContain("LICENSE");
    const claude = readFileSync(join(r.root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("(security, factory)");
    expect(claude).toContain("even though this repo is private");
  });

  it("refuses to render a template that names a value the scaffold doesn't supply", () => {
    expect(renderTemplate("a", "# {{NAME}}", { NAME: "x" })).toBe("# x");
    expect(() => renderTemplate("CLAUDE.md", "# {{NAME}} {{OWNER}}", { NAME: "x" })).toThrow("template CLAUDE.md has no value for {{OWNER}}");
  });

  it("never expands placeholder-looking text in the description", () => {
    const r = newProject(base({ description: "A tool whose docs mention {{NAME}} literally." }));
    expect(readFileSync(join(r.root, "README.md"), "utf8")).toContain("mention {{NAME}} literally");
  });

  it("refuses a bad name, a thin description, a secret, a missing author, and a non-empty directory", () => {
    expect(code(() => newProject(base({ name: "Zero Trust" })))).toBe("bad_name");
    expect(code(() => newProject(base({ description: "short" })))).toBe("description_too_short");
    expect(code(() => newProject(base({ description: "token ghp_" + "a".repeat(36) + " inside" })))).toBe("secret_detected");
    expect(code(() => newProject(base({ author: "" })))).toBe("author_required");
    const busy = base();
    mkdirSync(busy.dir, { recursive: true });
    writeFileSync(join(busy.dir, "keep.txt"), "x");
    expect(code(() => newProject(busy))).toBe("dir_not_empty");
    expect(existsSync(join(busy.dir, ".git"))).toBe(false);
  });
});
