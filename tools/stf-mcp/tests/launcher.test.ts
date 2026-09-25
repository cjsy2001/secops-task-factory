import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS } from "../src/server.js";

// scripts/run.mjs against a fake plugin: no dependencies, and a "build" that writes a minimal stdio MCP server,
// so the bootstrap → handover path runs in seconds and offline. The real build is what `make dev` exercises.

const FAKE_SERVER = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stf", version: "real" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "stf_fake", inputSchema: { type: "object" } }] } });
  else if (m.method === "notifications/initialized") process.stderr.write("fake: initialized\\n");
});
`;

function fakePlugin(build: string): { root: string; data: string } {
  const base = mkdtempSync(join(tmpdir(), "stf-launcher-"));
  const root = join(base, "plugin");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  cpSync(join(import.meta.dirname, "..", "scripts", "run.mjs"), join(root, "scripts", "run.mjs"));
  const pkg = { name: "fake", version: "9.9.9", private: true, type: "module", scripts: { build: "node src/build.mjs" } };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "fake", version: "9.9.9", lockfileVersion: 3, requires: true, packages: { "": { name: "fake", version: "9.9.9" } } }),
  );
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "src", "server.mjs"), FAKE_SERVER);
  writeFileSync(join(root, "src", "build.mjs"), build);
  return { root, data: join(base, "data") };
}

const BUILD_OK = `
import { cpSync, mkdirSync } from "node:fs";
await new Promise((r) => setTimeout(r, 1500)); // long enough to observe the bootstrap's empty tool list
mkdirSync("dist", { recursive: true });
cpSync("src/server.mjs", "dist/index.js");
`;

type Msg = { id?: number; method?: string; result?: any; error?: any };

class Client {
  readonly proc: ChildProcessWithoutNullStreams;
  private readonly inbox: Msg[] = [];
  private waiters: (() => void)[] = [];
  private nextId = 1;

  constructor(plugin: { root: string; data: string }) {
    this.proc = spawn(process.execPath, [join(plugin.root, "scripts", "run.mjs"), "mcp"], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: plugin.data },
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      this.inbox.push(JSON.parse(line)); // anything on stdout that is not JSON-RPC fails the test here
      for (const w of this.waiters.splice(0)) w();
    });
  }

  send(method: string, params: object = {}, notification = false): number | undefined {
    const id = notification ? undefined : this.nextId++;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params })}\n`);
    return id;
  }

  async next(match: (m: Msg) => boolean, timeoutMs = 15000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`no matching message; inbox: ${JSON.stringify(this.inbox)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 200);
      });
    }
  }

  async call(method: string, params: object = {}): Promise<Msg> {
    const id = this.send(method, params);
    return this.next((m) => m.id === id);
  }

  async handshake(): Promise<Msg> {
    const started = Date.now();
    const init = await this.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(Date.now() - started).toBeLessThan(5000); // well inside Claude Code's 30s startup timeout
    this.send("notifications/initialized", {}, true);
    return init;
  }
}

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.proc.kill();
});

describe("launcher: mcp without a ready runtime", () => {
  it("answers the handshake at once, builds in the background, then hands over and announces the real tools", async () => {
    const plugin = fakePlugin(BUILD_OK);
    const c = new Client(plugin);
    clients.push(c);

    const init = await c.handshake();
    expect(init.result.capabilities.tools.listChanged).toBe(true);
    expect(init.result.instructions).toBe(INSTRUCTIONS);
    expect(init.result.serverInfo).toEqual({ name: "stf", version: "9.9.9" });

    expect((await c.call("tools/list")).result.tools).toEqual([]);
    const early = await c.call("tools/call", { name: "stf_status", arguments: {} });
    expect(early.result.isError).toBe(true);
    expect(early.result.content[0].text).toMatch(/still building/);

    await c.next((m) => m.method === "notifications/tools/list_changed");
    expect((await c.call("tools/list")).result.tools.map((t: { name: string }) => t.name)).toEqual(["stf_fake"]);
    expect(existsSync(join(plugin.data, "runtime", ".stamp"))).toBe(true);
  });

  it("starts the real server directly once the runtime is built", async () => {
    const plugin = fakePlugin(BUILD_OK);
    expect(spawnSync(process.execPath, [join(plugin.root, "scripts", "run.mjs"), "build"], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PLUGIN_DATA: plugin.data },
    }).status).toBe(0);
    const c = new Client(plugin);
    clients.push(c);

    const init = await c.handshake();
    expect(init.result.serverInfo.version).toBe("real");
    expect((await c.call("tools/list")).result.tools).toHaveLength(1);
  });

  it("reclaims a lock and tmp dir left by a killed build instead of waiting for them to go stale", async () => {
    const plugin = fakePlugin(BUILD_OK);
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    mkdirSync(join(plugin.data, ".install-lock"), { recursive: true });
    writeFileSync(join(plugin.data, ".install-lock", "pid"), dead);
    mkdirSync(join(plugin.data, `runtime.tmp-${dead}`));
    const c = new Client(plugin);
    clients.push(c);

    await c.handshake();
    await c.next((m) => m.method === "notifications/tools/list_changed");
    expect(readdirSync(plugin.data).filter((e) => e.startsWith("runtime.tmp-") || e === ".install-lock")).toEqual([]);
  });

  it("reports a failed build through tool calls, pointing at the build log", async () => {
    const plugin = fakePlugin(`process.exit(3);`);
    const c = new Client(plugin);
    clients.push(c);

    await c.handshake();
    const deadline = Date.now() + 15000;
    let text = "";
    while (Date.now() < deadline && !/failed/.test(text)) {
      text = (await c.call("tools/call", { name: "stf_status", arguments: {} })).result.content[0].text;
      if (!/failed/.test(text)) await new Promise((r) => setTimeout(r, 300));
    }
    expect(text).toMatch(/build failed: exit 1; see .*build\.log/);
  });
});
