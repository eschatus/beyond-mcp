import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew.js";
import { listHomebrew, HOMEBREW_TYPES, type HomebrewType } from "../bridge/ddb-homebrew-list.js";
import { text } from "./helpers.js";

// D&D Beyond homebrew MONSTER tools — create / update / delete without the site's builder UX.
// Registered only when DDB_WRITES=enabled (alongside the sheet writes). Primitives: they do
// exactly what is asked on the caller's account; the caller owns intent. Choice fields take
// the builder's own LABELS ("Humanoid", "1/4", "Fire - Resistance"); an unknown label fails
// with the list of valid ones. Every write is read back from monster-service and verified —
// a mismatch is an error naming the monster, never silently accepted.

const html = (what: string) => z.string().describe(`${what} as HTML, e.g. "<p><em><strong>Bite.</strong></em> Melee Attack Roll: +5 …</p>". DDB markup works inside: [rollable]+5;{"diceNotation":"1d20+5","rollType":"to hit","rollAction":"Bite"}[/rollable], [condition]poisoned[/condition], [spell]fireball[/spell].`);

const fields = {
  name: z.string().min(2).max(256),
  statBlock: z.enum(["5e", "5.5e"]).optional().describe("Statblock format: 5e (2014) or 5.5e (2024)."),
  version: z.string().optional().describe("Free-text version label shown with the creation."),
  type: z.string().describe("Monster type label: Aberration, Beast, Celestial, Construct, Dragon, Elemental, Fey, Fiend, Giant, Humanoid, Monstrosity, Ooze, Plant, Undead."),
  subTypes: z.array(z.string()).optional().describe("Sub-type labels (e.g. \"Goblinoid\")."),
  size: z.string().describe("Tiny, Small, Medium, Large, Huge, Gargantuan, or \"Medium or Small\"."),
  alignment: z.string().optional().describe("Alignment label, e.g. \"Neutral Evil\", \"Unaligned\", \"Any Alignment\"."),
  challengeRating: z.string().describe("CR label: \"0\", \"1/8\", \"1/4\", \"1/2\", \"1\" … \"30\"."),
  armorClass: z.number().int().min(1),
  armorClassType: z.string().optional().describe("e.g. \"natural armor\"."),
  initiativeBonus: z.number().int().optional().describe("Defaults to the DEX modifier when omitted."),
  passivePerception: z.number().int().min(1),
  averageHitPoints: z.number().int().min(1),
  hitDice: z.object({
    count: z.number().int().min(1),
    die: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]),
    modifier: z.number().int().optional(),
  }).describe("e.g. 4d8+8 = {count:4, die:8, modifier:8}."),
  abilities: z.object({
    str: z.number().int().min(1).max(30), dex: z.number().int().min(1).max(30), con: z.number().int().min(1).max(30),
    int: z.number().int().min(1).max(30), wis: z.number().int().min(1).max(30), cha: z.number().int().min(1).max(30),
  }),
  savingThrows: z.array(z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"])).optional().describe("Saving-throw proficiencies."),
  saveBonuses: z.object({
    STR: z.number().int().min(1).optional(), DEX: z.number().int().min(1).optional(), CON: z.number().int().min(1).optional(),
    INT: z.number().int().min(1).optional(), WIS: z.number().int().min(1).optional(), CHA: z.number().int().min(1).optional(),
  }).optional().describe("Extra saving-throw bonus ON TOP of ability modifier + proficiency bonus (e.g. a Cloak of Protection: {WIS: 1} on a WIS-proficient monster renders WIS = mod + PB + 1). DDB makes any save with a bonus proficient, so every key must also be in savingThrows. Not for non-proficient saves with an extra bonus: those can't be expressed. On update a provided object replaces all six."),
  damageAdjustments: z.array(z.string()).optional().describe("Builder labels, \"<damage> - <Resistance|Immunity|Vulnerability>\", e.g. \"Fire - Resistance\", \"Poison - Immunity\"."),
  conditionImmunities: z.array(z.string()).optional().describe("Condition labels, e.g. \"Poisoned\", \"Charmed\"."),
  habitats: z.array(z.string()).optional().describe("Habitat/environment labels, e.g. \"Forest\", \"Underdark\"."),
  tags: z.array(z.string()).optional().describe("Monster tag labels."),
  treasure: z.array(z.string()).optional().describe("Treasure table labels: Any, Arcana, Armaments, Implements, Individual, None, Relics."),
  gear: z.string().optional(),
  languagesNote: z.string().optional().describe("Text APPENDED after the languages list (it does not replace it — live: \"Common\" + note \"Common plus two other languages\" renders \"Common Common plus…\"), e.g. \"telepathy 120 ft.\"; pass languages: [] for a note-only line."),
  traits: html("Traits block").optional(),
  actions: html("Actions block").optional(),
  bonusActions: html("Bonus actions block").optional(),
  reactions: html("Reactions block").optional(),
  characteristics: html("General description / lore").optional(),
  legendaryActions: html("Legendary actions block (setting it marks the monster legendary)").nullable().optional().describe("null clears legendary status."),
  mythicActions: html("Mythic actions block").nullable().optional().describe("null clears mythic status."),
  lair: z.object({ description: html("Lair and lair actions"), xp: z.number().int().optional().describe("XP when fought in its lair — one of the builder's XP steps (10, 25, 50, 100, 200, 450, 700, 1100, 1800, 2300, 2900, 3900, 5000, 5900, 7200, …, 155000).") })
    .nullable().optional().describe("null clears has-lair."),
  movements: z.array(z.object({
    type: z.enum(["Walk", "Burrow", "Climb", "Fly", "Swim"]), speed: z.number().int().min(0), note: z.string().optional().describe("e.g. \"hover\"."),
  })).optional(),
  senses: z.array(z.object({
    sense: z.enum(["Blindsight", "Darkvision", "Tremorsense", "Truesight"]), note: z.string().describe("Range text, e.g. \"60 ft.\"."),
  })).optional(),
  skills: z.array(z.object({
    skill: z.string().describe("Skill label, e.g. \"Perception\", \"Sleight of Hand\"."),
    value: z.number().int().min(1).describe("The statblock's TOTAL skill bonus (4 renders as +4)."),
    additionalBonus: z.number().int().optional(),
  })).optional(),
  languages: z.array(z.object({ language: z.string().describe("Language label, e.g. \"Common\", \"Draconic\"."), note: z.string().optional() })).optional(),
};

// Update takes the same fields, all optional; a provided sub-entry list replaces that kind.
const updateFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>
};

function summary(r: hb.HomebrewWriteResult) {
  const raw = r.raw;
  return {
    id: r.id,
    name: raw.name,
    editUrl: r.editUrl,
    url: raw.url,
    verified: true,
    armorClass: raw.armorClass,
    averageHitPoints: raw.averageHitPoints,
    hitDice: raw.hitPointDice?.diceString,
    movements: raw.movements?.length ?? 0,
    senses: raw.senses?.length ?? 0,
    skills: raw.skills?.length ?? 0,
    languages: raw.languages?.length ?? 0,
  };
}

export function registerDdbHomebrewTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_monster",
    "Create a private homebrew monster on the D&D Beyond account (no builder UI). Choice fields take the builder's labels; an unknown label errors with the valid list. Descriptions are HTML. Sub-entries (movements, senses, skills, languages) are added after the base monster. The result is read back from monster-service and verified; on any failure after the base create, the error names the new monster's id so it can be fixed (ddb_update_homebrew_monster) or removed (ddb_delete_homebrew_monster). Read the full statblock afterwards with ddb_get_monster.",
    fields,
    async (f) => text(JSON.stringify(summary(await hb.createHomebrewMonster(f)))),
  );

  server.tool(
    "ddb_update_homebrew_monster",
    "Update one of the account's homebrew monsters by id. Only the fields given change; everything else keeps its current value. A provided movements/senses/skills/languages list REPLACES that kind entirely ([] clears it). Read back and verified like create.",
    { monsterId: z.number().int().positive(), ...updateFields },
    async ({ monsterId, ...f }) => text(JSON.stringify(summary(await hb.updateHomebrewMonster(monsterId, f)))),
  );

  server.tool(
    "ddb_delete_homebrew_monster",
    "Delete one of the account's homebrew monsters by id. DDB soft-deletes: the monster stops being editable or usable and stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404 (reads such as monster-service may keep serving a cached copy for a while).",
    { monsterId: z.number().int().positive() },
    async ({ monsterId }) => text(JSON.stringify(await hb.deleteHomebrewMonster(monsterId))),
  );
}

// Listing is a READ, so it registers with the always-on read tools, not behind DDB_WRITES.
export function registerDdbHomebrewReadTools(server: McpServer): void {
  server.tool(
    "ddb_list_homebrew",
    "List the account's own D&D Beyond homebrew creations (My Creations), newest first, ~20 per page. Filter by type and/or a name substring. Deleting homebrew on DDB is a SOFT delete: deleted creations are hidden unless status is \"deleted\". Returns ids usable with the ddb_*_homebrew_* tools and ddb_get_monster.",
    {
      type: z.enum(Object.keys(HOMEBREW_TYPES) as [HomebrewType, ...HomebrewType[]]).optional(),
      name: z.string().optional().describe("Substring of the creation name."),
      status: z.enum(["private", "published", "deleted"]).optional().describe("Omitted: private + published (deleted hidden)."),
      page: z.number().int().positive().optional(),
    },
    async (o) => text(JSON.stringify(await listHomebrew(o))),
  );
}
