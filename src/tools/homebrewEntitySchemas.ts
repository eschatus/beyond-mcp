import { z } from "zod";
import { optionChoice } from "./helpers.js";
import type { HomebrewLimitedUse, HomebrewEntitySpell } from "../bridge/ddb-homebrew-entity.js";

// Zod schemas for the two sub-forms that recur on every homebrew OWNER type (feats, species
// traits, subclass/class features): a limited-use ACTION and an ENTITY SPELL grant. The type tools
// import these as a field (`actions: z.array(limitedUseSchema)`, `spells: z.array(entitySpellSchema)`)
// and hand the parsed objects to addLimitedUse / addEntitySpell in bridge/ddb-homebrew-entity.ts.
// Choice fields take the builder's LABELS (optionChoice: a label, or { value } where labels repeat);
// an unknown label fails with the list of valid ones.

const ability = z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]);
const operator = z.enum(["add", "multiply"]);
const die = z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20), z.literal(100)]);
const level = z.number().int().min(1).max(20);

const usesFields = {
  count: z.number().int().min(0).optional().describe("Fixed base number of uses, default 0. \"Twice\" is { count: 2 }."),
  abilityModifier: ability.optional().describe("Add this ability's modifier to the uses: \"a number of times equal to your Wisdom modifier\" is { abilityModifier: \"WIS\" }. DDB cannot express a minimum of 1."),
  abilityOperator: operator.optional().describe("How count combines with the modifier: \"add\" (count + modifier, default) or \"multiply\" (count x modifier). Needs abilityModifier."),
  proficiencyBonus: z.boolean().optional().describe("Use the proficiency bonus: \"a number of times equal to your Proficiency Bonus\" is { proficiencyBonus: true }."),
  proficiencyBonusOperator: operator.optional().describe("How the result so far combines with the proficiency bonus: \"add\" (default) or \"multiply\". Needs proficiencyBonus."),
};

const usesScale = z.object({
  ...usesFields,
  level: level.optional().describe("Character level from which these uses apply (e.g. 1 use, then { level: 11, count: 2 }, then { level: 15, count: 3 }). Omit for the base row; at most one base row and one row per level."),
});

export const limitedUseSchema = z.object({
  name: z.string().min(1).describe("Action name as shown on the sheet, e.g. \"Feint\"."),
  actionType: z.enum(["General", "Weapon", "Spell"]).describe("Required by DDB. General = any feature action; Weapon = a weapon attack (needs attackRange); Spell = a spell-like action (spellRange, save, area of effect)."),
  description: z.string().optional().describe("HTML shown on the sheet's action entry."),
  snippet: z.string().optional().describe("Short plain-text summary."),
  level: level.optional().describe("Character level at which the action is granted."),
  activation: optionChoice.optional().describe("\"Action\", \"Bonus Action\", \"Reaction\", \"No Action\", \"Minute\", \"Hour\" or \"Special\"."),
  activationTime: z.number().int().min(0).optional().describe("The N of \"10 Minutes\"; only with activation Minute, Hour or Special."),
  reset: optionChoice.optional().describe("When uses come back: \"Short Rest\" (also restores on a Long Rest, so use it for \"Short or Long Rest\"), \"Long Rest\", \"Dawn\" or \"Other\" (dusk, nightfall, …; say when in the description). Required whenever uses is set: DDB ignores the uses of an action with no reset."),
  uses: z.union([usesScale, z.array(usesScale)]).optional().describe("Limited uses. One row (or several, scaling by level). Requires reset."),
  abilityScore: ability.optional().describe("\"Ability Score Type\": the stat behind the attack roll or save DC. REQUIRED on feats and species traits whenever attackRange or save is set (class features don't need it)."),
  proficient: z.boolean().optional().describe("Add the proficiency bonus to the attack."),
  attackRange: z.enum(["Melee", "Ranged"]).optional().describe("Required for actionType Weapon."),
  attackSubtype: z.enum(["Natural", "Unarmed"]).optional().describe("Weapon actions only."),
  displayAsAttack: z.boolean().optional().describe("Show it in the sheet's attacks list. Defaults to true for a Weapon action with damage or a save (as the builder does)."),
  martialArts: z.boolean().optional().describe("Affected by Martial Arts."),
  onMiss: z.string().optional().describe("\"Effect on Miss\"; needs attackRange."),
  save: z.object({
    ability: ability.describe("The ability the target saves with."),
    dc: z.number().int().min(0).optional().describe("A fixed DC; omit to use the action's ability score type."),
    onSuccess: z.string().optional().describe("Effect on a successful save, e.g. \"half damage\"."),
    onFail: z.string().optional(),
  }).optional(),
  damage: z.object({
    dice: z.object({ count: z.number().int().min(1), die }).optional().describe("e.g. { count: 2, die: 6 } for 2d6."),
    fixedValue: z.number().int().optional().describe("Flat damage / bonus."),
    type: optionChoice.optional().describe("Damage type label: \"Acid\", \"Bludgeoning\", \"Cold\", \"Fire\", \"Force\", \"Lightning\", \"Necrotic\", \"Piercing\", \"Poison\", \"Psychic\", \"Radiant\", \"Slashing\", \"Thunder\"."),
  }).optional(),
  spellRange: optionChoice.optional().describe("Spell actions only: \"Self\", \"Touch\", \"Ranged\", \"Sight\" or \"Unlimited\". \"Ranged\" requires range."),
  range: z.number().int().min(0).optional().describe("Feet. Required for a Ranged spell action; also the normal range of a Ranged weapon attack."),
  longRange: z.number().int().min(0).optional().describe("Feet; Ranged weapon attacks only."),
  areaOfEffect: z.object({
    type: optionChoice.describe("\"Cone\", \"Cube\", \"Cylinder\", \"Emanation\", \"Line\", \"Sphere\", \"Square\" or \"Square Feet\"."),
    size: z.number().int().min(0).optional().describe("Feet."),
    special: z.boolean().optional().describe("\"Area of Effect Special Flag\"."),
  }).optional(),
}).describe("A limited-use / granted ACTION on a feat, species trait or subclass feature (the builder's \"Add Action\").");

export const entitySpellSchema = z.object({
  spells: z.array(optionChoice).optional().describe("Named spells granted by ONE row. Each is a full label (\"Alarm - [Level 1]\"), a plain name when unique (\"Alarm\"; the Legacy twin is \"Alarm (Legacy)\"), or { value: \"<spell id>\" } to settle an ambiguity (the error lists the ids)."),
  levels: z.array(z.number().int().min(0).max(9)).optional().describe("Filter for a \"choose a spell\" grant: spell levels, 0 = cantrip."),
  classes: z.array(optionChoice).optional().describe("Filter: class spell lists. Class labels repeat for Legacy versions (\"Wizard\" ×2), so pass { value } (current Wizard 2190886, Cleric 2190877, Druid 2190878, Bard 2190876, Paladin 2190881, Ranger 2190882, Sorcerer 2190884, Warlock 2190885, Artificer 2656866)."),
  schools: z.array(z.string()).optional().describe("Filter: schools of magic, e.g. [\"Evocation\"]."),
  attackType: z.enum(["Melee", "Ranged", "Melee and Ranged"]).optional(),
  levelDivisor: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  onlyRituals: z.boolean().optional().describe("Filter: ritual spells only."),
  castingAbility: ability.optional().describe("Spellcasting ability for the granted spell(s)."),
  uses: z.object(usesFields).optional().describe("How many times the spell(s) can be cast; usually with reset."),
  reset: optionChoice.optional().describe("\"Short Rest\", \"Long Rest\", \"Dawn\" or \"Other\"."),
  castAtLevel: z.number().int().min(1).max(9).optional().describe("Cast at this spell level."),
  castingTime: z.number().int().min(0).optional(),
  activation: optionChoice.optional().describe("Casting-time unit: \"Action\", \"Bonus Action\", \"Reaction\", …"),
  rangeType: optionChoice.optional().describe("\"Self\", \"Touch\", \"Ranged\", \"Sight\" or \"Unlimited\"."),
  range: z.number().int().min(0).optional().describe("Feet."),
  additionalDescription: z.string().optional(),
  ritual: z.enum(["Can Cast As Ritual", "Must Cast As Ritual"]).optional(),
  atWill: z.boolean().optional().describe("\"Is Infinite\": castable at will."),
  alwaysPrepared: z.boolean().optional().describe("Always prepared (does not count against prepared spells). Subclass/class features and species traits only; the feat form has no such control and errors."),
  countsAsKnown: z.boolean().optional().describe("Counts against spells known. Features and traits only."),
  consumesWarlockSlot: z.boolean().optional().describe("Features and traits only."),
  availableAtLevel: level.optional().describe("Character level at which the grant starts. Features and traits only."),
  minCharges: z.number().int().min(0).optional().describe("Features and traits only."),
  maxCharges: z.number().int().min(0).optional().describe("Features and traits only."),
  saveDc: z.number().int().min(0).optional().describe("Features and traits only."),
  restriction: z.string().optional().describe("Free-text restriction shown in the spell's listing, e.g. \"only at night\". Features and traits only."),
}).describe("A spell grant on a feat, species trait or subclass feature. Needs `spells` and/or a filter (levels, classes, schools, attackType, …). One entry is one DDB row, however many spells it names.");

// Compile-time guarantee that what the schemas parse is what the bridge accepts.
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
export type _LimitedUseOk = Assert<Extends<z.infer<typeof limitedUseSchema>, HomebrewLimitedUse>>;
export type _EntitySpellOk = Assert<Extends<z.infer<typeof entitySpellSchema>, HomebrewEntitySpell>>;
