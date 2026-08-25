import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as write from "../bridge/ddb-write.js";
import { getCharacter, getCurrentHp, getMaxHp } from "../bridge/dndbeyond.js";
import { text } from "./helpers.js";

// D&D Beyond WRITE tools. Registered only when DDB_WRITES=enabled (see writesEnabled()).
// These are primitives: they effect exactly the change asked, on whatever character id is
// given, with no notion of who owns the sheet or how the server is used upstream. The
// caller owns intent. Operational note carried in every relevant description: D&D Beyond
// PC HP is also driven by Beyond20 and the player's own sheet — writes here race those,
// last-writer-wins; they are the DM's deliberate acts, not an automation loop.

export function writesEnabled(): boolean {
  return (process.env.DDB_WRITES ?? "").toLowerCase() === "enabled";
}

const CONDITION_IDS: Record<string, number> = {
  blinded: 1, charmed: 2, deafened: 3, exhaustion: 4, frightened: 5, grappled: 6,
  incapacitated: 7, invisible: 8, paralyzed: 9, petrified: 10, poisoned: 11, prone: 12,
  restrained: 13, stunned: 14, unconscious: 15,
};

export function registerDdbWriteTools(server: McpServer): void {
  server.tool(
    "ddb_set_hp",
    "Set a D&D Beyond character's current HP and/or temp HP by absolute value. Writes the real sheet. NOTE: DDB PC HP is also driven by Beyond20 and the player's own edits — this is a DM-authority write, last-writer-wins, not an automation loop. Pass currentHp (clamped to [0, max]) and/or temporaryHitPoints; omitted fields are left unchanged. For relative changes ('take 5 damage') read first, subtract, then set.",
    {
      ddbCharId: z.number().int().positive(),
      currentHp: z.number().int().optional().describe("Absolute current HP to set (clamped to [0, maxHp]). Omit to leave HP unchanged."),
      temporaryHitPoints: z.number().int().nonnegative().optional().describe("Absolute temp HP to set. Omit to leave temp HP unchanged."),
    },
    async ({ ddbCharId, currentHp, temporaryHitPoints }) => {
      if (currentHp === undefined && temporaryHitPoints === undefined) {
        return text("Nothing to do — pass currentHp and/or temporaryHitPoints.");
      }
      const char = await getCharacter(ddbCharId);
      const max = getMaxHp(char);
      const removedHitPoints = currentHp === undefined
        ? char.removedHitPoints
        : max - Math.max(0, Math.min(max, currentHp));
      const temp = temporaryHitPoints ?? char.temporaryHitPoints;
      await write.setHitPoints(ddbCharId, { removedHitPoints, temporaryHitPoints: temp });
      const after = await getCharacter(ddbCharId);
      return text(JSON.stringify({
        id: ddbCharId, name: after.name,
        currentHp: getCurrentHp(after), maxHp: getMaxHp(after), temporaryHitPoints: after.temporaryHitPoints,
      }));
    }
  );

  server.tool(
    "ddb_apply_condition",
    "Apply a condition to a D&D Beyond character on the real sheet. DM-authority write (races Beyond20/player edits). condition is a 5e condition name (blinded, charmed, deafened, exhaustion, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious). For exhaustion, pass level 1-6. Applying a condition the character already has returns a DDB error — check first if unsure.",
    {
      ddbCharId: z.number().int().positive(),
      condition: z.string().describe("5e condition name (case-insensitive)."),
      level: z.number().int().min(1).max(6).optional().describe("Exhaustion level 1-6. Ignored for other conditions."),
    },
    async ({ ddbCharId, condition, level }) => {
      const id = CONDITION_IDS[condition.trim().toLowerCase()];
      if (!id) return text(`Unknown condition "${condition}". Valid: ${Object.keys(CONDITION_IDS).join(", ")}.`);
      const res = await write.applyCondition(ddbCharId, id, id === 4 ? (level ?? 1) : null);
      return text(JSON.stringify({ id: ddbCharId, applied: condition.toLowerCase(), conditions: res.data.conditions }));
    }
  );

  server.tool(
    "ddb_remove_condition",
    "Remove a condition from a D&D Beyond character on the real sheet. DM-authority write. condition is a 5e condition name (see ddb_apply_condition).",
    {
      ddbCharId: z.number().int().positive(),
      condition: z.string().describe("5e condition name (case-insensitive)."),
    },
    async ({ ddbCharId, condition }) => {
      const id = CONDITION_IDS[condition.trim().toLowerCase()];
      if (!id) return text(`Unknown condition "${condition}". Valid: ${Object.keys(CONDITION_IDS).join(", ")}.`);
      const res = await write.removeCondition(ddbCharId, id, id === 4 ? 1 : null);
      return text(JSON.stringify({ id: ddbCharId, removed: condition.toLowerCase(), conditions: res.data.conditions }));
    }
  );
}
