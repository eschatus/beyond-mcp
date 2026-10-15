import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew-subclass.js";
import { text, optionChoice } from "./helpers.js";
import { limitedUseSchema, entitySpellSchema } from "./homebrewEntitySchemas.js";

// D&D Beyond homebrew SUBCLASS tools — create / update / delete without the site's builder UX.
// Registered only when DDB_WRITES=enabled (alongside the monster tools). Primitives: they do exactly
// what is asked on the caller's account; the caller owns intent. Choice fields take the builder's own
// LABELS; an unknown label fails with the list of valid ones. DDB has no JSON for private subclasses,
// so every write is read back from the builder's own pages and verified — a mismatch is an error
// naming the subclass, never silently accepted.

const html = (what: string) => z.string().describe(`${what} as HTML, e.g. "<p>Starting at 3rd level, you …</p>". Sent to both of the builder's textareas.`);

const optionRef = optionChoice;
// Modifier subtypes are not <select> options: a subtype name, or its numeric catalogue id.
const subTypeRef = z.union([z.string(), z.number().int()]);

const modifier = z.object({
  type: z.string().describe("Modifier type label: Bonus, Damage, Advantage, Disadvantage, Resistance, Immunity, Vulnerability, Sense, Proficiency, Language, Set, …"),
  subType: subTypeRef.describe("Subtype name within the type (\"Fire\" under Resistance, \"Armor Class\" under Bonus); the numeric subtype id when a name is ambiguous."),
  stat: z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]).optional(),
  dice: z.object({ count: z.number().int().min(1), die: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]) }).optional(),
  fixedValue: z.number().int().optional(),
  additionalBonus: z.array(z.string()).optional().describe("\"Proficiency Bonus\", \"Attuned Item Count\", \"Spell Level\"."),
  restriction: z.string().optional(),
  duration: z.object({ interval: z.number().int().min(1), unit: z.enum(["Round", "Minute", "Hour", "Day"]) }).optional(),
  availableToMulticlass: z.boolean().optional().describe("Defaults to false (the builder pre-checks it; this tool sets it explicitly)."),
});

const featureOption = z.object({
  name: z.string().min(1).max(1024),
  snippet: z.string().max(2048).optional(),
  description: html("Option description (at least ~4 characters of text)"),
  multiclassDescription: html("Description shown when taken through multiclassing").optional(),
  isGranted: z.boolean().optional().describe("\"Is Granted\": always given instead of chosen."),
  requiredLevel: z.number().int().min(1).max(20).optional().describe("Character level at which the option unlocks (e.g. 3, 6, 14 for tiered options)."),
  dependsOn: z.string().optional().describe("Only offered when another option is chosen, as the builder labels it: \"Feature name - Option name\" (e.g. \"Lineage - First House\"). The target must belong to a feature EARLIER in the features list."),
  prerequisiteText: z.string().optional(),
  modifiers: z.array(modifier).optional().describe("Mechanical effects of the option (same editor as a feature's)."),
  limitedUses: z.array(limitedUseSchema).optional(),
  spells: z.array(entitySpellSchema).optional(),
});

const feature = z.object({
  name: z.string().min(1).max(1024),
  snippet: z.string().max(2048).optional().describe("Short summary shown in the character builder."),
  description: html("Feature description (at least ~4 characters of text)"),
  multiclassDescription: html("Description shown when taken through multiclassing").optional(),
  level: z.number().int().min(1).max(20).describe("Required character level."),
  displayOrder: z.number().int().optional(),
  type: z.enum(["Granted", "Additional", "Replacement"]).describe("CREATE-ONLY: DDB ignores a type change on an existing feature. To change a type, pass the features list on ddb_update_homebrew_subclass (features are deleted and recreated)."),
  hasOptions: z.boolean().optional(),
  displayRequiredLevel: z.boolean().optional(),
  hideInBuilder: z.boolean().optional(),
  hideInSheet: z.boolean().optional(),
  modifiers: z.array(modifier).optional().describe("Mechanical effects of the feature (the shared modifier editor)."),
  options: z.array(featureOption).optional().describe("Choosable options of the feature (\"has options\" is switched on automatically). On update they are recreated with the feature."),
  limitedUses: z.array(limitedUseSchema).optional().describe("Limited-use actions of the feature (uses, reset, activation): the builder's Add Action."),
  spells: z.array(entitySpellSchema).optional().describe("Spell grants of the feature: always prepared, available from a level, free casts per rest, cantrips. One entry is one DDB row."),
  levelScales: z.array(z.object({
    level: z.number().int().min(1).max(20),
    dice: z.object({ count: z.number().int().min(1), die: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]) }).optional(),
    fixedValue: z.number().int().optional(),
    description: z.string().optional(),
  })).optional().describe("Scaling table rows, e.g. {level:5, dice:{count:2,die:6}}."),
});

const spellcasting = z.object({
  ability: z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]).optional().describe("Spellcasting ability."),
  canCastSpells: z.boolean().optional(),
  additionalSpellLists: z.array(optionRef).optional().describe("Class names whose spell lists are added (\"Cleric\"); { value } where a label repeats; [] clears."),
  prepareType: z.enum(["Half Level", "Level"]).optional(),
  knowsAllSpells: z.boolean().optional(),
  learningStyle: z.enum(["Learned", "Prepared"]).optional(),
  additionalSpells: z.array(optionRef).optional().describe("Spell names always available (\"Alarm\"); { value } where a label repeats; [] clears."),
}).describe("Spellcasting block; only the given sub-fields change.");

const fields = {
  name: z.string().min(1).max(50),
  version: z.string().max(100).optional().describe("Free-text version label shown with the creation."),
  shortDescription: html("Short description"),
  description: html("Full subclass description"),
  spellcasting: spellcasting.optional(),
  features: z.array(feature).optional().describe("Class features, created at /class-feature/create. On update a provided list REPLACES all features ([] removes them all)."),
};

const updateFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>
};

function summary(r: hb.HomebrewSubclassResult) {
  return {
    id: r.id,
    name: r.name,
    editUrl: r.editUrl,
    parentClassId: r.parentClassId,
    verified: true,
    features: r.features.map(({ id, name, level, type }) => ({ id, name, level, type })),
  };
}

export function registerDdbHomebrewSubclassTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_subclass",
    "Create a private homebrew subclass on the D&D Beyond account (no builder UI). className is the parent class's builder label (\"Wizard\"; pass the numeric option id where a label repeats, e.g. Legacy classes). Descriptions are HTML. Features are added after the base subclass, each with optional modifiers and level scales; a feature's type is create-only. The subclass is created ONCE and never retried (a retry made a live duplicate): if DDB's answer carries no id the error says a subclass MAY exist, check My Creations. There is no JSON read-back for subclasses; the result is verified against the builder's edit pages and feature table, and on any failure after the base create the error names the new subclass id so it can be fixed (ddb_update_homebrew_subclass) or removed (ddb_delete_homebrew_subclass). Features may carry options (per-option required level, dependent-option chains, modifiers, actions, spells), limited-use actions and spell grants. Not covered: \"features to replace\" targets, spell slot tables/cantrips-known counts (the builder has no field), avatars, copying an existing subclass.",
    { className: optionRef.describe("Parent class builder label, e.g. \"Wizard\", \"Cleric\"."), ...fields },
    async (f) => text(JSON.stringify(summary(await hb.createHomebrewSubclass(f)))),
  );

  server.tool(
    "ddb_update_homebrew_subclass",
    "Update one of the account's homebrew subclasses by id. Only the fields given change; everything else keeps its current value. A provided features list REPLACES all features wholesale (new ones are created first, then the old ones deleted; [] removes them all) - this is also how to change a feature's type, which DDB ignores on an existing feature. The parent class cannot be changed. Read back and verified like create.",
    { subclassId: z.number().int().positive(), ...updateFields },
    async ({ subclassId, ...f }) => text(JSON.stringify(summary(await hb.updateHomebrewSubclass(subclassId, f)))),
  );

  server.tool(
    "ddb_delete_homebrew_subclass",
    "Delete one of the account's homebrew subclasses by id; its features go with it. DDB soft-deletes: it stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404.",
    { subclassId: z.number().int().positive() },
    async ({ subclassId }) => text(JSON.stringify(await hb.deleteHomebrewSubclass(subclassId))),
  );
}
