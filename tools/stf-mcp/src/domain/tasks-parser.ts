import { MARKER_TO_STATUS, type TaskStatus } from "./status.js";

export interface ParsedTask {
  localId: string;
  ordinal: number;
  line: number;
  marker: string;
  status: TaskStatus;
  title: string;
  phase: string;
  story: string | null;
  requirements: string[];
  parallel: boolean;
  modelTier: string | null;
  effort: string | null;
  objective: string | null;
  executionPlan: string | null;
  testsCommand: string | null;
}

export interface ParseResult {
  tasks: ParsedTask[];
  errors: string[];
}

const PHASE_RE = /^#{2,4}\s+(Phase\s+\d+\b.*)$/i;
const TASK_RE = /^- \[([ xX!~-])\]\s+(T\d{3,})\b\s*(.*)$/;
const SUB_RE = /^\s{2,}[-*]\s+(objective|plan|tests):\s*(.+)$/i;
const TIER_RE = /\s*\{\s*(haiku|sonnet|opus|fable)\s*\/\s*(low|medium|high|xhigh|max)\s*\}\s*$/i;
const REQS_RE = /\s*\(((?:(?:FR|SC|NFR)-\d{3}[,\s]*)+)\)\s*$/;

/**
 * Parse tasks.md. Line grammar (one task per line):
 *   - [ ] T001 [P] [US1] Verb component in path/to/file (FR-001, FR-002) {sonnet/medium}
 * optionally followed by indented `- objective:`, `- plan:`, `- tests:` sub-bullets.
 * Markers: [ ] pending, [~] in_progress, [!] blocked, [X] done, [-] cancelled.
 */
export function parseTasks(markdown: string): ParseResult {
  const tasks: ParsedTask[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let phase = "Unphased";
  let current: ParsedTask | null = null;

  markdown.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const phaseMatch = PHASE_RE.exec(raw);
    if (phaseMatch) {
      phase = phaseMatch[1]!.trim();
      current = null;
      return;
    }
    const m = TASK_RE.exec(raw);
    if (m) {
      const [, marker, localId, restRaw] = m as unknown as [string, string, string, string];
      let rest = restRaw;
      let modelTier: string | null = null;
      let effort: string | null = null;
      const tier = TIER_RE.exec(rest);
      if (tier) {
        modelTier = tier[1]!.toLowerCase();
        effort = tier[2]!.toLowerCase();
        rest = rest.slice(0, tier.index);
      }
      let requirements: string[] = [];
      const reqs = REQS_RE.exec(rest);
      if (reqs) {
        requirements = reqs[1]!.split(/[,\s]+/).filter(Boolean);
        rest = rest.slice(0, reqs.index);
      }
      let parallel = false;
      let story: string | null = null;
      for (;;) {
        const flag = /^\[(P|US\d+)\]\s*/.exec(rest);
        if (!flag) break;
        if (flag[1] === "P") parallel = true;
        else story = flag[1]!;
        rest = rest.slice(flag[0].length);
      }
      const title = rest.trim();
      if (seen.has(localId)) errors.push(`line ${lineNo}: duplicate task id ${localId}`);
      if (!title) errors.push(`line ${lineNo}: ${localId} has no title`);
      seen.add(localId);
      current = {
        localId,
        ordinal: tasks.length + 1,
        line: lineNo,
        marker,
        status: MARKER_TO_STATUS[marker]!,
        title,
        phase,
        story,
        requirements,
        parallel,
        modelTier,
        effort,
        objective: null,
        executionPlan: null,
        testsCommand: null,
      };
      tasks.push(current);
      return;
    }
    const sub = SUB_RE.exec(raw);
    if (sub && current) {
      const key = sub[1]!.toLowerCase();
      const value = sub[2]!.trim();
      const task: ParsedTask = current;
      if (key === "objective") task.objective = value;
      else if (key === "plan") task.executionPlan = value;
      else task.testsCommand = value;
      return;
    }
    if (/^- \[.\]\s+T\d/.test(raw)) errors.push(`line ${lineNo}: unrecognised task marker: ${raw.slice(0, 20)}`);
  });
  return { tasks, errors };
}

/** Rewrite one task's marker in place, leaving every other byte untouched. */
export function setMarker(markdown: string, localId: string, marker: string): { text: string; found: boolean } {
  const re = new RegExp(`^(- \\[)[ xX!~-](\\]\\s+${localId}\\b)`, "m");
  if (!re.test(markdown)) return { text: markdown, found: false };
  return { text: markdown.replace(re, `$1${marker}$2`), found: true };
}
