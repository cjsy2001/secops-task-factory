import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StfError } from "./errors.js";
import { TABLES } from "./store.js";

type Row = Record<string, unknown>;
/** Rows per export file, e.g. "decisions.json" → [...]. */
export type ExportRows = Map<string, Row[]>;

/** First line of the rendered summary; CI finds its own PR comment by it. */
export const MARKER = "<!-- stf-plane-summary -->";

/** Columns every write touches; a change to only these is not worth a reviewer's attention. */
const NOISE = new Set(["updated_at", "ordinal"]);
const TEXT_MAX = 280;

/** How a reviewer reads each table: its row identity and the one-line label of a row. */
const VIEWS: Record<string, { title: string; key: (r: Row) => string; label: (r: Row) => string }> = {
  "specs.json": { title: "Specs", key: (r) => pad(r.seq), label: (r) => `${r.slug}: ${r.title}` },
  "tasks.json": { title: "Tasks", key: (r) => `${pad(r.seq)}/${r.local_id}`, label: (r) => `${r.title} {${r.model_tier ?? "?"}/${r.effort ?? "?"}}` },
  "decisions.json": { title: "Decisions", key: (r) => String(r.local_id), label: (r) => String(r.title) },
  "questions.json": { title: "Open questions", key: (r) => String(r.local_id), label: (r) => `${r.question} (${r.status})` },
  "alternatives.json": { title: "Alternatives", key: (r) => String(r.local_id), label: (r) => `${r.option} (${r.verdict})` },
  "evidence.json": { title: "Evidence", key: (r) => String(r.local_id), label: (r) => `${r.claim} → ${r.evidences}` },
  "memories.json": { title: "Memories", key: (r) => String(r.local_id), label: (r) => `[${r.kind}] ${r.title}` },
  "handoffs.json": { title: "Handoffs", key: (r) => String(r.local_id), label: (r) => `${r.invocation} {${r.model_tier}/${r.effort}}` },
  "runs.json": { title: "Runs", key: (r) => String(r.run_key), label: (r) => `${r.kind} ${r.status}${r.summary ? `: ${r.summary}` : ""}` },
  "artefact-hashes.json": { title: "Artefact hashes", key: (r) => `${pad(r.seq)}/${r.local_id} ${r.path}`, label: (r) => `${r.path} (${r.bytes} bytes)` },
  "events.jsonl": { title: "Events", key: (r) => String(r.id), label: (r) => `${r.kind}: ${r.summary}` },
};

export interface TableDiff {
  file: string;
  title: string;
  added: Row[];
  removed: Row[];
  changed: { key: string; before: Row; after: Row; fields: string[] }[];
}

export interface PlaneDiff {
  tables: TableDiff[];
  removed: number;
  empty: boolean;
}

function pad(seq: unknown): string {
  return seq === null || seq === undefined ? "—" : String(seq).padStart(3, "0");
}

function parse(file: string, text: string): Row[] {
  if (!text.trim()) return [];
  if (file.endsWith(".jsonl")) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
  return JSON.parse(text) as Row[];
}

/**
 * The plane's export at a git ref, or in the working tree when no ref is given. A commit without a plane reads as empty,
 * but an unknown ref is refused: read as empty, it would report every row as added.
 */
export function readExportAt(root: string, ref?: string): ExportRows {
  if (ref) {
    try {
      execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" });
    } catch {
      throw new StfError("unknown_ref", `${ref} is not a commit in this repo. Fetch it first (CI: checkout with fetch-depth: 0).`);
    }
  }
  const out: ExportRows = new Map();
  for (const t of TABLES) {
    const rel = `.stf/export/${t.file}`;
    let text = "";
    if (ref) {
      try {
        text = execFileSync("git", ["-C", root, "show", `${ref}:${rel}`], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      } catch {
        text = "";
      }
    } else if (existsSync(join(root, rel))) {
      text = readFileSync(join(root, rel), "utf8");
    }
    out.set(t.file, parse(t.file, text));
  }
  return out;
}

/** Equal values; a field a newer plugin added (absent before, an empty list now) is not a change either. */
function same(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);
  if (a === undefined || b === undefined) return empty(a) && empty(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffPlane(before: ExportRows, after: ExportRows): PlaneDiff {
  const tables: TableDiff[] = [];
  for (const t of TABLES) {
    const view = VIEWS[t.file]!;
    const b = new Map((before.get(t.file) ?? []).map((r) => [view.key(r), r]));
    const a = new Map((after.get(t.file) ?? []).map((r) => [view.key(r), r]));
    const d: TableDiff = { file: t.file, title: view.title, added: [], removed: [], changed: [] };
    for (const [k, r] of a) {
      const old = b.get(k);
      if (!old) {
        d.added.push(r);
        continue;
      }
      const fields = [...new Set([...Object.keys(old), ...Object.keys(r)])].filter((c) => !NOISE.has(c) && !same(old[c], r[c])).sort();
      if (fields.length) d.changed.push({ key: k, before: old, after: r, fields });
    }
    for (const [k, r] of b) if (!a.has(k)) d.removed.push(r);
    if (d.added.length || d.removed.length || d.changed.length) tables.push(d);
  }
  const removed = tables.reduce((n, t) => n + t.removed.length, 0);
  return { tables, removed, empty: tables.length === 0 };
}

/** One line of prose: newlines and table pipes would break the Markdown list. */
function text(v: unknown, max = TEXT_MAX): string {
  const s = (typeof v === "string" ? v : JSON.stringify(v ?? null)).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function value(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return `\`${text(v, 120)}\``;
  return text(v, 120);
}

/** A field change as a reviewer reads it; state columns get the arrow, prose columns only say that they changed. */
function fieldChange(c: TableDiff["changed"][number]): string[] {
  const prose = new Set(["statement", "rationale", "consequences", "summary", "body", "prompt", "output", "objective", "execution_plan", "tradeoffs", "context", "detail"]);
  const shown = c.fields.filter((f) => !prose.has(f));
  const parts = shown.map((f) => `${f}: ${value(c.before[f])} → ${value(c.after[f])}`);
  const quiet = c.fields.filter((f) => prose.has(f));
  if (quiet.length) parts.push(`text edited: ${quiet.join(", ")}`);
  return parts;
}

function decisionLinks(r: Row): string {
  const links: string[] = [];
  for (const rel of ["supersedes", "corrects", "resolves", "rejects"]) {
    const ids = r[rel];
    if (Array.isArray(ids) && ids.length) links.push(`${rel} ${ids.join(", ")}`);
  }
  return links.length ? ` · ${links.join(" · ")}` : "";
}

function addedLine(file: string, r: Row): string[] {
  const view = VIEWS[file]!;
  const key = view.key(r);
  if (file === "decisions.json") {
    const lines = [`- **${key}**${r.seq == null ? " (factory)" : ` (spec ${pad(r.seq)})`} ${text(r.title, 160)}${decisionLinks(r)}`];
    lines.push(`  - ${text(r.statement)}`);
    lines.push(`  - _Why:_ ${text(r.rationale)}`);
    return lines;
  }
  return [`- **${key}** ${text(view.label(r), 200)}`];
}

/** The PR comment: what this change does to the plane, grouped the way a reviewer reads it. */
export function renderPlaneDiff(d: PlaneDiff, opts: { base?: string; head?: string } = {}): string {
  const range = opts.base ? ` (\`${opts.base}\` → \`${opts.head ?? "working tree"}\`)` : "";
  const out = [MARKER, `### stf plane changes${range}`, ""];
  if (d.empty) {
    out.push("No plane changes.");
    return out.join("\n") + "\n";
  }
  if (d.removed) {
    out.push(`> [!WARNING]`, `> ${d.removed} row(s) removed. The plane never deletes rows on its own, so check whether \`.stf/export/\` was edited by hand.`, "");
  }
  const counts = d.tables.map((t) => `${t.title} ${[t.added.length && `+${t.added.length}`, t.changed.length && `~${t.changed.length}`, t.removed.length && `−${t.removed.length}`].filter(Boolean).join(" ")}`);
  out.push(counts.join(" · "), "");
  for (const t of d.tables) {
    if (t.file === "events.jsonl") continue;
    out.push(`#### ${t.title}`);
    for (const r of t.added) out.push(...addedLine(t.file, r));
    for (const c of t.changed) out.push(`- ${c.key}: ${fieldChange(c).join(" · ")}`);
    for (const r of t.removed) out.push(`- ~~${VIEWS[t.file]!.key(r)}~~ removed: ${text(VIEWS[t.file]!.label(r), 200)}`);
    out.push("");
  }
  const events = d.tables.find((t) => t.file === "events.jsonl");
  if (events?.added.length) {
    out.push(`<details><summary>${events.added.length} new event(s)</summary>`, "");
    for (const r of events.added) out.push(`- ${pad(r.seq)} ${text(r.kind, 40)}: ${text(r.summary, 200)}`);
    out.push("", "</details>", "");
  }
  return out.join("\n");
}
