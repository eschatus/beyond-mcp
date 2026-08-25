import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerDdbPumpTools } from "./tools/ddbPump.js";
import { VERSION } from "./version.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "ddb-mcp", version: VERSION });
  registerDdbTools(server);
  registerDdbPumpTools(server);
  return server;
}
