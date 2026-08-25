import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ddb from "../bridge/dndbeyond.js";
import { rtGetPartySnapshot } from "../bridge/ddb-scds.js";
import { text } from "./helpers.js";

// Tool names and default output shapes are pinned to what roll20-dm-mcp served, so
// existing callers (module-ingest, the gem) migrate by pointing at this server. The
// `full` flags are additive — omitted, the payloads are byte-compatible with before.

// roll20-dm-mcp defaulted campaign ids from its campaign registry; this server has no
// registry, so the fallback is the DDB_CAMPAIGN_ID env var the launcher sets.
function defaultCampaignId(): string | undefined {
  return process.env.DDB_CAMPAIGN_ID || undefined;
}

export function registerDdbTools(server: McpServer): void {
  server.tool(
    "ddb_get_character",
    "Fetch a character sheet from D&D Beyond by numeric ID. Default: a compact HP/AC/conditions snapshot. full:true adds the parsed sheet (ability scores/mods, saves, skills, initiative, speed).",
    {
      ddbCharId: z.number().int().positive(),
      full: z.boolean().optional().describe("Include the full parsed stat sheet (default false — compact snapshot only)."),
    },
    async ({ ddbCharId, full }) => {
      const char = await ddb.getCharacter(ddbCharId);
      const slim = {
        id: char.id,
        name: char.name,
        currentHp: ddb.getCurrentHp(char),
        maxHp: ddb.getMaxHp(char),
        temporaryHitPoints: char.temporaryHitPoints,
        armorClass: char.armorClass,
        passivePerception: char.passivePerception,
        conditions: char.conditions.map((c) => c.id),
      };
       
      return text(JSON.stringify(full ? { ...slim, stats: ddb.parseStats(char as any) } : slim));
    }
  );

  server.tool(
    "ddb_list_campaign_characters",
    "List all player characters in a DDB campaign. campaignId defaults to the DDB_CAMPAIGN_ID env var.",
    { campaignId: z.string().optional() },
    async ({ campaignId }) => {
      const id = campaignId ?? defaultCampaignId();
      if (!id) return text("No campaignId given and DDB_CAMPAIGN_ID is not set — pass campaignId (find it with ddb_list_campaigns).");
      const chars = await ddb.getCampaignCharacters(id);
      // Project to {id, name} — only fields any consumer actually reads.
      const slim = chars.map((c) => ({ id: c.id, name: c.characterName }));
      return text(JSON.stringify(slim));
    }
  );

  server.tool(
    "ddb_list_campaigns",
    "List all DnD Beyond campaigns the account is in (as DM or player), with IDs and player counts",
    {},
    async () => {
      const campaigns = await ddb.listCampaigns();
      return text(JSON.stringify(campaigns));
    }
  );

  server.tool(
    "ddb_get_monster",
    "Get monster stats from the D&D Beyond compendium by name or numeric id. Default: a compact HP/AC/CR snapshot. full:true returns the whole statblock (ability scores, speed, traits/actions/reactions, resistances/immunities, art URL).",
    {
      nameOrId: z.union([z.string(), z.number()]),
      full: z.boolean().optional().describe("Return the full statblock (default false — compact snapshot only)."),
    },
    async ({ nameOrId, full }) => {
      const monster = await ddb.getMonster(nameOrId);
      if (full) return text(JSON.stringify(monster));
      return text(JSON.stringify({
        id: monster.id,
        name: monster.name,
        averageHitPoints: monster.averageHitPoints,
        armorClass: monster.armorClass,
        challengeRating: monster.challengeRating,
      }));
    }
  );

  server.tool(
    "ddb_get_party_snapshot",
    "Precomputed combat snapshot for a whole party in one call, via D&D Beyond's SCDS service. Returns each character's COMPUTED armor class and max/current/temp HP (which the plain character sheet does not carry pre-derived), plus named conditions, death saves, initiative, passives and level. This is the authoritative AC/maxHP source — prefer it over ddb_get_character for live party status. full:true adds resolved attacks (to-hit + damage dice), casting info, abilities, skills, senses, resistances/immunities. Pass characterIds, or a campaignId (defaults to DDB_CAMPAIGN_ID) to snapshot its whole roster.",
    {
      characterIds: z.array(z.number().int().positive()).optional().describe("Explicit DDB character ids. Overrides campaignId."),
      campaignId: z.string().optional().describe("Snapshot every character in this campaign. Defaults to DDB_CAMPAIGN_ID."),
      full: z.boolean().optional().describe("Include resolved attacks, casting, abilities, skills, senses, resistances (default false — combat vitals only)."),
    },
    async ({ characterIds, campaignId, full }) => {
      let ids = characterIds;
      if (!ids?.length) {
        const cid = campaignId ?? defaultCampaignId();
        if (!cid) return text("Pass characterIds, or a campaignId (or set DDB_CAMPAIGN_ID) to snapshot a roster.");
        ids = (await ddb.getCampaignCharacters(cid)).map((c) => c.id);
        if (!ids.length) return text(`Campaign ${cid} has no characters.`);
      }
      const snap = await rtGetPartySnapshot(ids);
      const foundIds = new Set(snap.map((c) => c.characterId));
      const missing = ids.filter((id) => !foundIds.has(id));
      const party = snap.map((c) => {
        const slim = {
          id: c.characterId,
          name: c.name,
          level: c.level,
          currentHp: c.hitPointInfo?.current,
          maxHp: c.hitPointInfo?.maximum,
          temporaryHitPoints: c.hitPointInfo?.temp,
          armorClass: c.armorClass,
          conditions: (c.conditions ?? []).map((x) => x.name),
          deathSaves: c.deathSaveInfo,
          initiativeBonus: c.initiativeBonus,
          passivePerception: c.passivePerception,
        };
        return full
          ? { ...slim, attacks: c.attacks, castingInfo: c.castingInfo, abilities: c.abilities, skills: c.skills, senses: c.senses, resistances: c.resistances, immunities: c.immunities, vulnerabilities: c.vulnerabilities }
          : slim;
      });
      return text(JSON.stringify(missing.length ? { party, missing } : { party }));
    }
  );
}
