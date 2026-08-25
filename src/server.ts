import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerDdbPumpTools } from "./tools/ddbPump.js";
import { registerDdbWriteTools, writesEnabled } from "./tools/ddbWrite.js";
import { VERSION } from "./version.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "ddb-mcp", version: VERSION });
  registerDdbTools(server);
  registerDdbPumpTools(server);
  // Write tools are opt-in: reads are always available, mutations only when the
  // deployment sets DDB_WRITES=enabled. Keeps prep-time / default installs read-only.
  if (writesEnabled()) registerDdbWriteTools(server);
  return server;
}
