import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew-species.js";
import { text, optionChoice } from "./helpers.js";
import { limitedUseSchema, entitySpellSchema } from "./homebrewEntitySchemas.js";

// D&D Beyond homebrew SPECIES tools — create / update / delete without the site's builder UX.
// Registered only when DDB_WRITES=enabled (alongside the sheet writes). Primitives: they do
// exactly what is asked on the caller's account; the caller owns intent. Choice fields take the
// builder's own LABELS ("Large", "Aasimar", modifier type "Sense" / subtype "Darkvision"); an
// unknown label fails with the list of valid ones. Every write is read back (species edit form,
// trait pages, character-service game-data/races) and verified — a mismatch is an error naming
// the species, never silently accepted.

const html = (what: string) => z.string().describe(`${what} as HTML, e.g. "<p>Your hair is <strong>silver</strong>.</p>". DDB markup works inside: [condition]poisoned[/condition], [spell]fireball[/spell].`);

const modifier = z.object({
  type: z.string().describe("Modifier type label from the builder, e.g. \"Bonus\", \"Damage\", \"Resistance\", \"Sense\", \"Proficiency\", \"Language\", \"Set\"."),
  subType: z.union([z.string(), z.number().int()]).describe("Subtype name within that type, e.g. type \"Sense\" + \"Darkvision\", type \"Resistance\" + \"Fire\". When a name is ambiguous the error lists the ids; pass the numeric id then."),
  stat: z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]).optional(),
  dice: z.object({ count: z.number().int().min(1), die: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]) }).optional(),
  fixedValue: z.number().int().optional().describe("e.g. 60 for a 60 ft. Darkvision sense."),
  additionalBonus: z.array(z.string()).optional().describe("\"Proficiency Bonus\", \"Attuned Item Count\", \"Spell Level\"."),
  restriction: z.string().optional(),
  duration: z.object({ interval: z.number().int().min(1), unit: z.enum(["Round", "Minute", "Hour", "Day"]) }).optional(),
});

const traitOption = z.object({
  name: z.string().min(2).max(256),
  snippet: z.string().min(2).describe("One-line summary shown in the character builder. Required."),
  description: html("The choice's text").describe("The choice's full text as HTML. Required."),
  requiredLevel: z.number().int().min(1).max(20).optional().describe("Character level at which the choice becomes available."),
  isGranted: z.boolean().optional().describe("The character always gets this choice instead of picking it."),
});

const trait = z.object({
  name: z.string().min(2).max(256),
  snippet: z.string().min(2).describe("One-line summary shown in the character builder. Required."),
  description: html("The trait's full text").describe("The trait's full text as HTML. Required."),
  featureType: z.enum(["Granted", "Additional", "Replacement"]).describe("Granted = every character of the species gets it; Additional = an extra choice; Replacement = replaces another trait. CREATE-ONLY: DDB ignores it on an edit, so changing a trait's type means replacing the trait (update's traits list does exactly that)."),
  displayOrder: z.number().int().optional(),
  requiredLevel: z.number().int().min(1).max(20).optional().describe("Character level at which the trait is gained."),
  hideInBuilder: z.boolean().optional(),
  hideInSheet: z.boolean().optional(),
  hideOnDetailsPage: z.boolean().optional(),
  isCalledOut: z.boolean().optional().describe("Call out the trait's modifiers in the character builder."),
  modifiers: z.array(modifier).optional().describe("Mechanical effects of the trait (senses, resistances, proficiencies, …)."),
  actions: z.array(limitedUseSchema).optional().describe("Limited-use / granted actions on the trait (\"Add Action\"): uses per rest, activation, reset."),
  spells: z.array(entitySpellSchema).optional().describe("Spell grants on the trait (\"Add Spell\"): always prepared, free casts per reset."),
  traitOptions: z.array(traitOption).optional().describe("Choices inside the trait, picked in the character builder (e.g. Heavy Plating / Light Plating)."),
});

const option = z.object({
  name: z.string().min(2).max(256),
  version: z.string().optional(),
  description: html("The option's description"),
  speciesGroup: optionChoice.optional().describe("Race-group label, e.g. \"Aasimar\". Some labels repeat (\"-\"): pass { value } (the error lists the ids)."),
  isVariant: z.boolean().optional(),
  traits: z.array(trait).optional().describe("The option's own traits (e.g. a strain's abilities); same shape as a species trait. Needs the parent species' supportsOptions."),
});

const speed = z.number().int().min(1).max(500).nullable().optional();

const fields = {
  name: z.string().min(2).max(128),
  version: z.string().optional().describe("Free-text version label shown with the creation."),
  size: z.string().describe("Tiny, Small, Medium, Large, Huge, Gargantuan, or \"Medium or Small\"."),
  speeds: z.object({ walk: speed, burrow: speed, climb: speed, fly: speed, swim: speed }).optional()
    .describe("Speeds in feet. Omit a key to leave it alone; null clears it (update)."),
  shortDescription: html("Short description").optional(),
  description: html("Species description"),
  speciesGroup: optionChoice.optional().describe("Race-group label, e.g. \"Aarakocra\". Some labels repeat (\"-\"): pass { value } (the error lists the ids)."),
  traitIntroduction: z.string().describe("Text introducing the traits list, e.g. \"As a Skyborn, you have the following traits.\""),
  hideTraitsHeading: z.boolean().optional(),
  supportsOptions: z.boolean().optional().describe("The species has options (sub-species / variants), picked in the character builder."),
  traits: z.array(trait).optional(),
  options: z.array(option).optional().describe("Species options (each is its own creation, listed under the species)."),
};

// Update takes the same fields, all optional; a provided traits/options list replaces that kind.
const updateFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>
};

function summary(r: hb.HomebrewSpeciesResult) {
  const walk = r.raw?.weightSpeeds?.normal;
  return {
    id: r.id,
    name: r.name,
    editUrl: r.editUrl,
    verified: true,
    // The races JSON never lists a species that has options, and sometimes omits a new one; the
    // edit form and trait pages were still verified.
    jsonListed: r.raw !== undefined,
    sizeId: r.raw?.sizeId,
    speeds: walk ? { walk: walk.walk, burrow: walk.burrow, climb: walk.climb, fly: walk.fly, swim: walk.swim } : undefined,
    traits: r.traits,
    options: r.options,
  };
}

export function registerDdbHomebrewSpeciesTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_species",
    "Create a private homebrew species on the D&D Beyond account (no builder UI). Choice fields take the builder's labels; an unknown label errors with the valid list. Descriptions are HTML. Traits (with optional modifiers such as a Darkvision sense or a damage resistance) and options are added after the base species. Required: name, size, description, traitIntroduction; every trait needs name, snippet, description and featureType (DDB silently ignores a trait missing one, so it is rejected up front). The species edit form, each trait page and game-data/races are read back and verified; on any failure after the base create, the error names the new species' id so it can be fixed (ddb_update_homebrew_species) or removed (ddb_delete_homebrew_species).",
    fields,
    async (f) => text(JSON.stringify(summary(await hb.createHomebrewSpecies(f)))),
  );

  server.tool(
    "ddb_update_homebrew_species",
    "Update one of the account's homebrew species by id. Only the fields given change. A provided traits or options list REPLACES that kind entirely ([] clears it): the new entries are added, then the old ones deleted, so trait/option ids change. Because a trait's featureType (Granted/Additional/Replacement) is create-only in DDB, replacing the traits is also how to change a trait's type. Read back and verified like create.",
    { speciesId: z.number().int().positive(), ...updateFields },
    async ({ speciesId, ...f }) => text(JSON.stringify(summary(await hb.updateHomebrewSpecies(speciesId, f)))),
  );

  server.tool(
    "ddb_delete_homebrew_species",
    "Delete one of the account's homebrew species by id. Its options are deleted first (DDB does not cascade them); traits and modifiers go with the species. DDB soft-deletes: it stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404.",
    { speciesId: z.number().int().positive() },
    async ({ speciesId }) => text(JSON.stringify(await hb.deleteHomebrewSpecies(speciesId))),
  );
}
