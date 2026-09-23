import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StfError } from "./errors.js";
import type { Factory } from "./factory.js";
import { allTools } from "./tools.js";

export function buildServer(factory: Factory): McpServer {
  const server = new McpServer(
    { name: "stf", version: "0.1.0" },
    {
      instructions:
        "secops-task-factory control plane. Status lives here, content lives in specs/. Never claim a task is done without " +
        "stf_capture_task_outcome; never trust a handoff's Position without re-probing; run stf_verify at session start.",
    },
  );
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: !!tool.readOnly } },
      async (args: unknown) => {
        try {
          const result = tool.run(factory, args ?? {});
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const body =
            err instanceof StfError
              ? { error: err.code, message: err.message, detail: err.detail }
              : { error: "internal", message: err instanceof Error ? err.message : String(err) };
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
        }
      },
    );
  }
  return server;
}
