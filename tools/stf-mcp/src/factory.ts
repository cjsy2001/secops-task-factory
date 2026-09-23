import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StfError } from "./errors.js";
import { commitExists, hashFile, repoRelative, verifyArtefact, type ArtefactVerdict } from "./domain/hash.js";
import {
  canComplete,
  canTransition,
  LIFECYCLE_PHASES,
  STATUS_TO_MARKER,
  type LifecyclePhase,
  type TaskStatus,
} from "./domain/status.js";
import { parseTasks, setMarker } from "./domain/tasks-parser.js";
import { sha256, Store } from "./store.js";

// Rows come straight from SQLite; their shape is the schema in db/schema.sql.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const MEMORY_KINDS = ["decision", "lesson", "open_question", "resolved_open_question", "constraint"] as const;

const pad3 = (n: number) => String(n).padStart(3, "0");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const parseJson = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

/** Patterns that must never be persisted into the plane (it is committed to git). */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["Slack/Discord webhook", /hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/],
  ["Azure storage key / connection string", /AccountKey=[A-Za-z0-9+/=]{20,}/],
  ["password assignment", /\b(pass(word)?|secret|api[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[^\s'"]{8,}/i],
];

export function findSecret(...texts: (string | null | undefined)[]): string | null {
  const joined = texts.filter(Boolean).join("\n");
  for (const [name, re] of SECRET_PATTERNS) if (re.test(joined)) return name;
  return null;
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "not", "are", "from", "into", "when", "must", "should", "only"]);
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Lifecycle hash of an artefact. tasks.md is hashed with markers normalised: the plane rewrites them. */
function lifecycleHash(root: string, rel: string): string | null {
  const h = hashFile(root, rel);
  if (!h) return null;
  if (!rel.endsWith("/tasks.md")) return h.sha256;
  return sha256(readFileSync(join(root, rel), "utf8").replace(/^- \[[ xX!~-]\]/gm, "- [ ]"));
}

const PHASE_FILE: Record<string, string> = { specify: "spec.md", clarify: "spec.md", plan: "plan.md", tasks: "tasks.md" };

export interface FactoryOptions {
  now?: () => string;
  sessionId?: string;
}

/**
 * The control plane's rules. Every public method is one tool (or CLI verb);
 * every refusal is a StfError whose message says what to do instead.
 */
export class Factory {
  readonly store: Store;
  readonly sessionId: string;
  private readonly now: () => string;

  constructor(
    readonly root: string,
    opts: FactoryOptions = {},
  ) {
    this.store = new Store(root);
    this.sessionId = opts.sessionId ?? randomUUID();
    this.now = opts.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private spec(seq: number): Row {
    const row = this.store.db.prepare("SELECT * FROM spec WHERE seq = ?").get(seq) as Row | undefined;
    if (!row) throw new StfError("unknown_spec", `No spec with seq ${seq}. Call stf_list_specs to see what exists.`);
    return row;
  }

  specDir(spec: Row): string {
    return `specs/${pad3(spec.seq)}-${spec.slug}`;
  }

  private task(seq: number, localId: string): Row {
    const row = this.store.db.prepare("SELECT * FROM task WHERE seq = ? AND local_id = ?").get(seq, localId) as Row | undefined;
    if (!row) {
      throw new StfError("unknown_task", `No task ${localId} in spec ${seq}. Call stf_list_tasks; if tasks.md has it, run stf_import_tasks.`);
    }
    return row;
  }

  private checkTitle(task: Row, expectTitle: string): void {
    const want = norm(expectTitle);
    const have = norm(task.title);
    if (want === have || (want.length >= 12 && have.startsWith(want))) return;
    throw new StfError(
      "title_mismatch",
      `${task.local_id} is titled "${task.title}", not "${expectTitle}". Re-read the task with stf_get_task before writing its status.`,
    );
  }

  private nextId(table: string, prefix: string): string {
    const rows = this.store.db.prepare(`SELECT local_id FROM ${table}`).all() as Row[];
    const max = rows.reduce((m, r) => Math.max(m, Number(String(r.local_id).slice(prefix.length + 1)) || 0), 0);
    return `${prefix}-${pad3(max + 1)}`;
  }

  private event(seq: number | null, kind: string, summary: string, runKey: string | null = null): void {
    this.store.db
      .prepare("INSERT INTO event (seq, kind, summary, run_key, session_id, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(seq, kind, summary, runKey, this.sessionId, this.now());
  }

  private requireOpenRun(runKey: string, seq: number | null): Row {
    const run = this.store.db.prepare("SELECT * FROM run WHERE run_key = ?").get(runKey) as Row | undefined;
    if (!run) throw new StfError("unknown_run", `No run ${runKey}. Open one with stf_start_run first — every write belongs to a run.`);
    if (run.status !== "open") throw new StfError("run_closed", `Run ${runKey} is ${run.status}. Start a new run.`);
    if (seq !== null && run.seq !== null && run.seq !== seq) {
      throw new StfError("run_spec_mismatch", `Run ${runKey} belongs to spec ${run.seq}, not ${seq}.`);
    }
    return run;
  }

  private tasksPath(spec: Row): string {
    return join(this.root, this.specDir(spec), "tasks.md");
  }

  /** Mirror plane status into tasks.md markers. The plane is the truth for status. */
  private syncMarker(spec: Row, localId: string, status: TaskStatus): void {
    const p = this.tasksPath(spec);
    if (!existsSync(p)) return;
    const text = readFileSync(p, "utf8");
    const { text: next, found } = setMarker(text, localId, STATUS_TO_MARKER[status]);
    if (found && next !== text) writeFileSync(p, next);
  }

  private resolveSpecPath(spec: Row, p: string): string {
    return p.startsWith("specs/") || p.startsWith("/") ? repoRelative(this.root, p) : repoRelative(this.root, `${this.specDir(spec)}/${p}`);
  }

  private shapeSpec(row: Row): Row {
    return {
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      dir: this.specDir(row),
      phase: row.phase,
      gate: parseJson(row.gate, null),
      health: parseJson(row.health, null),
      artefacts: parseJson(row.artefacts, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private shapeTask(row: Row, withHashes = false): Row {
    const out: Row = {
      seq: row.seq,
      localId: row.local_id,
      title: row.title,
      phase: row.phase,
      story: row.story,
      requirements: parseJson(row.requirements, []),
      parallel: !!row.parallel,
      status: row.status,
      objective: row.objective,
      executionPlan: row.execution_plan,
      testsCommand: row.tests_command,
      modelTier: row.model_tier,
      effort: row.effort,
      output: row.output,
      runKey: row.run_key,
      blockedReason: row.blocked_reason,
      completedAt: row.completed_at,
    };
    if (withHashes) {
      out.artefacts = this.store.db
        .prepare("SELECT path, sha256, bytes, recorded_at FROM artefact_hash WHERE seq = ? AND local_id = ? ORDER BY path")
        .all(row.seq, row.local_id);
    }
    return out;
  }

  // ───────────────────────────── specs & lifecycle ─────────────────────────────

  charterSpec(a: { slug: string; title: string; summary: string }): Row {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug)) throw new StfError("bad_slug", "slug must be lowercase-kebab-case, e.g. devsecops-pipeline.");
    const row = this.store.mutate((db) => {
      if (db.prepare("SELECT 1 FROM spec WHERE slug = ?").get(a.slug)) {
        throw new StfError("duplicate_slug", `A spec with slug ${a.slug} already exists. Use stf_list_specs.`);
      }
      const { max } = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM spec").get() as Row;
      const seq = max + 1;
      const at = this.now();
      db.prepare("INSERT INTO spec (seq, slug, title, summary, phase, created_at, updated_at) VALUES (?, ?, ?, ?, 'specify', ?, ?)").run(
        seq,
        a.slug,
        a.title,
        a.summary,
        at,
        at,
      );
      this.event(seq, "lifecycle", `chartered: ${a.title}`);
      return this.spec(seq);
    });
    mkdirSync(join(this.root, this.specDir(row)), { recursive: true });
    return this.shapeSpec(row);
  }

  listSpecs(): Row[] {
    return this.store.read((db) =>
      (db.prepare("SELECT * FROM spec ORDER BY seq").all() as Row[]).map((s) => {
        const counts = this.counts(s.seq);
        return { seq: s.seq, slug: s.slug, title: s.title, phase: s.phase, gated: !!s.gate, dir: this.specDir(s), tasks: counts };
      }),
    );
  }

  private counts(seq: number): Record<string, number> {
    const rows = this.store.db.prepare("SELECT status, COUNT(*) AS n FROM task WHERE seq = ? GROUP BY status").all(seq) as Row[];
    const out: Record<string, number> = { total: 0 };
    for (const r of rows) {
      out[r.status] = r.n;
      out.total! += r.n;
    }
    return out;
  }

  getSpec(a: { seq: number }): Row {
    return this.store.read(() => {
      const s = this.spec(a.seq);
      const dir = this.specDir(s);
      const files = ["spec.md", "research.md", "plan.md", "data-model.md", "tasks.md"].filter((f) => existsSync(join(this.root, dir, f)));
      return { ...this.shapeSpec(s), files, tasks: this.counts(a.seq) };
    });
  }

  advancePhase(a: {
    seq: number;
    phase: LifecyclePhase;
    runKey: string;
    artefacts: string[];
    healthScore?: number;
    highFindings?: number;
    reportPath?: string;
  }): Row {
    return this.shapeSpec(
      this.store.mutate((db) => {
        const s = this.spec(a.seq);
        this.requireOpenRun(a.runKey, a.seq);
        const idx = LIFECYCLE_PHASES.indexOf(a.phase);
        const cur = LIFECYCLE_PHASES.indexOf(s.phase);
        if (a.phase === "done") throw new StfError("bad_phase", "done is a state, not a phase to complete.");
        if (idx !== cur) {
          throw new StfError(
            "phase_order",
            idx < cur
              ? `Spec ${a.seq} already completed ${a.phase}; it is at ${s.phase}. To redo it, call stf_reopen_phase.`
              : `Spec ${a.seq} is at ${s.phase}; complete ${s.phase} before ${a.phase}.`,
          );
        }
        const paths = a.artefacts.map((p) => this.resolveSpecPath(s, p));
        if (a.phase === "analyze") {
          if (!a.reportPath) throw new StfError("missing_report", "analyze needs reportPath (the analysis/*.md you wrote).");
          paths.push(this.resolveSpecPath(s, a.reportPath));
        }
        const req = PHASE_FILE[a.phase];
        if (req && !paths.includes(`${this.specDir(s)}/${req}`)) paths.push(`${this.specDir(s)}/${req}`);

        const hashes: Record<string, string> = {};
        for (const p of paths) {
          const h = lifecycleHash(this.root, p);
          if (!h) throw new StfError("missing_artefact", `${p} does not exist. A phase completes only on artefacts that are on disk.`);
          hashes[p] = h;
        }

        const specMd = join(this.root, this.specDir(s), "spec.md");
        if (a.phase === "clarify" && readFileSync(specMd, "utf8").includes("[NEEDS CLARIFICATION")) {
          throw new StfError("unresolved_clarifications", "spec.md still contains [NEEDS CLARIFICATION] markers. Resolve them (or record them as Assumptions) first.");
        }
        if (a.phase === "tasks") {
          const parsed = parseTasks(readFileSync(this.tasksPath(s), "utf8"));
          if (parsed.errors.length) throw new StfError("tasks_invalid", "tasks.md does not parse cleanly.", parsed.errors);
          if (!parsed.tasks.length) throw new StfError("tasks_empty", "tasks.md has no task lines.");
          const untiered = parsed.tasks.filter((t) => !t.modelTier).map((t) => t.localId);
          if (untiered.length) throw new StfError("tasks_untiered", `Every task needs a {tier/effort} suffix. Missing: ${untiered.join(", ")}`);
          const imported = (db.prepare("SELECT COUNT(*) AS n FROM task WHERE seq = ?").get(a.seq) as Row).n;
          if (imported < parsed.tasks.length) throw new StfError("tasks_not_imported", "Run stf_import_tasks before completing the tasks phase.");
        }

        let gate = parseJson<Row | null>(s.gate, null);
        let health = parseJson<Row | null>(s.health, null);
        if (a.phase === "analyze") {
          if (gate && gate.sessionId === this.sessionId) {
            throw new StfError(
              "session_gate",
              "analyze must run in a FRESH session — this session wrote the tasks. Hand off (stf_handoff_emit) and resume in a new session.",
            );
          }
          if (a.healthScore === undefined || a.highFindings === undefined) {
            throw new StfError("missing_health", "analyze needs healthScore and highFindings.");
          }
          if (a.healthScore < 80 || a.highFindings > 0) {
            throw new StfError(
              "analyze_failed",
              `Health ${a.healthScore} with ${a.highFindings} High finding(s) does not pass (need ≥80 and 0 High). Fix the artefacts via stf_reopen_phase, then re-run analyze.`,
            );
          }
          gate = null;
          health = { score: a.healthScore, highFindings: a.highFindings, report: paths[paths.length - 1], at: this.now() };
        }
        if (a.phase === "tasks") {
          gate = { sessionId: this.sessionId, runKey: a.runKey, reason: "analyze needs fresh eyes", setAt: this.now() };
        }

        const artefacts = parseJson<Row>(s.artefacts, {});
        artefacts[a.phase] = hashes;
        const next = LIFECYCLE_PHASES[idx + 1]!;
        db.prepare("UPDATE spec SET phase = ?, gate = ?, health = ?, artefacts = ?, updated_at = ? WHERE seq = ?").run(
          next,
          gate ? JSON.stringify(gate) : null,
          health ? JSON.stringify(health) : null,
          JSON.stringify(artefacts),
          this.now(),
          a.seq,
        );
        this.event(a.seq, "lifecycle", `${a.phase} complete → next: ${next}${gate ? " (session gate set)" : ""}`, a.runKey);
        return this.spec(a.seq);
      }),
    );
  }

  reopenPhase(a: { seq: number; phase: LifecyclePhase; reason: string; runKey: string }): Row {
    return this.shapeSpec(
      this.store.mutate((db) => {
        const s = this.spec(a.seq);
        this.requireOpenRun(a.runKey, a.seq);
        const idx = LIFECYCLE_PHASES.indexOf(a.phase);
        if (a.phase === "done" || idx > LIFECYCLE_PHASES.indexOf(s.phase)) {
          throw new StfError("bad_reopen", `Can only reopen a phase at or before the current one (${s.phase}).`);
        }
        const artefacts = parseJson<Row>(s.artefacts, {});
        for (const p of LIFECYCLE_PHASES.slice(idx)) delete artefacts[p];
        db.prepare("UPDATE spec SET phase = ?, gate = NULL, health = NULL, artefacts = ?, updated_at = ? WHERE seq = ?").run(
          a.phase,
          JSON.stringify(artefacts),
          this.now(),
          a.seq,
        );
        this.event(a.seq, "lifecycle", `reopened at ${a.phase}: ${a.reason}`, a.runKey);
        return this.spec(a.seq);
      }),
    );
  }

  // ───────────────────────────── tasks ─────────────────────────────

  importTasks(a: { seq: number }): Row {
    return this.store.mutate((db) => {
      const s = this.spec(a.seq);
      const p = this.tasksPath(s);
      if (!existsSync(p)) throw new StfError("no_tasks_file", `${this.specDir(s)}/tasks.md does not exist.`);
      const parsed = parseTasks(readFileSync(p, "utf8"));
      if (parsed.errors.length) throw new StfError("tasks_invalid", "tasks.md does not parse cleanly; nothing imported.", parsed.errors);

      const at = this.now();
      const created: string[] = [];
      const updated: string[] = [];
      const warnings: string[] = [];
      const markerCorrections: string[] = [];
      for (const t of parsed.tasks) {
        const existing = db.prepare("SELECT * FROM task WHERE seq = ? AND local_id = ?").get(a.seq, t.localId) as Row | undefined;
        if (!t.modelTier) warnings.push(`${t.localId} has no {tier/effort} suffix`);
        if (!existing) {
          let status: TaskStatus = t.status;
          if (status === "done") {
            status = "pending";
            warnings.push(`${t.localId} is marked [X] but has no captured outcome; imported as pending (done needs stf_capture_task_outcome)`);
          }
          db.prepare(
            `INSERT INTO task (seq, local_id, ordinal, title, phase, story, requirements, parallel, status, objective,
               execution_plan, tests_command, model_tier, effort, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            a.seq,
            t.localId,
            t.ordinal,
            t.title,
            t.phase,
            t.story,
            JSON.stringify(t.requirements),
            t.parallel ? 1 : 0,
            status,
            t.objective,
            t.executionPlan,
            t.testsCommand,
            t.modelTier,
            t.effort,
            at,
          );
          created.push(t.localId);
          if (status !== t.status) markerCorrections.push(`${t.localId}: [${t.marker}] → [${STATUS_TO_MARKER[status]}]`);
          continue;
        }
        const fields = {
          ordinal: t.ordinal,
          title: t.title,
          phase: t.phase,
          story: t.story,
          requirements: JSON.stringify(t.requirements),
          parallel: t.parallel ? 1 : 0,
          objective: t.objective ?? existing.objective,
          execution_plan: t.executionPlan ?? existing.execution_plan,
          tests_command: t.testsCommand ?? existing.tests_command,
          model_tier: t.modelTier ?? existing.model_tier,
          effort: t.effort ?? existing.effort,
        };
        const changed = Object.entries(fields).some(([k, v]) => existing[k] !== v);
        if (changed) {
          db.prepare(
            `UPDATE task SET ordinal=?, title=?, phase=?, story=?, requirements=?, parallel=?, objective=?, execution_plan=?,
               tests_command=?, model_tier=?, effort=?, updated_at=? WHERE seq=? AND local_id=?`,
          ).run(...Object.values(fields), at, a.seq, t.localId);
          updated.push(t.localId);
        }
        if (existing.status !== t.status) markerCorrections.push(`${t.localId}: [${t.marker}] → [${STATUS_TO_MARKER[existing.status as TaskStatus]}] (plane says ${existing.status})`);
      }
      const inFile = new Set(parsed.tasks.map((t) => t.localId));
      const missingFromFile = (db.prepare("SELECT local_id FROM task WHERE seq = ? ORDER BY ordinal").all(a.seq) as Row[])
        .map((r) => r.local_id as string)
        .filter((id) => !inFile.has(id));

      // Re-mirror every marker from the plane so a hand-flipped [X] cannot stand.
      let text = readFileSync(p, "utf8");
      for (const r of db.prepare("SELECT local_id, status FROM task WHERE seq = ?").all(a.seq) as Row[]) {
        text = setMarker(text, r.local_id, STATUS_TO_MARKER[r.status as TaskStatus]).text;
      }
      writeFileSync(p, text);

      this.event(a.seq, "import", `tasks.md imported: ${created.length} created, ${updated.length} updated, ${missingFromFile.length} missing from file`);
      return { created, updated, unchanged: parsed.tasks.length - created.length - updated.length, missingFromFile, markerCorrections, warnings };
    });
  }

  listTasks(a: { seq: number; status?: TaskStatus; phase?: string }): Row[] {
    return this.store.read((db) => {
      this.spec(a.seq);
      return (db.prepare("SELECT * FROM task WHERE seq = ? ORDER BY ordinal").all(a.seq) as Row[])
        .filter((t) => (!a.status || t.status === a.status) && (!a.phase || t.phase === a.phase))
        .map((t) => this.shapeTask(t));
    });
  }

  getTask(a: { seq: number; localId: string }): Row {
    return this.store.read(() => this.shapeTask(this.task(a.seq, a.localId), true));
  }

  nextTask(a: { seq: number }): Row {
    return this.store.read((db) => {
      const s = this.spec(a.seq);
      const all = db.prepare("SELECT * FROM task WHERE seq = ? ORDER BY ordinal").all(a.seq) as Row[];
      const resume = all.find((t) => t.status === "in_progress");
      const next = resume ?? all.find((t) => t.status === "pending");
      return {
        lifecyclePhase: s.phase,
        implementationReady: s.phase === "done",
        next: next ? this.shapeTask(next) : null,
        reason: resume ? "resume: a task is already in progress" : next ? "first pending task in file order" : "no pending tasks",
        blocked: all.filter((t) => t.status === "blocked").map((t) => ({ localId: t.local_id, title: t.title, reason: t.blocked_reason })),
        counts: this.counts(a.seq),
      };
    });
  }

  setTaskStatus(a: { seq: number; localId: string; status: TaskStatus; expectTitle: string; reason?: string }): Row {
    if (a.status === "done") {
      throw new StfError("use_capture_outcome", "A task becomes done only through stf_capture_task_outcome (output + artefacts).");
    }
    return this.store.mutate((db) => {
      const s = this.spec(a.seq);
      const t = this.task(a.seq, a.localId);
      this.checkTitle(t, a.expectTitle);
      if (t.status === a.status) return this.shapeTask(t);
      if (!canTransition(t.status, a.status)) {
        throw new StfError("illegal_transition", `${a.localId}: ${t.status} → ${a.status} is not allowed.`);
      }
      if (a.status === "blocked" && !a.reason) throw new StfError("reason_required", "Blocking a task needs a reason.");
      if (t.status === "done") db.prepare("DELETE FROM artefact_hash WHERE seq = ? AND local_id = ?").run(a.seq, a.localId);
      db.prepare("UPDATE task SET status = ?, blocked_reason = ?, completed_at = CASE WHEN ? = 'done' THEN completed_at ELSE NULL END, updated_at = ? WHERE seq = ? AND local_id = ?").run(
        a.status,
        a.status === "blocked" ? a.reason : null,
        a.status,
        this.now(),
        a.seq,
        a.localId,
      );
      this.event(a.seq, "task", `${a.localId}: ${t.status} → ${a.status}${a.reason ? ` (${a.reason})` : ""}`);
      this.syncMarker(s, a.localId, a.status);
      return this.shapeTask(this.task(a.seq, a.localId));
    });
  }

  captureTaskOutcome(a: {
    seq: number;
    localId: string;
    expectTitle: string;
    runKey: string;
    output: string;
    artefacts: string[];
    testsCommand?: string;
  }): Row {
    return this.store.mutate((db) => {
      const s = this.spec(a.seq);
      const t = this.task(a.seq, a.localId);
      this.checkTitle(t, a.expectTitle);
      this.requireOpenRun(a.runKey, a.seq);
      if (!canComplete(t.status)) {
        throw new StfError("illegal_transition", `${a.localId} is ${t.status}; reopen it (status in_progress) before capturing a new outcome.`);
      }
      if (a.output.trim().length < 20) throw new StfError("output_too_thin", "output must say what was done and how it was verified (≥20 chars).");
      if (!a.artefacts.length) throw new StfError("no_artefacts", "done needs at least one artefact path (the files this task produced or changed).");
      const at = this.now();
      const rels = [...new Set(a.artefacts.map((p) => repoRelative(this.root, p)))];
      const hashed = rels.map((rel) => {
        const h = hashFile(this.root, rel);
        if (!h) throw new StfError("missing_artefact", `${rel} does not exist on disk; cannot record it as evidence.`);
        return { rel, ...h };
      });
      db.prepare("DELETE FROM artefact_hash WHERE seq = ? AND local_id = ?").run(a.seq, a.localId);
      for (const h of hashed) {
        db.prepare("INSERT INTO artefact_hash (seq, local_id, path, sha256, bytes, recorded_at) VALUES (?,?,?,?,?,?)").run(
          a.seq,
          a.localId,
          h.rel,
          h.sha256,
          h.bytes,
          at,
        );
      }
      db.prepare(
        "UPDATE task SET status = 'done', output = ?, run_key = ?, tests_command = COALESCE(?, tests_command), blocked_reason = NULL, completed_at = ?, updated_at = ? WHERE seq = ? AND local_id = ?",
      ).run(a.output, a.runKey, a.testsCommand ?? null, at, at, a.seq, a.localId);
      this.event(a.seq, "task", `${a.localId} done (${hashed.length} artefact(s) hashed)`, a.runKey);
      this.syncMarker(s, a.localId, "done");
      return this.shapeTask(this.task(a.seq, a.localId), true);
    });
  }

  setTaskModel(a: { seq: number; localId: string; modelTier: string; effort: string }): Row {
    return this.store.mutate((db) => {
      this.task(a.seq, a.localId);
      db.prepare("UPDATE task SET model_tier = ?, effort = ?, updated_at = ? WHERE seq = ? AND local_id = ?").run(a.modelTier, a.effort, this.now(), a.seq, a.localId);
      return this.shapeTask(this.task(a.seq, a.localId));
    });
  }

  // ───────────────────────────── runs & events ─────────────────────────────

  startRun(a: { seq?: number; kind: string; summary?: string }): Row {
    return this.store.mutate((db) => {
      const seq = a.seq ?? null;
      if (seq !== null) this.spec(seq);
      const day = this.now().slice(0, 10).replace(/-/g, "");
      const base = `${a.kind}-${seq === null ? "x" : pad3(seq)}-${day}`;
      let n = 1;
      while (db.prepare("SELECT 1 FROM run WHERE run_key = ?").get(`${base}-${n}`)) n++;
      const runKey = `${base}-${n}`;
      const peers = (db.prepare("SELECT run_key, kind, started_at, session_id FROM run WHERE status = 'open' AND (seq IS ? OR ? IS NULL)").all(seq, seq) as Row[]).map(
        (r) => ({ runKey: r.run_key, kind: r.kind, startedAt: r.started_at, sameSession: r.session_id === this.sessionId }),
      );
      db.prepare("INSERT INTO run (run_key, seq, kind, status, session_id, summary, started_at) VALUES (?, ?, ?, 'open', ?, ?, ?)").run(
        runKey,
        seq,
        a.kind,
        this.sessionId,
        a.summary ?? null,
        this.now(),
      );
      this.event(seq, "run", `run opened: ${runKey}`, runKey);
      return {
        runKey,
        sessionId: this.sessionId,
        openPeerRuns: peers,
        warning: peers.length ? "Other runs are still open on this scope — a stale session or a peer. Close them (stf_complete_run) if they are yours." : undefined,
      };
    });
  }

  completeRun(a: { runKey: string; outcome: "completed" | "failed"; summary: string }): Row {
    return this.store.mutate((db) => {
      const run = this.requireOpenRun(a.runKey, null);
      db.prepare("UPDATE run SET status = ?, summary = ?, completed_at = ? WHERE run_key = ?").run(a.outcome, a.summary, this.now(), a.runKey);
      this.event(run.seq, "run", `run ${a.outcome}: ${a.runKey} — ${a.summary}`, a.runKey);
      const stillInProgress =
        run.seq === null
          ? []
          : (db.prepare("SELECT local_id FROM task WHERE seq = ? AND status = 'in_progress'").all(run.seq) as Row[]).map((r) => r.local_id);
      return {
        runKey: a.runKey,
        outcome: a.outcome,
        warning: stillInProgress.length ? `Tasks left in_progress: ${stillInProgress.join(", ")}. Hand them off or set them back to pending.` : undefined,
      };
    });
  }

  appendEvent(a: { seq?: number; kind: string; summary: string; runKey?: string }): Row {
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      if (a.runKey) this.requireOpenRun(a.runKey, a.seq ?? null);
      this.event(a.seq ?? null, a.kind, a.summary, a.runKey ?? null);
      return (db.prepare("SELECT * FROM event ORDER BY id DESC LIMIT 1").get() as Row);
    });
  }

  checkpoint(a: { seq: number; runKey: string; phase: string; testsPassed: boolean; testsCommand?: string; commitSha?: string; notes?: string }): Row {
    return this.store.mutate((db) => {
      this.spec(a.seq);
      this.requireOpenRun(a.runKey, a.seq);
      const tasks = db.prepare("SELECT local_id, status FROM task WHERE seq = ? AND phase = ? ORDER BY ordinal").all(a.seq, a.phase) as Row[];
      if (!tasks.length) throw new StfError("unknown_phase", `Spec ${a.seq} has no tasks in phase "${a.phase}". Use the exact phase heading from tasks.md.`);
      if (a.commitSha && !commitExists(this.root, a.commitSha)) {
        throw new StfError("unknown_commit", `Commit ${a.commitSha} does not exist in this repository. Commit first, then checkpoint with the real sha.`);
      }
      const remaining = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => t.local_id);
      const state = remaining.length === 0 && a.testsPassed ? "complete" : "partial";
      const done = tasks.filter((t) => t.status === "done").length;
      this.event(
        a.seq,
        "checkpoint",
        `${a.phase}: ${state} (${done}/${tasks.length} done; tests ${a.testsPassed ? "passed" : "FAILED"}${a.testsCommand ? ` via \`${a.testsCommand}\`` : ""}${a.commitSha ? `; commit ${a.commitSha.slice(0, 12)}` : "; no commit"})${a.notes ? ` — ${a.notes}` : ""}`,
        a.runKey,
      );
      return { phase: a.phase, state, done, total: tasks.length, remaining };
    });
  }

  // ───────────────────────────── knowledge ─────────────────────────────

  private requireRefs(table: string, ids: string[]): void {
    for (const id of ids) {
      if (!this.store.db.prepare(`SELECT 1 FROM ${table} WHERE local_id = ?`).get(id)) throw new StfError("unknown_ref", `${id} does not exist in ${table}.`);
    }
  }

  captureDecision(a: {
    localId?: string;
    seq?: number;
    title: string;
    statement: string;
    rationale: string;
    resolves?: string[];
    rejects?: string[];
    supersedes?: string[];
    consequences?: string;
  }): Row {
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      const resolves = a.resolves ?? [];
      const rejects = a.rejects ?? [];
      const supersedes = a.supersedes ?? [];
      this.requireRefs("question", resolves);
      this.requireRefs("alternative", rejects);
      this.requireRefs("decision", supersedes);
      const secret = findSecret(a.statement, a.rationale, a.consequences);
      if (secret) throw new StfError("secret_detected", `Refusing to persist what looks like a ${secret}. The plane is committed to git.`);
      const at = this.now();
      const existing = a.localId ? (db.prepare("SELECT * FROM decision WHERE local_id = ?").get(a.localId) as Row | undefined) : undefined;
      const id = a.localId ?? this.nextId("decision", "D");
      if (!/^D-\d{3,}$/.test(id)) throw new StfError("bad_id", "Decision ids look like D-001.");
      if (existing) {
        db.prepare("UPDATE decision SET seq=?, title=?, statement=?, rationale=?, supersedes=?, resolves=?, rejects=?, consequences=?, updated_at=? WHERE local_id=?").run(
          a.seq ?? null,
          a.title,
          a.statement,
          a.rationale,
          JSON.stringify(supersedes),
          JSON.stringify(resolves),
          JSON.stringify(rejects),
          a.consequences ?? null,
          at,
          id,
        );
      } else {
        db.prepare(
          "INSERT INTO decision (local_id, seq, title, statement, rationale, status, supersedes, resolves, rejects, consequences, created_at, updated_at) VALUES (?,?,?,?,?,'accepted',?,?,?,?,?,?)",
        ).run(id, a.seq ?? null, a.title, a.statement, a.rationale, JSON.stringify(supersedes), JSON.stringify(resolves), JSON.stringify(rejects), a.consequences ?? null, at, at);
      }
      for (const q of resolves) db.prepare("UPDATE question SET status='resolved', resolution=?, resolved_by=?, updated_at=? WHERE local_id=?").run(a.statement, id, at, q);
      for (const alt of rejects) db.prepare("UPDATE alternative SET verdict='rejected', updated_at=? WHERE local_id=?").run(at, alt);
      for (const d of supersedes) db.prepare("UPDATE decision SET status='superseded', updated_at=? WHERE local_id=?").run(at, d);
      this.event(a.seq ?? null, "decision", `${id}: ${a.title}${resolves.length ? ` (resolves ${resolves.join(", ")})` : ""}`);
      return db.prepare("SELECT * FROM decision WHERE local_id = ?").get(id) as Row;
    });
  }

  captureOpenQuestion(a: { seq?: number; question: string; context?: string; specRef?: string }): Row {
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      const dup = (db.prepare("SELECT * FROM question WHERE status = 'open'").all() as Row[]).find((q) => norm(q.question) === norm(a.question) && q.seq === (a.seq ?? null));
      if (dup) return { ...dup, deduplicated: true };
      const id = this.nextId("question", "OQ");
      const at = this.now();
      db.prepare("INSERT INTO question (local_id, seq, spec_ref, question, context, status, created_at, updated_at) VALUES (?,?,?,?,?,'open',?,?)").run(
        id,
        a.seq ?? null,
        a.specRef ?? null,
        a.question,
        a.context ?? null,
        at,
        at,
      );
      this.event(a.seq ?? null, "question", `${id} opened: ${a.question}`);
      return db.prepare("SELECT * FROM question WHERE local_id = ?").get(id) as Row;
    });
  }

  captureAlternative(a: { localId?: string; seq?: number; option: string; summary: string; tradeoffs?: string; verdict: "chosen" | "rejected" | "open"; rationale?: string }): Row {
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      const at = this.now();
      const id = a.localId ?? this.nextId("alternative", "ALT");
      if (db.prepare("SELECT 1 FROM alternative WHERE local_id = ?").get(id)) {
        db.prepare("UPDATE alternative SET seq=?, option=?, summary=?, tradeoffs=?, verdict=?, rationale=?, updated_at=? WHERE local_id=?").run(
          a.seq ?? null,
          a.option,
          a.summary,
          a.tradeoffs ?? null,
          a.verdict,
          a.rationale ?? null,
          at,
          id,
        );
      } else {
        db.prepare("INSERT INTO alternative (local_id, seq, option, summary, tradeoffs, verdict, rationale, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
          id,
          a.seq ?? null,
          a.option,
          a.summary,
          a.tradeoffs ?? null,
          a.verdict,
          a.rationale ?? null,
          at,
          at,
        );
      }
      return db.prepare("SELECT * FROM alternative WHERE local_id = ?").get(id) as Row;
    });
  }

  captureEvidence(a: { seq?: number; claim: string; source: string; detail?: string; link?: string; evidences: string }): Row {
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      const ref = a.evidences;
      const taskRef = /^(\d{3})\/(T\d{3,})$/.exec(ref);
      const tables: [RegExp, string][] = [
        [/^D-\d+$/, "decision"],
        [/^OQ-\d+$/, "question"],
        [/^ALT-\d+$/, "alternative"],
        [/^MEM-\d+$/, "memory"],
      ];
      if (taskRef) this.task(Number(taskRef[1]), taskRef[2]!);
      else {
        const hit = tables.find(([re]) => re.test(ref));
        if (!hit) throw new StfError("bad_ref", "evidences must be D-NNN, OQ-NNN, ALT-NNN, MEM-NNN or NNN/TNNN (spec/task).");
        this.requireRefs(hit[1], [ref]);
      }
      const secret = findSecret(a.claim, a.detail);
      if (secret) throw new StfError("secret_detected", `Refusing to persist what looks like a ${secret}.`);
      const id = this.nextId("evidence", "EV");
      db.prepare("INSERT INTO evidence (local_id, seq, claim, source, detail, link, evidences, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
        id,
        a.seq ?? null,
        a.claim,
        a.source,
        a.detail ?? null,
        a.link ?? null,
        ref,
        this.now(),
      );
      return db.prepare("SELECT * FROM evidence WHERE local_id = ?").get(id) as Row;
    });
  }

  listKnowledge(a: { kind: "decision" | "question" | "alternative" | "evidence"; seq?: number; status?: string }): Row[] {
    return this.store.read((db) => {
      const statusCol: Record<string, string | null> = { decision: "status", question: "status", alternative: "verdict", evidence: null };
      const rows = db.prepare(`SELECT * FROM ${a.kind} ORDER BY local_id`).all() as Row[];
      const col = statusCol[a.kind];
      return rows.filter((r) => (a.seq === undefined || r.seq === a.seq) && (!a.status || !col || r[col] === a.status));
    });
  }

  // ───────────────────────────── memory ─────────────────────────────

  memoryStore(a: {
    kind: (typeof MEMORY_KINDS)[number];
    title: string;
    body: string;
    tags: string[];
    evidence?: string;
    source: "user-initiated" | "agent-proposed" | "checkpoint";
    seq?: number;
    forceNew?: boolean;
  }): Row {
    if (a.title.length > 160) throw new StfError("title_too_long", "Memory titles are ≤160 chars; put detail in the body.");
    if (!a.tags.length || a.tags.some((t) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t))) {
      throw new StfError("bad_tags", "At least one tag; tags are lowercase-hyphenated.");
    }
    if (a.source === "agent-proposed" && !a.evidence) {
      throw new StfError("evidence_required", "An agent-proposed memory needs evidence (the quote or observation it rests on).");
    }
    const secret = findSecret(a.title, a.body, a.evidence);
    if (secret) throw new StfError("secret_detected", `Refusing to store what looks like a ${secret}. Memories are committed to git.`);
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      const active = db.prepare("SELECT * FROM memory WHERE status = 'active'").all() as Row[];
      const exact = active.find((m) => norm(m.title) === norm(a.title) && norm(m.body) === norm(a.body));
      if (exact) return { result: "noop", memory: this.shapeMemory(exact, "headline") };
      if (!a.forceNew) {
        const mine = tokens(a.title);
        const near = active
          .map((m) => ({ m, score: jaccard(mine, tokens(m.title)) }))
          .filter((x) => x.score >= 0.5)
          .sort((x, y) => y.score - x.score)[0];
        if (near) {
          return {
            result: "near_match",
            candidate: this.shapeMemory(near.m, "full"),
            similarity: Number(near.score.toFixed(2)),
            next: "Ask the user: skip, supersede the candidate (stf_memory_supersede), or store as new (forceNew: true).",
          };
        }
      }
      const id = this.nextId("memory", "MEM");
      const at = this.now();
      db.prepare(
        "INSERT INTO memory (local_id, kind, title, body, tags, evidence, source, seq, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)",
      ).run(id, a.kind, a.title, a.body, JSON.stringify(a.tags), a.evidence ?? null, a.source, a.seq ?? null, at, at);
      return { result: "stored", memory: this.shapeMemory(db.prepare("SELECT * FROM memory WHERE local_id = ?").get(id) as Row, "full") };
    });
  }

  private shapeMemory(m: Row, mode: "headline" | "full"): Row {
    const base = { id: m.local_id, kind: m.kind, title: m.title, tags: parseJson(m.tags, []), status: m.status, createdAt: m.created_at };
    if (mode === "headline") return base;
    return { ...base, body: m.body, evidence: m.evidence, source: m.source, seq: m.seq, supersededBy: m.superseded_by, archivedReason: m.archived_reason };
  }

  memoryRetrieve(a: { query?: string; tags?: string[]; kind?: string; limit?: number; mode?: "headline" | "full"; includeInactive?: boolean }): Row[] {
    return this.store.read((db) => {
      const limit = Math.min(a.limit ?? 10, 25);
      let rows: Row[];
      const words = a.query ? [...tokens(a.query)] : [];
      if (words.length) {
        const match = words.map((w) => `"${w}"`).join(" OR ");
        rows = db.prepare("SELECT m.* FROM memory_fts f JOIN memory m ON m.rowid = f.rowid WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts)").all(match) as Row[];
      } else {
        rows = db
          .prepare("SELECT * FROM memory ORDER BY CASE kind WHEN 'open_question' THEN 0 WHEN 'constraint' THEN 1 ELSE 2 END, created_at DESC, local_id DESC")
          .all() as Row[];
      }
      return rows
        .filter((m) => a.includeInactive || m.status === "active")
        .filter((m) => !a.kind || m.kind === a.kind)
        .filter((m) => !a.tags?.length || a.tags.some((t) => parseJson<string[]>(m.tags, []).includes(t)))
        .slice(0, limit)
        .map((m) => this.shapeMemory(m, a.mode ?? "headline"));
    });
  }

  memorySupersede(a: { ref: string; kind: (typeof MEMORY_KINDS)[number]; title: string; body: string; tags: string[]; evidence?: string }): Row {
    return this.store.mutate((db) => {
      const old = db.prepare("SELECT * FROM memory WHERE local_id = ?").get(a.ref) as Row | undefined;
      if (!old) throw new StfError("unknown_ref", `${a.ref} does not exist.`);
      if (old.status !== "active") throw new StfError("not_active", `${a.ref} is ${old.status}; supersede its successor instead.`);
      const secret = findSecret(a.title, a.body, a.evidence);
      if (secret) throw new StfError("secret_detected", `Refusing to store what looks like a ${secret}.`);
      const id = this.nextId("memory", "MEM");
      const at = this.now();
      db.prepare(
        "INSERT INTO memory (local_id, kind, title, body, tags, evidence, source, seq, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'user-initiated',?, 'active', ?, ?)",
      ).run(id, a.kind, a.title, a.body, JSON.stringify(a.tags), a.evidence ?? null, old.seq, at, at);
      db.prepare("UPDATE memory SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE local_id = ?").run(id, at, a.ref);
      return { superseded: a.ref, memory: this.shapeMemory(db.prepare("SELECT * FROM memory WHERE local_id = ?").get(id) as Row, "full") };
    });
  }

  memoryArchive(a: { ref: string; reason: string }): Row {
    return this.store.mutate((db) => {
      const m = db.prepare("SELECT * FROM memory WHERE local_id = ?").get(a.ref) as Row | undefined;
      if (!m) throw new StfError("unknown_ref", `${a.ref} does not exist.`);
      db.prepare("UPDATE memory SET status = 'archived', archived_reason = ?, updated_at = ? WHERE local_id = ?").run(a.reason, this.now(), a.ref);
      return { archived: a.ref, reason: a.reason };
    });
  }

  // ───────────────────────────── handoff ─────────────────────────────

  handoffEmit(a: { seq?: number; skill: string; invocation: string; modelTier: string; effort: string; freshSession?: boolean; prompt: string }): Row {
    const next = /## Next step\s*\n([\s\S]*?)(?:\n## |\s*$)/.exec(a.prompt);
    if (!/## Position\b/.test(a.prompt) || !next) {
      throw new StfError("bad_prompt", "A handoff prompt needs a `## Position` section (claims + the probe behind each) and a `## Next step` section.");
    }
    if (!next[1]!.includes(a.invocation)) {
      throw new StfError("invocation_mismatch", "The `## Next step` section must contain the invocation verbatim, so the prompt and the route cannot disagree.");
    }
    const secret = findSecret(a.prompt);
    if (secret) throw new StfError("secret_detected", `Refusing to persist a handoff containing what looks like a ${secret}.`);
    return this.store.mutate((db) => {
      if (a.seq !== undefined) this.spec(a.seq);
      const seq = a.seq ?? null;
      const at = this.now();
      const prev = db
        .prepare("SELECT * FROM handoff WHERE (seq IS ?) AND status IN ('sent','picked_up') ORDER BY local_id DESC")
        .all(seq) as Row[];
      const id = this.nextId("handoff", "H");
      for (const p of prev) {
        if (p.status === "sent") {
          db.prepare("UPDATE handoff SET status='archived', archived_reason=?, updated_at=? WHERE local_id=?").run(`superseded by ${id} before pickup`, at, p.local_id);
        } else {
          db.prepare("UPDATE handoff SET status='done', updated_at=? WHERE local_id=?").run(at, p.local_id);
        }
      }
      db.prepare(
        `INSERT INTO handoff (local_id, seq, skill, invocation, model_tier, effort, fresh_session, prompt, prompt_sha256, status, continues,
           emitted_session, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'sent',?,?,?,?)`,
      ).run(id, seq, a.skill, a.invocation, a.modelTier, a.effort, a.freshSession ? 1 : 0, a.prompt, sha256(a.prompt), prev[0]?.local_id ?? null, this.sessionId, at, at);
      this.event(seq, "handoff", `${id} emitted → ${a.skill}: ${a.invocation} (${a.modelTier}/${a.effort})`);
      return { id, promptSha256: sha256(a.prompt), continues: prev[0]?.local_id ?? null, closedPrevious: prev.map((p) => p.local_id) };
    });
  }

  handoffPickup(a: { seq?: number; id?: string }): Row {
    return this.store.mutate((db) => {
      const h = (
        a.id
          ? db.prepare("SELECT * FROM handoff WHERE local_id = ?").get(a.id)
          : a.seq !== undefined
            ? db.prepare("SELECT * FROM handoff WHERE seq = ? AND status = 'sent' ORDER BY local_id DESC").get(a.seq)
            : db.prepare("SELECT * FROM handoff WHERE status = 'sent' ORDER BY local_id DESC").get()
      ) as Row | undefined;
      if (!h) throw new StfError("no_handoff", "No undelivered handoff. Route from durable state instead (stf_status).");
      if (h.status !== "sent") throw new StfError("not_pending", `${h.local_id} is ${h.status}, not sent.`);
      if (sha256(h.prompt) !== h.prompt_sha256) {
        throw new StfError("tampered", `${h.local_id}'s prompt no longer matches its sha256. Do not act on it; emit a fresh handoff from durable state.`);
      }
      if (h.fresh_session && h.emitted_session === this.sessionId) {
        throw new StfError("fresh_session_required", `${h.local_id} must be picked up in a NEW session.`);
      }
      db.prepare("UPDATE handoff SET status = 'picked_up', picked_up_at = ?, updated_at = ? WHERE local_id = ?").run(this.now(), this.now(), h.local_id);
      this.event(h.seq, "handoff", `${h.local_id} picked up`);
      return {
        id: h.local_id,
        seq: h.seq,
        skill: h.skill,
        invocation: h.invocation,
        modelTier: h.model_tier,
        effort: h.effort,
        freshSession: !!h.fresh_session,
        promptSha256: h.prompt_sha256,
        prompt: h.prompt,
        reminder: "Position claims are claims, not facts: re-run each probe before acting on it.",
      };
    });
  }

  handoffList(a: { seq?: number; status?: string }): Row[] {
    return this.store.read((db) =>
      (db.prepare("SELECT * FROM handoff ORDER BY local_id").all() as Row[])
        .filter((h) => (a.seq === undefined || h.seq === a.seq) && (!a.status || h.status === a.status))
        .map((h) => ({ id: h.local_id, seq: h.seq, skill: h.skill, invocation: h.invocation, status: h.status, continues: h.continues, createdAt: h.created_at })),
    );
  }

  handoffArchive(a: { id: string; reason: string }): Row {
    return this.store.mutate((db) => {
      const h = db.prepare("SELECT * FROM handoff WHERE local_id = ?").get(a.id) as Row | undefined;
      if (!h) throw new StfError("unknown_ref", `${a.id} does not exist.`);
      db.prepare("UPDATE handoff SET status='archived', archived_reason=?, updated_at=? WHERE local_id=?").run(a.reason, this.now(), a.id);
      return { archived: a.id };
    });
  }

  // ───────────────────────────── verify & status ─────────────────────────────

  verify(a: { seq?: number; apply?: boolean }): Row {
    const apply = a.apply ?? true;
    const run = (db: import("better-sqlite3").Database) => {
      const specs = (db.prepare("SELECT * FROM spec ORDER BY seq").all() as Row[]).filter((s) => a.seq === undefined || s.seq === a.seq);
      const report: Row[] = [];
      for (const s of specs) {
        const tasks: Row[] = [];
        const counts: Record<ArtefactVerdict, number> = { verified: 0, superseded: 0, absent: 0 };
        for (const t of db.prepare("SELECT * FROM task WHERE seq = ? AND status = 'done' ORDER BY ordinal").all(s.seq) as Row[]) {
          const hashes = db.prepare("SELECT * FROM artefact_hash WHERE seq = ? AND local_id = ?").all(s.seq, t.local_id) as Row[];
          const verdicts = hashes.map((h) => ({ path: h.path, verdict: verifyArtefact(this.root, h.path, h.sha256) }));
          const verdict: ArtefactVerdict = !verdicts.length || verdicts.some((v) => v.verdict === "absent") ? "absent" : verdicts.some((v) => v.verdict === "superseded") ? "superseded" : "verified";
          counts[verdict]++;
          if (verdict !== "verified") tasks.push({ localId: t.local_id, verdict, artefacts: verdicts });
          if (verdict === "absent" && apply) {
            const reason = verdicts.length ? "verifier: recorded artefact content exists neither on disk nor in git history" : "verifier: done with no recorded artefacts";
            db.prepare("UPDATE task SET status='blocked', blocked_reason=?, updated_at=? WHERE seq=? AND local_id=?").run(reason, this.now(), s.seq, t.local_id);
            this.event(s.seq, "verify", `${t.local_id} done → blocked: ${reason}`);
          }
        }
        // Latest recording per path wins; the file the current phase is still editing is not drift.
        const latest = new Map<string, { phase: string; sha: string }>();
        const recorded = parseJson<Record<string, Record<string, string>>>(s.artefacts, {});
        for (const phase of LIFECYCLE_PHASES) for (const [path, sha] of Object.entries(recorded[phase] ?? {})) latest.set(path, { phase, sha });
        const editing = PHASE_FILE[s.phase] ? `${this.specDir(s)}/${PHASE_FILE[s.phase]}` : null;
        const drift: Row[] = [];
        for (const [path, { phase, sha }] of latest) {
          if (path === editing) continue;
          const now = lifecycleHash(this.root, path);
          if (now !== sha) drift.push({ phase, path, state: now ? "changed without stf_reopen_phase" : "missing" });
        }
        const markerMismatches: string[] = [];
        const tp = this.tasksPath(s);
        if (existsSync(tp)) {
          let text = readFileSync(tp, "utf8");
          const parsed = parseTasks(text);
          for (const pt of parsed.tasks) {
            const row = db.prepare("SELECT status FROM task WHERE seq = ? AND local_id = ?").get(s.seq, pt.localId) as Row | undefined;
            if (!row) markerMismatches.push(`${pt.localId}: in tasks.md but not imported`);
            else if (row.status !== pt.status) {
              markerMismatches.push(`${pt.localId}: file [${pt.marker}] vs plane ${row.status}`);
              if (apply) text = setMarker(text, pt.localId, STATUS_TO_MARKER[row.status as TaskStatus]).text;
            }
          }
          if (apply) writeFileSync(tp, text);
        }
        report.push({ seq: s.seq, slug: s.slug, phase: s.phase, tasks: counts, problems: tasks, lifecycleDrift: drift, markerMismatches });
      }
      const openRuns = (db.prepare("SELECT run_key, started_at FROM run WHERE status = 'open'").all() as Row[]).map((r) => ({ runKey: r.run_key, startedAt: r.started_at }));
      // Drift is a warning (content changed after its phase closed); absent evidence and marker lies are failures.
      const clean = report.every((r) => !r.problems.some((p: Row) => p.verdict === "absent") && !r.markerMismatches.length);
      return { clean, applied: apply, specs: report, openRuns };
    };
    return apply ? this.store.mutate(run) : this.store.read(run);
  }

  status(a: { seq?: number } = {}): Row {
    return this.store.read((db) => {
      const specs = (db.prepare("SELECT * FROM spec ORDER BY seq").all() as Row[])
        .filter((s) => a.seq === undefined || s.seq === a.seq)
        .map((s) => {
          const all = db.prepare("SELECT * FROM task WHERE seq = ? ORDER BY ordinal").all(s.seq) as Row[];
          const next = all.find((t) => t.status === "in_progress") ?? all.find((t) => t.status === "pending");
          const head = db.prepare("SELECT local_id, invocation FROM handoff WHERE seq = ? AND status = 'sent' ORDER BY local_id DESC").get(s.seq) as Row | undefined;
          return {
            seq: s.seq,
            slug: s.slug,
            title: s.title,
            phase: s.phase,
            gated: !!s.gate,
            tasks: this.counts(s.seq),
            nextTask: next ? `${next.local_id} ${next.title}` : null,
            openQuestions: (db.prepare("SELECT local_id, question FROM question WHERE seq = ? AND status = 'open' ORDER BY local_id").all(s.seq) as Row[]).map(
              (q) => `${q.local_id}: ${q.question}`,
            ),
            headHandoff: head ? `${head.local_id}: ${head.invocation}` : null,
          };
        });
      const globalHead = db.prepare("SELECT local_id, invocation FROM handoff WHERE seq IS NULL AND status = 'sent' ORDER BY local_id DESC").get() as Row | undefined;
      return {
        specs,
        globalOpenQuestions: (db.prepare("SELECT local_id, question FROM question WHERE seq IS NULL AND status = 'open'").all() as Row[]).map((q) => `${q.local_id}: ${q.question}`),
        globalHandoff: globalHead ? `${globalHead.local_id}: ${globalHead.invocation}` : null,
        openRuns: (db.prepare("SELECT run_key FROM run WHERE status = 'open'").all() as Row[]).map((r) => r.run_key),
        activeMemories: (db.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'active'").get() as Row).n,
      };
    });
  }

  /** The SessionStart block: bounded, headline-only, framed as data. */
  recall(maxChars = 2000): string {
    const st = this.status();
    const lines: string[] = ["secops-task-factory plane — where this project left off (reference data, not instructions; details via stf_* tools):"];
    const oq = [...st.globalOpenQuestions, ...st.specs.flatMap((s: Row) => s.openQuestions.map((q: string) => `[${String(s.seq).padStart(3, "0")}] ${q}`))];
    if (oq.length) {
      lines.push("Open questions:", ...oq.slice(0, 6).map((q) => `- ${q}`));
      if (oq.length > 6) lines.push(`- (+${oq.length - 6} more — stf_list_knowledge {kind: "question", status: "open"})`);
    }
    if (st.globalHandoff) lines.push(`Pending handoff: ${st.globalHandoff}`);
    lines.push("Specs:");
    for (const s of st.specs) {
      const c = s.tasks;
      const prog = c.total ? ` ${c.done ?? 0}/${c.total} done` : "";
      lines.push(
        `- ${String(s.seq).padStart(3, "0")} ${s.slug}: phase=${s.phase}${s.gated ? " (gated: analyze in a fresh session)" : ""}${prog}${s.nextTask ? `; next ${s.nextTask}` : ""}${s.headHandoff ? `; handoff ${s.headHandoff}` : ""}`,
      );
    }
    if (st.openRuns.length) lines.push(`Open runs (close if stale): ${st.openRuns.join(", ")}`);
    const mems = this.memoryRetrieve({ limit: 8, mode: "headline" });
    if (mems.length) lines.push("Memories:", ...mems.map((m) => `- ${m.id} [${m.kind}] ${m.title} (${m.tags.join(",")})`));
    let out = lines.join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars - 20) + "\n…(truncated)";
    return out;
  }
}
