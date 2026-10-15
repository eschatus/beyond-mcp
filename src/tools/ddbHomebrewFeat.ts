import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew-feat.js";
import { text } from "./helpers.js";
import { limitedUseSchema, entitySpellSchema } from "./homebrewEntitySchemas.js";

// D&D Beyond homebrew FEAT tools — create / update / delete without the site's builder UI.
// Registered only when DDB_WRITES=enabled (alongside the other writes). Primitives: they do
// exactly what is asked on the caller's account; the caller owns intent. Choice fields take the
// builder's own LABELS; an unknown label fails with the list of valid ones. Every write is read
// back (edit form, game-data/feats, edit-page listings) and verified — a mismatch is an error
// naming the feat, never silently accepted. Options (with their own actions), limited-use actions and spell grants use the shared sub-forms.

const requirement = z.object({
  type: z.string().describe("Prerequisite type label: \"Ability Score\", \"Class\", \"Class Feature\", \"Custom Value\", \"Feat\", \"Level\", \"Proficiency\", \"Size\", \"Species\", \"Species Option\"."),
  subType: z.union([z.string(), z.number().int()]).describe("Name within the type, e.g. \"Strength\" (Ability Score), \"Wizard\" (Class). A numeric catalogue id disambiguates duplicate names. Required: DDB silently ignores a requirement without one."),
  value: z.number().optional().describe("e.g. 13 for \"Strength 13 or higher\"; the level for a Level requirement."),
  exclude: z.boolean().optional().describe("true = the character must NOT meet it."),
});

const prerequisite = z.object({
  description: z.string().min(1).describe("Human text shown on the feat, e.g. \"Strength 13 or higher\"."),
  requirements: z.array(requirement).optional().describe("The machine-checked conditions behind the text; omit for a text-only prerequisite."),
});

const modifier = z.object({
  type: z.string().describe("Modifier type label: \"Bonus\", \"Damage\", \"Resistance\", \"Sense\", \"Proficiency\", …"),
  subType: z.union([z.string(), z.number().int()]).describe("Name within the type, e.g. \"Strength Score\" (Bonus), \"Darkvision\" (Sense); a numeric id when the name is ambiguous. An unknown name errors with the valid list."),
  stat: z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]).optional(),
  dice: z.object({ count: z.number().int().min(1), die: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]) }).optional(),
  fixedValue: z.number().int().optional().describe("e.g. 1 for \"+1 Strength Score\"."),
  additionalBonus: z.array(z.string()).optional().describe("\"Proficiency Bonus\", \"Attuned Item Count\", \"Spell Level\"."),
  restriction: z.string().optional(),
  duration: z.object({ interval: z.number().int().min(1), unit: z.enum(["Round", "Minute", "Hour", "Day"]) }).optional(),
});

const option = z.object({
  name: z.string().min(1).describe("Option name, e.g. \"Steady Aim\"."),
  description: z.string().optional().describe("HTML."),
  snippet: z.string().optional(),
  actions: z.array(limitedUseSchema).optional().describe("The option's own limited-use actions (the option page has its own \"Add Action\")."),
});

const fields = {
  name: z.string().min(3).max(1024),
  version: z.string().max(100).optional().describe("Free-text version label shown with the creation."),
  description: z.string().optional().describe("Feat description as HTML, e.g. \"<p>You gain <strong>+1 Strength</strong>.</p>\". Sent to both of the builder's description fields."),
  snippet: z.string().min(3).max(2048).optional().describe("Short summary shown in lists and on the character sheet."),
  tags: z.array(z.string()).optional().describe("Feat tag labels. The list holds case-variant duplicates (\"General\" and \"genral\" are different tags); the exact label is matched first."),
  prerequisites: z.array(prerequisite).optional(),
  modifiers: z.array(modifier).optional().describe("Mechanical effects, e.g. [{type:\"Bonus\", subType:\"Strength Score\", fixedValue:1}] for +1 STR."),
  options: z.array(option).optional().describe("Choices offered by the feat (the builder's \"Add an Option\")."),
  actions: z.array(limitedUseSchema).optional().describe("Limited-use / granted actions of the feat itself. Uses need a reset."),
  spells: z.array(entitySpellSchema).optional().describe("Spell grants. The feat form has no always-prepared / at-level / charges / save DC / restriction controls: asking for one errors."),
};

const updateFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>
};

function summary(r: hb.HomebrewFeatResult) {
  const raw = r.raw;
  return {
    id: r.id,
    name: raw.name,
    editUrl: r.editUrl,
    verified: true,
    snippet: raw.snippet,
    prerequisites: raw.prerequisites?.length ?? 0,
    requirements: (raw.prerequisites ?? []).reduce((n: number, p: any) => n + (p.prerequisiteMappings?.length ?? 0), 0),
  };
}

export function registerDdbHomebrewFeatTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_feat",
    "Create a private homebrew feat on the D&D Beyond account (no builder UI). Choice fields take the builder's labels; an unknown label errors with the valid list. The description is HTML. Prerequisites (text plus optional machine-checked requirements) and modifiers are added after the base feat. The result is read back and verified; on any failure after the base create, the error names the new feat's id so it can be fixed (ddb_update_homebrew_feat) or removed (ddb_delete_homebrew_feat). Options, actions and spell grants are added too (each verified).",
    fields,
    async (f) => text(JSON.stringify(summary(await hb.createHomebrewFeat(f)))),
  );

  server.tool(
    "ddb_update_homebrew_feat",
    "Update one of the account's homebrew feats by id. Only the fields given change; everything else keeps its current value. A provided prerequisites/modifiers/options/actions/spells list REPLACES that kind entirely ([] clears it). Read back and verified like create. Kinds not provided are left untouched.",
    { featId: z.number().int().positive(), ...updateFields },
    async ({ featId, ...f }) => text(JSON.stringify(summary(await hb.updateHomebrewFeat(featId, f)))),
  );

  server.tool(
    "ddb_delete_homebrew_feat",
    "Delete one of the account's homebrew feats by id, with its prerequisites, modifiers and options. DDB soft-deletes: it stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404.",
    { featId: z.number().int().positive() },
    async ({ featId }) => text(JSON.stringify(await hb.deleteHomebrewFeat(featId))),
  );
}
