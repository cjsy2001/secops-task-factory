#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Factory } from "./factory.js";
import { resolveRoot } from "./root.js";
import { buildServer } from "./server.js";

// One process per Claude session (stdio), so the Factory's sessionId IS the session identity
// the analyze gate and fresh-session handoffs compare against.
const factory = new Factory(resolveRoot());
await buildServer(factory).connect(new StdioServerTransport());
