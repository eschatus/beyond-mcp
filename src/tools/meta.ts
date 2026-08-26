import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import { writesEnabled } from "./ddbWrite.js";
import { text } from "./helpers.js";

// Version/capability handshake. A consumer (the gem, module-ingest) calls ddb_ping on
// connect and asserts `version` meets its expected minimum before relying on newer tools,
// and reads `capabilities` to know what this deployment exposes (writes are opt-in). The
// shape is additive-only: fields are added, never removed or repurposed, so an older
// consumer's parse never breaks.

export interface DdbPong {
  pong: true;
  server: "ddb-mcp";
  /** semver of this server build (tracks package.json). Compare against your minimum. */
  version: string;
  capabilities: {
    /** Write tools (ddb_set_hp, ddb_apply_condition, …) are registered on this instance. */
    writes: boolean;
    /** Live game-log roll capture (start_ddb_roll_pump / ddb_poll_rolls) is available. */
    rollPump: boolean;
    /** Batched precomputed party snapshot (ddb_get_party_snapshot) is available. */
    partySnapshot: boolean;
  };
}

export function pong(): DdbPong {
  return {
    pong: true,
    server: "ddb-mcp",
    version: VERSION,
    capabilities: {
      writes: writesEnabled(),
      rollPump: true,
      partySnapshot: true,
    },
  };
}

export function registerMetaTools(server: McpServer): void {
  server.tool(
    "ddb_ping",
    "Handshake: returns this server's name, semver version, and capability flags. Call it on connect and assert `version` meets your expected minimum (semver) before relying on newer tools; read `capabilities` to see whether writes are enabled and which optional surfaces (rollPump, partySnapshot) exist. Fields are additive-only across versions.",
    {},
    async () => text(JSON.stringify(pong())),
  );
}
