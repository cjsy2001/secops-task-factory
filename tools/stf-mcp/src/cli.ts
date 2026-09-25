#!/usr/bin/env node
import { StfError } from "./errors.js";
import { writeDashboard } from "./dashboard.js";
import { Factory } from "./factory.js";
import { writeHub } from "./hub.js";
import { pagesHook, refreshPages } from "./pages.js";
import { newProject } from "./new-project.js";
import { initPlane, resolveRoot } from "./root.js";
import { writeSpecPage } from "./spec-page.js";

const USAGE = `stf <command>
  init [dir]              create an empty plane (.stf/export) at a git repo root (default: $CLAUDE_PROJECT_DIR or cwd)
  recall                  SessionStart block (fail-soft: prints nothing on error, including when there is no plane)
  status [seq]            dashboard JSON
  dashboard [out]         read-only HTML view of the plane (default .stf/dashboard.html, gitignored)
  spec-page <seq> [out]   one spec's artefacts and decisions as a page (default .stf/spec-page-NNN.html)
  hub [out]               hub page linking every status page in .stf/pages.json (default .stf/hub.html)
  pages                   rebuild the dashboard, every spec page and the hub; print what to republish
  verify [seq] [--dry-run]
  import-tasks <seq>
  export                  re-render .stf/export from the loaded state (round-trip check)
  charter <slug> <title> <summary>
  move <seq> <owner/repo> <targetSeq> <D-NNN> <reason>   mark a spec as moved to another repo's plane
  new-project <dir> --name <kebab> --description <text> [--title <spec title>] [--private] [--no-azure]
              [--license mit|none] [--author <name>]
                          scaffold a project repo (git, gitleaks hook + CI, stf config, rules, plane, spec 001); no commit, no network`;

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
  if (cmd === "pages" && rest[0] === "--hook") {
    // the PostToolUse hook (scripts/run.mjs pages-hook): `pages --hook <tool> [seq]`. Answers in hook JSON and never
    // fails the tool call that fired it: every error becomes a one-line notice.
    let out: Record<string, unknown>;
    try {
      const hookSeq = rest[2] && /^\d+$/.test(rest[2]) ? Number(rest[2]) : undefined;
      out = pagesHook(new Factory(resolveRoot()), rest[1] ?? "unknown", hookSeq);
    } catch (e) {
      out = { suppressOutput: true, systemMessage: `status-pages hook failed: ${String(e instanceof Error ? e.message : e).split("\n")[0]}` };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }
  if (cmd === "new-project") {
    const flag = (name: string) => {
      const i = rest.indexOf(`--${name}`);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const dir = rest[0];
    const name = flag("name");
    const description = flag("description");
    const license = flag("license");
    if (!dir || dir.startsWith("--") || !name || !description || (license && license !== "mit" && license !== "none")) {
      process.stderr.write(USAGE + "\n");
      return 2;
    }
    const r = newProject({
      dir,
      name,
      description,
      title: flag("title"),
      author: flag("author"),
      license: license as "mit" | "none" | undefined,
      azure: !rest.includes("--no-azure"),
      visibility: rest.includes("--private") ? "private" : "public",
    });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
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
    case "spec-page":
      if (seq === undefined) break;
      print(writeSpecPage(f, seq, rest.find((r) => r !== seqArg)));
      return 0;
    case "hub":
      print(writeHub(f, rest[0]));
      return 0;
    case "pages": {
      const r = refreshPages(f);
      process.stdout.write([...r.lines, ...r.errors.map((e) => `FAILED ${e}`)].join("\n") + "\n");
      return r.errors.length ? 1 : 0;
    }
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
    case "move": {
      const [s, repo, target, decision, ...reason] = rest;
      if (!s || !/^\d+$/.test(s) || !repo || !target || !/^\d+$/.test(target) || !decision || !reason.length) break;
      print(f.moveSpec({ seq: Number(s), repo, targetSeq: Number(target), decision, reason: reason.join(" ") }));
      return 0;
    }
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
