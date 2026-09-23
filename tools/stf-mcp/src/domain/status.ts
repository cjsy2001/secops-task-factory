export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Single-step transitions an agent may request through stf_set_task_status.
 * `done` is deliberately absent as a target: the only road to done is
 * stf_capture_task_outcome, which demands output + hashed artefacts.
 * done -> blocked exists only for the verifier (evidence vanished), never for callers.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["blocked", "cancelled", "pending"],
  blocked: ["in_progress", "cancelled"],
  done: ["in_progress"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Outcome capture may close a task that is pending, in progress, or blocked. */
export function canComplete(from: TaskStatus): boolean {
  return from === "pending" || from === "in_progress" || from === "blocked";
}

export const MARKER_TO_STATUS: Record<string, TaskStatus> = {
  " ": "pending",
  "~": "in_progress",
  "!": "blocked",
  X: "done",
  x: "done",
  "-": "cancelled",
};

export const STATUS_TO_MARKER: Record<TaskStatus, string> = {
  pending: " ",
  in_progress: "~",
  blocked: "!",
  done: "X",
  cancelled: "-",
};

export const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const LIFECYCLE_PHASES = ["specify", "clarify", "plan", "tasks", "analyze", "done"] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];
