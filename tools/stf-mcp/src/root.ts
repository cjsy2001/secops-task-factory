import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StfError } from "./errors.js";
import { Store } from "./store.js";

/**
 * The repository the plane belongs to: $STF_ROOT, else the nearest ancestor of $CLAUDE_PROJECT_DIR (or cwd)
 * holding `.stf/`. There is deliberately no fallback: run from a plugin cache, a guessed root would write a
 * plane into the plugin install (or any repo the plugin is enabled in) instead of refusing.
 */
export function findRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  if (env.STF_ROOT) return resolve(env.STF_ROOT);
  let dir = resolve(env.CLAUDE_PROJECT_DIR || cwd);
  for (;;) {
    if (existsSync(join(dir, ".stf"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function resolveRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const root = findRoot(env, cwd);
  if (!root) {
    throw new StfError("no_plane", "No .stf/ directory in this project or any parent. Run `stf init` in the repository root to create an empty plane.");
  }
  return root;
}

/** Create an empty plane at a git repository root. Idempotent: an existing plane is left as it is. */
export function initPlane(dir: string): { root: string; created: string[] } {
  const root = resolve(dir);
  if (!existsSync(join(root, ".git"))) {
    throw new StfError("not_repo_root", `${root} is not a git repository root. The plane's evidence checks need git, so run \`stf init\` where .git lives.`);
  }
  mkdirSync(join(root, ".stf", "export"), { recursive: true });
  return { root, created: new Store(root).export() };
}
