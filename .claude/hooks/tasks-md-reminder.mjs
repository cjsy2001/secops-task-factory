#!/usr/bin/env node
// PostToolUse: after an edit to specs/*/tasks.md, remind the agent to re-import so the
// plane and the file cannot drift. Fail-soft: any problem → silent exit 0.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const path = JSON.parse(raw)?.tool_input?.file_path ?? "";
    const m = /specs\/(\d{3})-[^/]+\/tasks\.md$/.exec(path);
    if (!m) return;
    const seq = Number(m[1]);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `tasks.md for spec ${seq} changed. Run stf_import_tasks {seq: ${seq}} now. ` +
            "Markers are mirrored FROM the plane: a hand-flipped [X] will be reverted — completion goes through stf_capture_task_outcome.",
        },
      }),
    );
  } catch {
    /* fail-soft */
  }
});
