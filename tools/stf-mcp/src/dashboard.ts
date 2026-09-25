import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Factory } from "./factory.js";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "dashboard.html");
const EVENTS_SHOWN = 40;

function git(root: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/**
 * The plane exactly as its export would be written, parsed back into rows. Read-only by construction: it goes
 * through Store.read and the pure Store.render, never mutate/export. Handoff prompts are left out (the page shows
 * the invocation, not the sealed prompt).
 */
export function dashboardData(f: Factory, now: () => string = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) {
  const files = f.store.read(() => f.store.render());
  const json = (file: string) => JSON.parse(files.get(file) ?? "[]") as Record<string, unknown>[];
  const events = (files.get("events.jsonl") ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return {
    repo: basename(git(f.root, "rev-parse", "--show-toplevel") || f.root),
    commit: git(f.root, "rev-parse", "--short", "HEAD"),
    branch: git(f.root, "rev-parse", "--abbrev-ref", "HEAD"),
    dirty: git(f.root, "status", "--porcelain", "--", ".stf/export") !== "",
    generated: now().replace("T", " ").replace(/:\d\dZ$/, " UTC"),
    specs: json("specs.json"),
    tasks: json("tasks.json"),
    runs: json("runs.json"),
    questions: json("questions.json"),
    decisions: json("decisions.json"),
    alternatives: json("alternatives.json"),
    memories: json("memories.json"),
    handoffs: json("handoffs.json").map(({ prompt: _prompt, ...h }) => h),
    events: events.slice(-EVENTS_SHOWN),
  };
}

export type DashboardData = ReturnType<typeof dashboardData>;

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One self-contained HTML page, titled per repo ("STF · <repo> dashboard") so status pages group in the artifact gallery.
 * The data sits in a JSON script block with every "<" escaped, so plane text can't close it.
 */
export function renderDashboard(data: DashboardData): string {
  const blob = JSON.stringify(data).replace(/</g, "\\u003c");
  return readFileSync(TEMPLATE_PATH, "utf8")
    .replace("/*__REPO__*/", () => escHtml(data.repo))
    .replace("/*__DATA__*/", () => blob);
}

/** Write the page (default .stf/dashboard.html, which is gitignored) and say where it went. */
export function writeDashboard(f: Factory, out?: string, data: DashboardData = dashboardData(f)): { out: string; specs: number; tasks: number } {
  const path = resolve(out ?? join(f.root, ".stf", "dashboard.html"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderDashboard(data));
  return { out: path, specs: data.specs.length, tasks: data.tasks.length };
}
