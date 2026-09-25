#!/usr/bin/env node
// Plugin launcher for the stf plane. Usage:
//   run.mjs mcp            the stdio MCP server (stdout is the protocol: nothing else may write to it)
//   run.mjs recall         the SessionStart block; silent in a project without a plane, never fails the session
//   run.mjs cli <args…>    any cli.js verb (init, status, verify, …)
//   run.mjs build          build the runtime and exit (the mcp bootstrap runs this in the background)
//   run.mjs pages-hook     PostToolUse after an stf plane write: rebuild the status pages; silent (and builds nothing)
//                          unless the project has both .stf/export/specs.json and .stf/pages.json
//
// A plugin is installed from git, so dist/ and node_modules/ (gitignored; better-sqlite3 is native) are absent.
// Runtime resolution:
//   1. in place: the plugin dir already has dist/ and node_modules/ (`make dev`, i.e. claude --plugin-dir) → use it;
//   2. otherwise: build a private copy in ${CLAUDE_PLUGIN_DATA}/runtime (npm ci → build → prune), keyed by a hash
//      of the sources, so it is rebuilt exactly when the plugin update changes them.
// The build takes longer than Claude Code's MCP startup timeout (30s by default), so `mcp` never builds inline: without
// a ready runtime it answers the handshake itself with no tools, builds in a detached child, then hands the connection
// to the real server and sends notifications/tools/list_changed so the client fetches the real tool list.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
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

/** Mirrors root.ts findRoot, so recall and the pages hook can stay silent (and install nothing) where there is no plane. */
function planeRoot() {
  if (process.env.STF_ROOT) return resolve(process.env.STF_ROOT);
  let dir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (;;) {
    if (existsSync(join(dir, ".stf"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const TOOL_PREFIX = "mcp__plugin_stf_stf__";

/**
 * The pages hook's event → cli args (`pages --hook <tool> [seq]`), or null for a silent no-op. Plugin hooks fire in
 * every project that enables the plugin, so a project without a plane export and a .stf/pages.json is left alone.
 */
function pagesHookArgs() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
  const tool = String(event?.tool_name ?? "");
  const root = planeRoot();
  if (!root || !tool.startsWith(TOOL_PREFIX)) return null;
  if (!existsSync(join(root, ".stf", "export", "specs.json")) || !existsSync(join(root, ".stf", "pages.json"))) return null;
  const seq = event.tool_input?.seq;
  return ["pages", "--hook", tool.slice(TOOL_PREFIX.length), ...(Number.isInteger(seq) ? [String(seq)] : [])];
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * mkdir is atomic: the first process to create the lock builds, the others wait for it. The owner's pid goes in the
 * lock, so a lock left by a killed build is reclaimed at once rather than after LOCK_STALE_MS.
 */
function acquire(lock) {
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let age = 0;
    let owner = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
      owner = Number(readFileSync(join(lock, "pid"), "utf8"));
    } catch {
      // released between our mkdir and stat, or the owner has not written its pid yet
    }
    if (age > LOCK_STALE_MS || (owner && !alive(owner))) rmSync(lock, { recursive: true, force: true });
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

function runtimeState() {
  const data = dataDir();
  if (!data) throw new Error("no local build and no plugin data directory: run `make build` in tools/stf-mcp, or start this through Claude Code");
  const runtime = join(data, "runtime");
  const stampFile = join(runtime, ".stamp");
  const want = stampOf(pluginRoot);
  const ready = () => existsSync(stampFile) && readFileSync(stampFile, "utf8") === want;
  return { data, runtime, want, ready };
}

function ensureRuntime() {
  const { data, runtime, want, ready } = runtimeState();
  if (ready()) return runtime;

  mkdirSync(data, { recursive: true });
  const lock = join(data, ".install-lock");
  acquire(lock);
  try {
    if (ready()) return runtime; // another process finished while we waited
    // Holding the lock means no build is running, so any tmp dir is left over from a killed one.
    for (const e of readdirSync(data)) if (e.startsWith("runtime.tmp-")) rmSync(join(data, e), { recursive: true, force: true });
    const tmp = join(data, `runtime.tmp-${process.pid}`);
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

/** Must match INSTRUCTIONS in src/server.ts: the client reads them from this handshake, not the real server's. */
const INSTRUCTIONS =
  "secops-task-factory control plane. Status lives here, content lives in specs/. Never claim a task is done without " +
  "stf_capture_task_outcome; never trust a handoff's Position without re-probing; run stf_verify at session start.";

/**
 * Serve the MCP handshake while the runtime builds, then splice the client onto the real server. stdio MCP is
 * newline-delimited JSON-RPC, so this needs no SDK (node_modules is exactly what is missing).
 */
function bootstrapMcp(data, runtime) {
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const version = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")).version;
  const buildLog = join(data, "build.log");
  let state = "building"; // building → handover → live, or building → failed
  let failure = "";
  let initRequest = null;
  let initialized = null;
  let server = null;
  const held = []; // client lines that arrive while the real server answers the replayed initialize

  const client = createInterface({ input: process.stdin, crlfDelay: Infinity });
  client.on("line", (line) => {
    if (state === "live") return server.stdin.write(`${line}\n`);
    if (state === "handover") return held.push(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "initialize") {
      initRequest = msg;
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "stf", version },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (msg.method === "notifications/initialized") initialized = msg;
    if (msg.id === undefined) return; // notifications need no answer
    if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
    if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    if (msg.method === "tools/call") {
      const text =
        state === "failed"
          ? `The stf runtime build failed: ${failure}. Fix it, then reconnect stf from /mcp.`
          : "stf is still building its runtime (first run or plugin update). Its tools appear when the build finishes.";
      return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text }] } });
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  });
  client.on("close", () => (server ? server.stdin.end() : process.exit(0)));

  function goLive() {
    state = "live";
    if (initialized) server.stdin.write(`${JSON.stringify(initialized)}\n`);
    for (const line of held.splice(0)) server.stdin.write(`${line}\n`);
    if (initRequest) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    log("runtime ready; stf tools are now available");
  }

  function handOver() {
    server = spawn(process.execPath, [join(runtime, "dist", "index.js")], { stdio: ["pipe", "pipe", "inherit"] });
    server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (state === "handover") {
        // the real server's answer to the replayed initialize; the client already has the bootstrap's
        try {
          if (JSON.parse(line).id === initRequest.id) return goLive();
        } catch {
          // not JSON: fall through and pass it on
        }
      }
      process.stdout.write(`${line}\n`);
    });
    if (initRequest) {
      state = "handover";
      server.stdin.write(`${JSON.stringify(initRequest)}\n`);
    } else goLive();
  }

  // Detached, with its output in a file: the build outlives this server if the session ends first, so the next
  // start finds a ready runtime.
  log(`building the stf runtime in the background (log: ${buildLog}); tools appear when it finishes`);
  const out = openSync(buildLog, "w");
  const build = spawn(process.execPath, [fileURLToPath(import.meta.url), "build"], {
    stdio: ["ignore", out, out],
    detached: true,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: data },
  });
  build.on("exit", (code) => {
    if (code === 0) return handOver();
    state = "failed";
    failure = `exit ${code}; see ${buildLog}`;
    log(`runtime build failed (${failure})`);
  });
}

if (mode === "recall" && !planeRoot()) process.exit(0);
if (mode === "pages-hook") {
  const args = pagesHookArgs();
  if (!args) process.exit(0);
  rest.splice(0, rest.length, ...args);
}

let runtime;
try {
  const inPlace = existsSync(join(pluginRoot, "dist", "index.js")) && existsSync(join(pluginRoot, "node_modules"));
  if (inPlace) runtime = pluginRoot;
  else if (mode === "mcp") {
    const state = runtimeState();
    if (!state.ready()) {
      mkdirSync(state.data, { recursive: true });
      bootstrapMcp(state.data, state.runtime);
    } else runtime = state.runtime;
  } else runtime = ensureRuntime();
} catch (e) {
  const msg = String(e?.message ?? e).split("\n")[0];
  if (mode === "recall") {
    // Fail soft: a broken plane must never block a session from starting. This line becomes session context.
    process.stdout.write(`stf plane unavailable: ${msg}\n`);
    process.exit(0);
  }
  if (mode === "pages-hook") {
    // never fail the tool call that fired the hook: say it in one line instead
    process.stdout.write(`${JSON.stringify({ suppressOutput: true, systemMessage: `status-pages hook failed: ${msg}` })}\n`);
    process.exit(0);
  }
  log(msg);
  process.exit(1);
}

if (!runtime) {
  // bootstrapMcp owns the process from here
} else if (mode === "build") {
  process.exit(0);
} else if (mode === "mcp") {
  await import(pathToFileURL(join(runtime, "dist", "index.js")).href);
} else {
  const cli = join(runtime, "dist", "cli.js");
  process.argv = [process.argv[0], cli, ...(mode === "recall" ? ["recall"] : rest)];
  await import(pathToFileURL(cli).href);
}
