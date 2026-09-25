#!/usr/bin/env node
// Plugin launcher for the stf plane. Usage:
//   run.mjs mcp            the stdio MCP server (stdout is the protocol: nothing else may write to it)
//   run.mjs recall         the SessionStart block; silent in a project without a plane, never fails the session
//   run.mjs cli <args…>    any cli.js verb (init, status, verify, …)
//
// A plugin is installed from git, so dist/ and node_modules/ (gitignored; better-sqlite3 is native) are absent.
// Runtime resolution:
//   1. in place: the plugin dir already has dist/ and node_modules/ (`make dev`, i.e. claude --plugin-dir) → use it;
//   2. otherwise: build a private copy in ${CLAUDE_PLUGIN_DATA}/runtime (npm ci → build → prune), keyed by a hash
//      of the sources, so it is rebuilt exactly when the plugin update changes them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const [mode = "cli", ...rest] = process.argv.slice(2);
const SOURCES = ["package.json", "package-lock.json", "tsconfig.json", "src"];
const LOCK_STALE_MS = 10 * 60_000;
const log = (m) => process.stderr.write(`stf: ${m}\n`);

function files(p, out = []) {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) files(join(p, e), out);
  else out.push(p);
  return out;
}

function stampOf(root) {
  const h = createHash("sha256");
  for (const s of SOURCES) for (const f of files(join(root, s))) h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex");
}

/** Mirrors root.ts findRoot, so recall can stay silent (and install nothing) where there is no plane. */
function hasPlane() {
  if (process.env.STF_ROOT) return true;
  let dir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (;;) {
    if (existsSync(join(dir, ".stf"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** mkdir is atomic: the first process to create the lock builds, the others wait for it. */
function acquire(lock) {
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between our mkdir and stat
    }
    if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    else if (Date.now() > deadline) throw new Error(`timed out waiting for another install to finish (${lock})`);
    else sleep(500);
  }
}

/**
 * Hooks and MCP servers get CLAUDE_PLUGIN_DATA; the Bash tool (bin/stf) may not. For an installed copy, fall back to
 * the documented location ~/.claude/plugins/data/<plugin>-<marketplace>/ (plugins-reference: persistent data directory).
 */
function dataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const cache = join(homedir(), ".claude", "plugins", "cache") + sep;
  return pluginRoot.startsWith(cache) ? join(homedir(), ".claude", "plugins", "data", "stf-secops-task-factory") : null;
}

function ensureRuntime() {
  const data = dataDir();
  if (!data) throw new Error("no local build and no plugin data directory: run `make build` in tools/stf-mcp, or start this through Claude Code");
  const runtime = join(data, "runtime");
  const stampFile = join(runtime, ".stamp");
  const want = stampOf(pluginRoot);
  const ready = () => existsSync(stampFile) && readFileSync(stampFile, "utf8") === want;
  if (ready()) return runtime;

  mkdirSync(data, { recursive: true });
  const lock = join(data, ".install-lock");
  acquire(lock);
  try {
    if (ready()) return runtime; // another process finished while we waited
    const tmp = join(data, `runtime.tmp-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    for (const s of SOURCES) cpSync(join(pluginRoot, s), join(tmp, s), { recursive: true });
    log("building the stf runtime (first run or plugin update; this takes a minute)…");
    const npm = (...args) => execFileSync("npm", args, { cwd: tmp, stdio: ["ignore", 2, 2] });
    npm("ci", "--no-audit", "--no-fund");
    npm("run", "build");
    npm("prune", "--omit=dev", "--no-audit", "--no-fund");
    writeFileSync(join(tmp, ".stamp"), want);
    rmSync(runtime, { recursive: true, force: true });
    renameSync(tmp, runtime);
    log(`runtime ready in ${runtime}`);
    return runtime;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (mode === "recall" && !hasPlane()) process.exit(0);

let runtime;
try {
  const inPlace = existsSync(join(pluginRoot, "dist", "index.js")) && existsSync(join(pluginRoot, "node_modules"));
  runtime = inPlace ? pluginRoot : ensureRuntime();
} catch (e) {
  const msg = String(e?.message ?? e).split("\n")[0];
  if (mode === "recall") {
    // Fail soft: a broken plane must never block a session from starting. This line becomes session context.
    process.stdout.write(`stf plane unavailable: ${msg}\n`);
    process.exit(0);
  }
  log(msg);
  process.exit(1);
}

if (mode === "mcp") {
  await import(pathToFileURL(join(runtime, "dist", "index.js")).href);
} else {
  const cli = join(runtime, "dist", "cli.js");
  process.argv = [process.argv[0], cli, ...(mode === "recall" ? ["recall"] : rest)];
  await import(pathToFileURL(cli).href);
}
