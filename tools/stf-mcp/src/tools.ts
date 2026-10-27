import { z } from "zod";
import type { Factory } from "./factory.js";
import { MEMORY_KINDS } from "./factory.js";
import { EFFORTS, LIFECYCLE_PHASES, MODEL_TIERS, TASK_STATUSES } from "./domain/status.js";

/**
 * One tool = one Factory method. No logic lives here beyond argument shapes:
 * the rules are in factory.ts so the CLI and tests exercise the same code.
 * The authoritative tool list is asserted in tests/contract.test.ts.
 */
export interface ToolDef {
  name: string;
  group: string;
  description: string;
  input: z.ZodRawShape;
  run: (f: Factory, args: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  readOnly?: boolean;
}

const seq = z.number().int().positive().describe("Spec sequence number (stable identity), e.g. 1 for specs/001-*");
const optSeq = seq.optional();
const localId = z.string().regex(/^T\d{3,}$/).describe("Task id within the spec, e.g. T001");
const runKey = z.string().describe("The runKey returned by stf_start_run in THIS session");
const expectTitle = z.string().min(3).describe("The task title as you believe it to be — the write is refused if it does not match the plane (wrong-row guard)");
const tier = z.enum(MODEL_TIERS);
const effort = z.enum(EFFORTS);
const memKind = z.enum(MEMORY_KINDS);
const tags = z.array(z.string()).min(1).describe("lowercase-hyphenated tags");

export const allTools: ToolDef[] = [
  // ── spec / lifecycle
  {
    name: "stf_charter_spec",
    group: "spec",
    description: "Register a new spec (allocates its seq, creates specs/NNN-slug/). Phase starts at specify.",
    input: { slug: z.string(), title: z.string(), summary: z.string().min(10) },
    run: (f, a) => f.charterSpec(a),
  },
  { name: "stf_list_specs", group: "spec", readOnly: true, description: "List every spec with its lifecycle phase and task counts.", input: {}, run: (f) => f.listSpecs() },
  {
    name: "stf_get_spec",
    group: "spec",
    readOnly: true,
    description: "One spec: phase, session gate, recorded artefact hashes, which files exist, task counts.",
    input: { seq },
    run: (f, a) => f.getSpec(a),
  },
  {
    name: "stf_advance_phase",
    group: "spec",
    description:
      "Mark the CURRENT lifecycle phase complete (specify→clarify→plan→tasks→analyze→done). The server hashes the artefacts, enforces order, " +
      "sets the session gate after tasks, and refuses analyze in the session that set the gate or with health <80 / any High finding.",
    input: {
      seq,
      phase: z.enum(LIFECYCLE_PHASES),
      runKey,
      artefacts: z.array(z.string()).describe("Files this phase produced; relative to the spec dir or repo root"),
      healthScore: z.number().min(0).max(100).optional().describe("analyze only"),
      highFindings: z.number().int().min(0).optional().describe("analyze only: count of real High/Critical findings"),
      reportPath: z.string().optional().describe("analyze only: the analysis/*.md report"),
    },
    run: (f, a) => f.advancePhase(a),
  },
  {
    name: "stf_reopen_phase",
    group: "spec",
    description: "Rewind a spec to an earlier phase (e.g. an amendment after plan). Clears downstream artefact hashes, the gate and the health score.",
    input: { seq, phase: z.enum(LIFECYCLE_PHASES), reason: z.string().min(10), runKey },
    run: (f, a) => f.reopenPhase(a),
  },
  {
    name: "stf_move_spec",
    group: "spec",
    description:
      "Mark a spec as moved to another repo's plane (e.g. per D-004). Keeps its questions, decisions, events and evidence here; afterwards every " +
      "lifecycle, task, run, capture and handoff write on it is refused, and status/recall/pages show \"moved → <repo>\". Refused while a run on it is open.",
    input: {
      seq,
      repo: z.string().describe("GitHub owner/name it moved to, e.g. cjsy2001/devsecops-pipeline"),
      targetSeq: z.number().int().positive().describe("The spec's seq in that repo's plane"),
      decision: z.string().regex(/^D-\d{3,}$/).describe("The decision that moved it, e.g. D-004"),
      reason: z.string().min(10),
    },
    run: (f, a) => f.moveSpec(a),
  },

  // ── tasks
  {
    name: "stf_import_tasks",
    group: "task",
    description:
      "Parse specs/NNN-slug/tasks.md and upsert tasks on (seq, localId). Never deletes, never changes a status; re-mirrors every marker from the plane " +
      "(a hand-flipped [X] is reverted). Reports tasks missing from the file.",
    input: { seq },
    run: (f, a) => f.importTasks(a),
  },
  {
    name: "stf_list_tasks",
    group: "task",
    readOnly: true,
    description: "Tasks of a spec in file order, with objective, executionPlan, modelTier, effort and output.",
    input: { seq, status: z.enum(TASK_STATUSES).optional(), phase: z.string().optional() },
    run: (f, a) => f.listTasks(a),
  },
  {
    name: "stf_get_task",
    group: "task",
    readOnly: true,
    description: "One task including its recorded artefact hashes. Read this before any status write.",
    input: { seq, localId },
    run: (f, a) => f.getTask(a),
  },
  {
    name: "stf_next_task",
    group: "task",
    readOnly: true,
    description: "What to work on: the in-progress task if any, else the first pending one in file order; plus blockers and counts.",
    input: { seq },
    run: (f, a) => f.nextTask(a),
  },
  {
    name: "stf_set_task_status",
    group: "task",
    description: "Move a task to in_progress / blocked / cancelled / pending (or reopen a done one to in_progress). NOT for done — use stf_capture_task_outcome.",
    input: { seq, localId, status: z.enum(TASK_STATUSES), expectTitle, reason: z.string().optional().describe("required for blocked") },
    run: (f, a) => f.setTaskStatus(a),
  },
  {
    name: "stf_capture_task_outcome",
    group: "task",
    description:
      "The ONLY way a task becomes done. Requires an open run, a real output summary, and ≥1 artefact file; the server sha256-hashes each file " +
      "as evidence that stf_verify re-checks every session.",
    input: {
      seq,
      localId,
      expectTitle,
      runKey,
      output: z.string().describe("What was done and how it was verified (test names, commands, results)"),
      artefacts: z.array(z.string()).min(1).describe("Repo-relative files this task produced or changed"),
      testsCommand: z.string().optional().describe("The exact command that proved it"),
    },
    run: (f, a) => f.captureTaskOutcome(a),
  },
  {
    name: "stf_set_task_model",
    group: "task",
    description: "Set a task's modelTier/effort (the contract for who should do the work).",
    input: { seq, localId, modelTier: tier, effort },
    run: (f, a) => f.setTaskModel(a),
  },

  // ── runs / trace
  {
    name: "stf_start_run",
    group: "run",
    description: "Open a run for this session (server mints the runKey). Every lifecycle/task write needs one. Reports other open runs on the same spec.",
    input: { seq: optSeq, kind: z.enum(["lifecycle", "implement", "analyze", "other"]), summary: z.string().optional() },
    run: (f, a) => f.startRun(a),
  },
  {
    name: "stf_complete_run",
    group: "run",
    description: "Close a run as completed or failed with a one-line summary.",
    input: { runKey, outcome: z.enum(["completed", "failed"]), summary: z.string().min(5) },
    run: (f, a) => f.completeRun(a),
  },
  {
    name: "stf_append_event",
    group: "run",
    description: "Append a trace event (stored verbatim) to the plane's event log.",
    input: { seq: optSeq, kind: z.string(), summary: z.string().min(5), runKey: runKey.optional() },
    run: (f, a) => f.appendEvent(a),
  },
  {
    name: "stf_checkpoint",
    group: "run",
    description:
      "Record a phase boundary during implementation. The server computes complete|partial from task statuses, and refuses a commitSha that does not exist in git.",
    input: {
      seq,
      runKey,
      phase: z.string().describe("Exact phase heading from tasks.md, e.g. 'Phase 1: Setup'"),
      testsPassed: z.boolean(),
      testsCommand: z.string().optional(),
      commitSha: z.string().optional(),
      notes: z.string().optional(),
    },
    run: (f, a) => f.checkpoint(a),
  },

  // ── knowledge
  {
    name: "stf_capture_decision",
    group: "knowledge",
    description: "Record a decision (D-NNN). resolves[] flips open questions to resolved; rejects[] flips alternatives to rejected; supersedes[] retires older decisions; corrects[] points at decisions or alternatives (D-/ALT-) this one corrects without retiring them.",
    input: {
      localId: z.string().optional().describe("Pass to update an existing D-NNN; omit to allocate"),
      seq: optSeq,
      title: z.string(),
      statement: z.string(),
      rationale: z.string(),
      resolves: z.array(z.string()).optional(),
      rejects: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional(),
      corrects: z.array(z.string()).optional().describe("D-/ALT- ids this decision corrects; they keep their status (use supersedes to retire a decision)"),
      consequences: z.string().optional(),
    },
    run: (f, a) => f.captureDecision(a),
  },
  {
    name: "stf_capture_open_question",
    group: "knowledge",
    description: "Record an open question (OQ-NNN). Deduplicates an identical open question in the same scope.",
    input: { seq: optSeq, question: z.string().min(10), context: z.string().optional(), specRef: z.string().optional().describe("e.g. Q-002 in spec.md") },
    run: (f, a) => f.captureOpenQuestion(a),
  },
  {
    name: "stf_capture_alternative",
    group: "knowledge",
    description: "Record an option that was considered (ALT-NNN) with its trade-offs and verdict.",
    input: {
      localId: z.string().optional(),
      seq: optSeq,
      option: z.string(),
      summary: z.string(),
      tradeoffs: z.string().optional(),
      verdict: z.enum(["chosen", "rejected", "open"]),
      rationale: z.string().optional(),
    },
    run: (f, a) => f.captureAlternative(a),
  },
  {
    name: "stf_capture_evidence",
    group: "knowledge",
    description: "Attach evidence (EV-NNN) to a decision, question, alternative, memory, or task (NNN/TNNN). The referenced item must exist.",
    input: { seq: optSeq, claim: z.string(), source: z.string().describe("Where it came from: command, URL, file:line"), detail: z.string().optional(), link: z.string().optional(), evidences: z.string() },
    run: (f, a) => f.captureEvidence(a),
  },
  {
    name: "stf_list_knowledge",
    group: "knowledge",
    readOnly: true,
    description: "List decisions, questions, alternatives or evidence, optionally by spec and status/verdict.",
    input: { kind: z.enum(["decision", "question", "alternative", "evidence"]), seq: optSeq, status: z.string().optional() },
    run: (f, a) => f.listKnowledge(a),
  },

  // ── memory
  {
    name: "stf_memory_store",
    group: "memory",
    description:
      "Store a durable cross-session memory (MEM-NNN). Returns stored | noop | near_match; on near_match ask the user (skip / supersede / forceNew). " +
      "Agent-proposed memories need evidence and the user's yes. Refuses anything that looks like a secret.",
    input: {
      kind: memKind,
      title: z.string(),
      body: z.string().min(10).describe("Self-contained: readable with no other context"),
      tags,
      evidence: z.string().optional(),
      source: z.enum(["user-initiated", "agent-proposed", "checkpoint"]),
      seq: optSeq,
      forceNew: z.boolean().optional(),
    },
    run: (f, a) => f.memoryStore(a),
  },
  {
    name: "stf_memory_retrieve",
    group: "memory",
    readOnly: true,
    description: "Search memories (full-text) or list by recency (open questions and constraints first). Excludes superseded/archived unless includeInactive.",
    input: {
      query: z.string().optional(),
      tags: z.array(z.string()).optional(),
      kind: memKind.optional(),
      limit: z.number().int().min(1).max(25).optional(),
      mode: z.enum(["headline", "full"]).optional(),
      includeInactive: z.boolean().optional(),
    },
    run: (f, a) => f.memoryRetrieve(a),
  },
  {
    name: "stf_memory_supersede",
    group: "memory",
    description: "Replace a memory with a corrected one; the old one is hidden but kept with a pointer to its successor.",
    input: { ref: z.string(), kind: memKind, title: z.string(), body: z.string().min(10), tags, evidence: z.string().optional() },
    run: (f, a) => f.memorySupersede(a),
  },
  {
    name: "stf_memory_archive",
    group: "memory",
    description: "Archive a memory that is no longer true or useful (non-destructive; reason required).",
    input: { ref: z.string(), reason: z.string().min(5) },
    run: (f, a) => f.memoryArchive(a),
  },

  // ── handoff
  {
    name: "stf_handoff_emit",
    group: "handoff",
    description:
      "Persist the next session's prompt (H-NNN, sha256-sealed). Prompt must have `## Position` (claims + probes) and `## Next step` containing the invocation " +
      "verbatim. Closes the previous head for the same scope.",
    input: {
      seq: optSeq,
      skill: z.string(),
      invocation: z.string().describe("The exact first command the next session runs, e.g. '/stf-implement 1'"),
      modelTier: tier,
      effort,
      freshSession: z.boolean().optional().describe("true when the next step must not run in this session (e.g. analyze)"),
      prompt: z.string().min(40),
    },
    run: (f, a) => f.handoffEmit(a),
  },
  {
    name: "stf_handoff_pickup",
    group: "handoff",
    description: "Pick up the head handoff (for a spec, or by id): verifies its sha256, returns the prompt byte-exact, marks it picked_up.",
    input: { seq: optSeq, id: z.string().optional() },
    run: (f, a) => f.handoffPickup(a),
  },
  {
    name: "stf_handoff_list",
    group: "handoff",
    readOnly: true,
    description: "List the handoff chain (no prompt bodies).",
    input: { seq: optSeq, status: z.enum(["sent", "picked_up", "done", "archived"]).optional() },
    run: (f, a) => f.handoffList(a),
  },
  {
    name: "stf_handoff_archive",
    group: "handoff",
    description: "Archive a handoff that should not be picked up.",
    input: { id: z.string(), reason: z.string().min(5) },
    run: (f, a) => f.handoffArchive(a),
  },

  // ── verify / read
  {
    name: "stf_verify",
    group: "read",
    description:
      "Re-check every done task's evidence: verified (hash matches), superseded (changed later, recorded content in git history), absent (evidence gone → " +
      "task flipped to blocked when apply). Also reports lifecycle artefact drift, tasks.md marker mismatches (re-mirrored when apply) and open runs.",
    input: { seq: optSeq, apply: z.boolean().optional().describe("default true") },
    run: (f, a) => f.verify(a),
  },
  {
    name: "stf_status",
    group: "read",
    readOnly: true,
    description: "Dashboard: per spec phase, gate, task counts, next task, open questions, pending handoff; plus open runs.",
    input: { seq: optSeq },
    run: (f, a) => f.status(a),
  },
];
