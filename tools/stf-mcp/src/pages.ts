import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardData, writeDashboard } from "./dashboard.js";
import type { Factory } from "./factory.js";
import { writeHub } from "./hub.js";
import { pad3, writeSpecPage } from "./spec-page.js";

/**
 * Status pages: the plane dashboard, one page per spec and a hub linking them. Each is a local HTML file (gitignored)
 * that Claude publishes as a private artifact; .stf/pages.json (committed, per repo) records where each one lives, so
 * later sessions update the same page instead of creating another. Publishing stays with Claude: this module only builds.
 */
export interface Pages {
  hub?: string;
  dashboard?: string;
  specs?: Record<string, string>;
}

export const PAGES_FILE = join(".stf", "pages.json");

export function readPages(root: string): Pages {
  const p = join(root, PAGES_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Pages;
  } catch {
    return {};
  }
}

export interface Refresh {
  lines: string[];
  errors: string[];
}

function target(label: string, path: string, url: string | undefined): string {
  if (url) return `${label}: rebuilt ${path}; republish with Artifact publish file_path=${path} url=${url}`;
  return `${label}: rebuilt ${path}; no page recorded yet (add its URL to ${PAGES_FILE} after the first publish)`;
}

const reason = (e: unknown) => String(e instanceof Error ? e.message : e).split("\n")[0];

/** Rebuild the dashboard, the given specs' pages (default: all) and the hub, last, so it reflects the same state. */
export function refreshPages(f: Factory, seqs?: number[]): Refresh {
  const pages = readPages(f.root);
  const data = dashboardData(f);
  const lines: string[] = [];
  const errors: string[] = [];
  try {
    lines.push(target("dashboard", writeDashboard(f, undefined, data).out, pages.dashboard));
  } catch (e) {
    errors.push(`dashboard: ${reason(e)}`);
  }
  for (const seq of seqs ?? data.specs.map((s) => s.seq as number)) {
    try {
      lines.push(target(`spec ${pad3(seq)}`, writeSpecPage(f, seq, undefined, data).out, pages.specs?.[String(seq)]));
    } catch (e) {
      errors.push(`spec ${seq}: ${reason(e)}`);
    }
  }
  try {
    lines.push(target("hub", writeHub(f, undefined, data).out, pages.hub));
  } catch (e) {
    errors.push(`hub: ${reason(e)}`);
  }
  return { lines, errors };
}

/**
 * The PostToolUse hook's JSON answer after an stf plane write. The launcher has already checked that this project has a
 * plane and a pages.json; anything else about the event is best-effort, and it never fails the tool call.
 */
export function pagesHook(f: Factory, tool: string, seq?: number): Record<string, unknown> {
  const r = refreshPages(f, seq === undefined ? undefined : [seq]);
  const out: Record<string, unknown> = { suppressOutput: true };
  if (r.lines.length) {
    out.hookSpecificOutput = {
      hookEventName: "PostToolUse",
      additionalContext:
        `stf plane changed (${tool}). Status pages rebuilt:\n- ` +
        r.lines.join("\n- ") +
        "\nRepublish once at the next phase or task boundary, not after every write. The pages are private; update the recorded URLs, never publish new ones.",
    };
  }
  if (r.errors.length) out.systemMessage = `status-pages hook failed: ${r.errors.join("; ")}`;
  return out;
}
