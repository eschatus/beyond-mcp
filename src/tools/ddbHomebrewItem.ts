import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as hb from "../bridge/ddb-homebrew-item.js";
import { text, optionChoice } from "./helpers.js";

// D&D Beyond homebrew MAGIC ITEM tools — create / update / delete without the site's builder UX.
// Registered only when DDB_WRITES=enabled (alongside the sheet writes and the monster tools).
// Primitives: they do exactly what is asked on the caller's account; the caller owns intent.
// Choice fields take the builder's own LABELS; an unknown label fails with the list of valid ones.
// There is no JSON read-back for private items, so every write is verified against the re-rendered
// edit page (form + sub-entry tables) — a mismatch is an error naming the item, never accepted.

const html = (what: string) => z.string().describe(`${what} as HTML, e.g. "<p>While wearing this ring you gain a +1 bonus to AC.</p>". DDB markup works inside: [condition]poisoned[/condition], [spell]fireball[/spell].`);

const optionRef = optionChoice;
const ref = (v: z.infer<typeof optionRef> | undefined): hb.OptionRef | undefined => v;

const DURATION_UNITS = ["Round", "Minute", "Hour", "Day"] as const;

const modifierSchema = z.object({
  type: z.string().describe("Modifier type label, e.g. \"Bonus\", \"Damage\", \"Resistance\", \"Sense\", \"Set\", \"Language\", \"Proficiency\"."),
  subType: z.union([z.string(), z.number().int()]).describe("Subtype name within the type (\"Armor Class\", \"Fire\", \"Darkvision\"), or its numeric id when a name is ambiguous."),
  stat: z.enum(["STR", "DEX", "CON", "INT", "WIS", "CHA"]).optional().describe("Primary stat."),
  dice: z.object({ count: z.number().int().min(1), die: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]) }).optional(),
  fixedValue: z.number().int().optional(),
  additionalBonus: z.array(z.string()).optional().describe("\"Proficiency Bonus\", \"Attuned Item Count\", \"Spell Level\"."),
  restriction: z.string().optional(),
  duration: z.object({ interval: z.number().int().min(1), unit: z.enum(DURATION_UNITS) }).optional(),
  requiresAttunement: z.boolean().optional().describe("Whether this modifier only applies while attuned. Defaults to false (always on) — DDB's own form defaults to true."),
});

const conditionSchema = z.object({
  condition: z.string().describe("Condition label, e.g. \"Charmed\", \"Poisoned\"."),
  duration: z.object({ interval: z.number().int().min(1), unit: z.enum([...DURATION_UNITS, "Special", "Until Dispelled"]) }).optional(),
  exception: z.string().optional().describe("Free-text exception."),
});

const spellSchema = z.object({
  spell: optionRef.describe("Full builder label (\"Fireball - [Level 3]\", \"Magic Missile (Legacy) - [Level 1]\") or a plain name that resolves to exactly one non-Legacy spell. Otherwise the error lists the candidates; pass { value } to pick one."),
  minCharges: z.number().int().min(0).optional(),
  maxCharges: z.number().int().min(0).optional(),
  saveDc: z.number().int().min(0).optional(),
  castAtLevel: z.number().int().min(1).max(20).optional(),
  restriction: z.string().optional(),
});

const fields = {
  name: z.string().min(2).max(256),
  version: z.string().optional().describe("Free-text version label shown with the creation."),
  rarity: z.string().describe("Common, Uncommon, Rare, Very Rare, Legendary, Artifact, Varies, or Unknown Rarity."),
  baseType: z.enum(["Item", "Armor", "Weapon"]).optional().describe("Defaults to Item. DDB silently DROPS fields that don't fit the base type, so this tool rejects them: itemType is for Item only; baseArmor/dexterityModifier/strengthRequirement/stealthCheck for Armor only; baseWeapon for Weapon only."),
  itemType: z.string().optional().describe("Required for baseType Item: Wondrous Item, Rod, Scroll, Staff, Wand, Ring, Potion."),
  baseArmor: optionRef.optional().describe("Armor only: base armor label, e.g. \"Chain Mail\", \"Breastplate\"."),
  dexterityModifier: z.string().optional().describe("Armor only: \"Full Modifier\", \"Max 2\", or \"None\"."),
  strengthRequirement: z.number().int().min(0).optional().describe("Armor only."),
  stealthCheck: z.string().optional().describe("Armor only: \"None\" or \"Disadvantage\"."),
  baseWeapon: optionRef.optional().describe("Weapon only: base weapon label, e.g. \"Longsword\". The list holds duplicate labels; an ambiguous label errors with the option ids — pass { value }."),
  requiresAttunement: z.boolean().optional(),
  attunementDescription: z.string().optional().describe("Who can attune, e.g. \"by a spellcaster\" (requires requiresAttunement: true)."),
  description: html("The item description"),
  charges: z.object({
    count: z.number().int().min(1),
    resetCondition: z.string().optional().describe("Short Rest, Long Rest, Dawn, Other, or \"None, Consumable\"."),
    resetDescription: z.string().optional().describe("e.g. \"regains 1d6+1 expended charges\"."),
  }).nullable().optional().describe("Charges (applied by a follow-up save on create). null switches charges off."),
  notes: z.string().optional().describe("Private notes."),
  weight: z.number().min(0).optional().describe("Weight in lb."),
  tags: z.array(z.string()).optional().describe("Magic item tag labels, e.g. \"Buff\", \"Healing\"."),
  modifiers: z.array(modifierSchema).optional().describe("Modifiers (the character-sheet effects of the item). Update REPLACES the whole set ([] clears)."),
  conditions: z.array(conditionSchema).optional().describe("Conditions the item applies. Update REPLACES the whole set ([] clears)."),
  spells: z.array(spellSchema).optional().describe("Spells the item casts. Update REPLACES the whole set ([] clears)."),
};

// Update takes the same fields, all optional; a provided sub-entry list replaces that kind.
const updateFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>
};

type ToolFields = Partial<{ [K in keyof typeof fields]: z.infer<(typeof fields)[K]> }>;

function toBridge(f: ToolFields): hb.HomebrewMagicItemFields {
  const { baseArmor, baseWeapon, spells, ...rest } = f;
  return {
    ...rest,
    ...(baseArmor !== undefined && { baseArmor: ref(baseArmor) }),
    ...(baseWeapon !== undefined && { baseWeapon: ref(baseWeapon) }),
    ...(spells !== undefined && { spells: spells.map((s) => ({ ...s, spell: ref(s.spell)! })) }),
  };
}

export function registerDdbHomebrewItemTools(server: McpServer): void {
  server.tool(
    "ddb_create_homebrew_magic_item",
    "Create a private homebrew magic item on the D&D Beyond account (no builder UI). Choice fields take the builder's labels; an unknown or ambiguous label errors with the valid list. The description is HTML. Fields that don't fit the base type (e.g. baseArmor on a Weapon) are rejected up front because DDB would silently drop them. Charges, notes, weight and tags are applied by a follow-up save; modifiers, conditions and spells are added as sub-entries. DDB has no JSON read for private items, so the result is verified against the re-rendered edit page; on any failure after the base create, the error names the new item's id so it can be fixed (ddb_update_homebrew_magic_item) or removed (ddb_delete_homebrew_magic_item).",
    fields,
    async (f) => text(JSON.stringify({ verified: true, ...(await hb.createHomebrewMagicItem(toBridge(f))) })),
  );

  server.tool(
    "ddb_update_homebrew_magic_item",
    "Update one of the account's homebrew magic items by id. Only the fields given change; everything else keeps its current value. A provided modifiers/conditions/spells list REPLACES that kind entirely ([] clears it). Read back and verified like create.",
    { itemId: z.number().int().positive(), ...updateFields },
    async ({ itemId, ...f }) => text(JSON.stringify({ verified: true, ...(await hb.updateHomebrewMagicItem(itemId, toBridge(f))) })),
  );

  server.tool(
    "ddb_delete_homebrew_magic_item",
    "Delete one of the account's homebrew magic items (and its modifiers, conditions and spells) by id. DDB soft-deletes: it stays listed as Deleted in My Creations; this server has no restore. Confirmed by a repeat delete answering 404.",
    { itemId: z.number().int().positive() },
    async ({ itemId }) => text(JSON.stringify(await hb.deleteHomebrewMagicItem(itemId))),
  );
}
