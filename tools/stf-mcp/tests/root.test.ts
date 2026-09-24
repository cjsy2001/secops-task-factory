import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StfError } from "../src/errors.js";
import { Factory } from "../src/factory.js";
import { findRoot, initPlane, resolveRoot } from "../src/root.js";
import { tempRepo } from "./helpers.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StfError) return e.code;
    throw e;
  }
  return "no-error";
};

describe("root resolution", () => {
  it("prefers STF_ROOT, then walks up from CLAUDE_PROJECT_DIR before cwd", () => {
    const repo = tempRepo();
    const deep = join(repo, "a", "b");
    mkdirSync(deep, { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "stf-elsewhere-"));
    expect(findRoot({ STF_ROOT: elsewhere }, deep)).toBe(elsewhere);
    expect(findRoot({ CLAUDE_PROJECT_DIR: deep }, elsewhere)).toBe(repo);
    expect(findRoot({}, deep)).toBe(repo);
  });

  it("never guesses a root: no .stf anywhere up the tree is a no_plane refusal", () => {
    const bare = mkdtempSync(join(tmpdir(), "stf-bare-"));
    expect(findRoot({}, bare)).toBeNull();
    expect(code(() => resolveRoot({}, bare))).toBe("no_plane");
    expect(existsSync(join(bare, ".stf"))).toBe(false);
  });
});

describe("init", () => {
  it("refuses outside a git repo root, creates an empty plane, and leaves an existing one alone", () => {
    const bare = mkdtempSync(join(tmpdir(), "stf-bare-"));
    expect(code(() => initPlane(bare))).toBe("not_repo_root");
    expect(existsSync(join(bare, ".stf"))).toBe(false);

    const repo = mkdtempSync(join(tmpdir(), "stf-init-"));
    mkdirSync(join(repo, ".git"));
    const first = initPlane(repo);
    expect(first.created).toContain("specs.json");
    expect(readFileSync(join(repo, ".stf/export/specs.json"), "utf8")).toBe("[]\n");

    new Factory(repo).charterSpec({ slug: "demo", title: "Demo", summary: "an existing spec" });
    const before = readFileSync(join(repo, ".stf/export/specs.json"), "utf8");
    expect(initPlane(repo).created).toEqual([]);
    expect(readFileSync(join(repo, ".stf/export/specs.json"), "utf8")).toBe(before);
  });
});
