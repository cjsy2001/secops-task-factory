import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { StfError } from "../src/errors.js";
import { buildServer } from "../src/server.js";
import { allTools } from "../src/tools.js";
import { factory, tempRepo } from "./helpers.js";

// THE authority for the tool surface. Prose elsewhere must never count tools by hand.
const EXPECTED = [
  "stf_charter_spec", "stf_list_specs", "stf_get_spec", "stf_advance_phase", "stf_reopen_phase",
  "stf_import_tasks", "stf_list_tasks", "stf_get_task", "stf_next_task", "stf_set_task_status", "stf_capture_task_outcome", "stf_set_task_model",
  "stf_start_run", "stf_complete_run", "stf_append_event", "stf_checkpoint",
  "stf_capture_decision", "stf_capture_open_question", "stf_capture_alternative", "stf_capture_evidence", "stf_list_knowledge",
  "stf_memory_store", "stf_memory_retrieve", "stf_memory_supersede", "stf_memory_archive",
  "stf_handoff_emit", "stf_handoff_pickup", "stf_handoff_list", "stf_handoff_archive",
  "stf_verify", "stf_status",
];

describe("MCP contract", () => {
  it("exposes exactly the expected tools", () => {
    expect(allTools.map((t) => t.name)).toEqual(EXPECTED);
  });

  it("serves them over MCP and returns refusals as isError", async () => {
    const server = buildServer(factory(tempRepo()));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    const ok = await client.callTool({ name: "stf_charter_spec", arguments: { slug: "demo", title: "Demo", summary: "a demo spec" } });
    expect(ok.isError).toBeFalsy();
    const bad = await client.callTool({ name: "stf_get_spec", arguments: { seq: 42 } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("unknown_spec");
    await client.close();
  });

  it("starts without a plane and refuses each call with no_plane (plugin enabled in a repo that has none)", async () => {
    const server = buildServer(() => {
      throw new StfError("no_plane", "No .stf/ directory in this project or any parent.");
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    expect((await client.listTools()).tools).toHaveLength(EXPECTED.length);
    const res = await client.callTool({ name: "stf_status", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("no_plane");
    await client.close();
  });
});
