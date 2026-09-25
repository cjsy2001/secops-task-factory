#!/usr/bin/env node
import { StfError } from "./errors.js";
import { writeDashboard } from "./dashboard.js";
import { Factory } from "./factory.js";
import { initPlane, resolveRoot } from "./root.js";

const USAGE = `stf <command>
  init [dir]              create an empty plane (.stf/export) at a git repo root (default: $CLAUDE_PROJECT_DIR or cwd)
  recall                  SessionStart block (fail-soft: prints nothing on error, including when there is no plane)
  status [seq]            dashboard JSON
  dashboard [out]         read-only HTML view of the plane (default .stf/dashboard.html, gitignored)
  verify [seq] [--dry-run]
  import-tasks <seq>
  export                  re-render .stf/export from the loaded state (round-trip check)
  charter <slug> <title> <summary>`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "recall") {
    try {
      const out = new Factory(resolveRoot()).recall();
      process.stdout.write(out + "\n");
    } catch {
      /* fail-soft: a broken plane must never block a session from starting */
    }
    return 0;
  }
  if (cmd === "init") {
    process.stdout.write(JSON.stringify(initPlane(rest[0] ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()), null, 2) + "\n");
    return 0;
  }
  const f = new Factory(resolveRoot());
  const seqArg = rest.find((r) => /^\d+$/.test(r));
  const seq = seqArg ? Number(seqArg) : undefined;
  const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  switch (cmd) {
    case "status":
      print(f.status({ seq }));
      return 0;
    case "dashboard":
      print(writeDashboard(f, rest[0]));
      return 0;
    case "verify": {
      const r = f.verify({ seq, apply: !rest.includes("--dry-run") });
      print(r);
      return r.clean ? 0 : 5;
    }
    case "import-tasks":
      if (seq === undefined) break;
      print(f.importTasks({ seq }));
      return 0;
    case "export":
      print({ changed: f.store.export() });
      return 0;
    case "charter": {
      const [slug, title, ...summary] = rest;
      if (!slug || !title || !summary.length) break;
      print(f.charterSpec({ slug, title, summary: summary.join(" ") }));
      return 0;
    }
  }
  process.stderr.write(USAGE + "\n");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof StfError) process.stderr.write(`${err.code}: ${err.message}\n${err.detail ? JSON.stringify(err.detail, null, 2) + "\n" : ""}`);
    else process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
    process.exit(1);
  },
);
