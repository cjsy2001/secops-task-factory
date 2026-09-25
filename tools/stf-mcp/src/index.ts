#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Factory } from "./factory.js";
import { resolveRoot } from "./root.js";
import { buildServer } from "./server.js";

// One process per Claude session (stdio), so the Factory's sessionId IS the session identity
// the analyze gate and fresh-session handoffs compare against.
// The Factory is created on the first tool call: as a plugin the server starts in every project where the
// plugin is enabled, and a project without a plane must get a `no_plane` refusal, not a crashed server.
let factory: Factory | undefined;
await buildServer(() => (factory ??= new Factory(resolveRoot()))).connect(new StdioServerTransport());
