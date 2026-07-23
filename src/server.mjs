// server.mjs — stdio entry point (Claude Desktop / any local MCP host).
// The engine itself lives in engine.mjs; http.mjs serves the same store over HTTP.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore } from "./store.mjs";
import { createEngine } from "./engine.mjs";

const store = openStore(); // fixed per-user data dir (see store.mjs) — OMA_DB overrides for tests/isolation

await createEngine(store).connect(new StdioServerTransport());
