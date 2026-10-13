import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew-spell.js";
import { text, optionChoice } from "./helpers.js";

// D&D Beyond homebrew SPELL tools — create / update / delete without the site's builder UX.
// Registered only when DDB_WRITES=enabled. Primitives: they do exactly what is asked on the
// caller's account; the caller owns intent. Choice fields take the builder's own LABELS; an
// unknown label fails with the list of valid ones. Every write is read back (edit form, each
// sub-entry's form, character-service game-data) and verified — a mismatch is an error naming
// the spell, never silently accepted.

const die = z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]);
const dice = z.object({ count: z.number().int().min(1), die }).describe("e.g. 8d6 = {count:8, die:6}.");

const modifier = z.object({
  type: z.string().describe("Modifier type label, e.g. \"Damage\", \"Resistance\", \"Bonus\", \"Set\", \"Sense\". An unknown label errors with the valid list."),
  subType: z.union([z.string(), z.number().int()]).describe("Subtype name within the type, e.g. \"Fire\" under Damage; pass the numeric subtype id when the name is ambiguous (the error lists the ids)."),
  dice: dice.optional(),
  fixedValue: z.number().int().optional(),
  usesPrimaryStat: z.boolean().optional().describe("Tick the \"primary stat\" box."),
  duration: z.object({ interval: z.number().int().min(0), unit: z.enum(["Round", "Minute", "Hour", "Day"]) }).optional(),
  restriction: z.string().optional().describe("Restriction text shown with the modifier."),
});
const condition = z.object({
  effect: z.enum(["apply", "remove", "suppress"]),
  condition: z.string().describe("Condition label, e.g. \"Charmed\", \"Poisoned\"."),
  duration: z.object({ interval: z.number().int().min(0), unit: z.enum(["Round", "Minute", "Hour", "Day", "Special", "Until Dispelled"]) }).optional(),
  exception: z.string().optional(),
  hide: z.boolean().optional(),
});
const higherLevel = z.object({
  level: z.number().int().min(1).max(9).describe("Slot level the entry applies from."),
  effect: z.string().describe("Effect label: Additional Count, Additional Creatures, Additional Points, Additional Targets, Extended Area, Extended Duration, Extended Range, Special."),
  dice: dice.optional(),
  fixedValue: z.number().int().optional(),
  details: z.string().optional(),
});

const fields = {
  name: z.string().min(2).max(256),
  version: z.string().optional().describe("Free-text version label shown with the creation."),
  level: z.enum(["Cantrip", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"]).optional(),
  school: z.enum(["Abjuration", "Conjuration", "Divination", "Enchantment", "Evocation", "Illusion", "Necromancy", "Transmutation"]),
  castingTime: z.object({
    amount: z.number().int().min(0),
    activation: z.enum(["Action", "Bonus Action", "Hour", "Minute", "No Action", "Reaction", "Special"]),
    note: z.string().optional().describe("Reaction/trigger text, e.g. \"which you take when you are hit\"."),
  }).describe("On update this replaces the whole group: an omitted note is cleared."),
  components: z.object({
    verbal: z.boolean().optional(), somatic: z.boolean().optional(), material: z.boolean().optional(),
    materialText: z.string().optional().describe("Material components text; needs material: true."),
  }).optional().describe("Omitted flags are false. On update this replaces the whole group."),
  range: z.object({
    origin: z.enum(["Self", "Touch", "Ranged", "Sight", "Unlimited"]),
    feet: z.number().int().min(0).optional().describe("Range in feet (for Ranged)."),
  }).describe("On update this replaces the whole group."),
  duration: z.object({
    type: z.enum(["Concentration", "Instantaneous", "Special", "Time", "Until Dispelled", "Until Dispelled or Triggered"]),
    interval: z.number().int().min(0).optional(),
    unit: z.enum(["Round", "Minute", "Hour", "Day"]).optional().describe("Give with interval, e.g. {type:\"Concentration\", interval:10, unit:\"Minute\"}."),
  }).describe("On update this replaces the whole group."),
  description: z.string().optional().describe("Spell description as HTML, e.g. \"<p>A bright streak flashes…</p>\". DDB markup works inside: [condition]poisoned[/condition], [spell]fireball[/spell]."),
  ritual: z.boolean().optional(),
  higherLevelScale: z.enum(["Character Level", "Spell Scale", "Spell Level"]).nullable().optional().describe("Enables \"can cast at higher level\" with this scaling; null turns it off."),
  classes: z.array(optionChoice).min(1).describe("Class-mapping labels the spell is added to, e.g. \"Wizard\", \"Wizard - Evoker\". Some labels repeat (\"Bard\" twice): pass { value } then (the error lists the ids)."),
  areaOfEffect: z.object({
    type: z.enum(["Cone", "Cube", "Cylinder", "Emanation", "Line", "Sphere", "Square", "Square Feet"]),
    size: z.number().int().min(0),
  }).nullable().optional().describe("null clears it. (Applied by a follow-up save on create.)"),
  attack: z.object({ type: z.enum(["Melee", "Ranged"]) }).nullable().optional().describe("Ticks \"as part of weapon attack\" with this attack type; null unticks it."),
  save: z.object({
    ability: z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]),
    onMiss: z.string().optional(), onSuccess: z.string().optional(), onFail: z.string().optional(),
  }).nullable().optional().describe("Saving throw and its effect text. null clears it. On update this replaces the whole group: omitted texts are cleared."),
  tags: z.array(z.string()).optional().describe("Spell tag labels, e.g. \"Damage\", \"Healing\"."),
  modifiers: z.array(modifier).optional().describe("Spell modifiers. On update a provided list REPLACES all modifiers ([] clears them)."),
  conditions: z.array(condition).optional().describe("Spell conditions. On update a provided list REPLACES all conditions ([] clears them)."),
  higherLevels: z.array(higherLevel).optional().describe("Higher-level entries (not linked to a modifier). On update a provided list REPLACES them ([] clears them)."),
};

// Update takes the same fields, all optional; a provided sub-entry list replaces that kind.
const { name, school, castingTime, range, duration, classes, ...rest } = fields;
const updateFields = {
  name: name.optional(), school: school.optional(), castingTime: castingTime.optional(), range: range.optional(),
  duration: duration.optional(), classes: classes.optional(), ...rest,
};

function summary(r: hb.HomebrewSpellWriteResult) {
  const d = r.raw;
  return {
    id: r.id,
    name: d.name,
    editUrl: r.editUrl,
    verified: true,
    level: d.level,
    school: d.school,
    ritual: d.ritual,
    modifiers: d.modifiers?.length ?? 0,
    conditions: d.conditions?.length ?? 0,
  };
}

export function registerDdbHomebrewSpellTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_spell",
    "Create a private homebrew spell on the D&D Beyond account (no builder UI). Choice fields take the builder's labels; an unknown label errors with the valid list. The description is HTML. Area of effect, attack, saving throw and tags are applied by a follow-up save, and modifiers, conditions and higher-level entries are added after the base spell. Every write is read back (edit form, each sub-entry's form, character-service) and verified; on any failure after the base create, the error names the new spell's id so it can be fixed (ddb_update_homebrew_spell) or removed (ddb_delete_homebrew_spell).",
    fields,
    async (f) => text(JSON.stringify(summary(await hb.createHomebrewSpell(f)))),
  );

  server.tool(
    "ddb_update_homebrew_spell",
    "Update one of the account's homebrew spells by id. Only the fields given change; everything else keeps its current value (castingTime, components, range, duration and save are groups: giving one replaces the whole group). A provided modifiers/conditions/higherLevels list REPLACES that kind entirely ([] clears it). Read back and verified like create.",
    { spellId: z.number().int().positive(), ...updateFields },
    async ({ spellId, ...f }) => text(JSON.stringify(summary(await hb.updateHomebrewSpell(spellId, f)))),
  );

  server.tool(
    "ddb_delete_homebrew_spell",
    "Delete one of the account's homebrew spells by id. DDB soft-deletes: it stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404.",
    { spellId: z.number().int().positive() },
    async ({ spellId }) => text(JSON.stringify(await hb.deleteHomebrewSpell(spellId))),
  );
}
