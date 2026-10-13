import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerDdbPumpTools } from "./tools/ddbPump.js";
import { registerDdbWriteTools, writesEnabled } from "./tools/ddbWrite.js";
import { registerDdbHomebrewTools, registerDdbHomebrewReadTools } from "./tools/ddbHomebrew.js";
import { registerDdbHomebrewSpellTools } from "./tools/ddbHomebrewSpell.js";
import { registerDdbHomebrewItemTools } from "./tools/ddbHomebrewItem.js";
import { registerDdbHomebrewFeatTools } from "./tools/ddbHomebrewFeat.js";
import { registerDdbHomebrewBackgroundTools } from "./tools/ddbHomebrewBackground.js";
import { registerDdbHomebrewSpeciesTools } from "./tools/ddbHomebrewSpecies.js";
import { registerDdbHomebrewSubclassTools } from "./tools/ddbHomebrewSubclass.js";
import { registerMetaTools } from "./tools/meta.js";
import { VERSION } from "./version.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "beyond-mcp", version: VERSION });
  registerMetaTools(server);   // ddb_ping — version/capability handshake
  registerDdbTools(server);
  registerDdbPumpTools(server);
  registerDdbHomebrewReadTools(server); // ddb_list_homebrew — a read, so always on
  // Write tools are opt-in: reads are always available, mutations only when the
  // deployment sets DDB_WRITES=enabled. Keeps prep-time / default installs read-only.
  // Homebrew creation rides the same gate: it writes to the account, so it is opt-in too.
  if (writesEnabled()) {
    registerDdbWriteTools(server);
    registerDdbHomebrewTools(server);          // monsters
    registerDdbHomebrewSpellTools(server);
    registerDdbHomebrewItemTools(server);
    registerDdbHomebrewFeatTools(server);
    registerDdbHomebrewBackgroundTools(server);
    registerDdbHomebrewSpeciesTools(server);
    registerDdbHomebrewSubclassTools(server);
  }
  return server;
}
