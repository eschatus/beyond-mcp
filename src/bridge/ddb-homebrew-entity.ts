// Shared sub-forms of DDB's homebrew "owner" entities: a limited-use ACTION ("Add Action") and an
// ENTITY SPELL (a spell grant). Feats, species traits and subclass/class features all carry the
// same two sub-forms; only the owner id and the owner's entity type id in the URL differ:
//   limited-use  GET+POST /entity/limited-use/create/{ownerId}-{ownerTypeId}   urlencoded → 302 /entity/limited-use/{id}/edit
//   uses         GET+POST /entity/limited-use/{id}/level-scale/create           urlencoded → 302 /entity/limited-use/{id}/edit
//   spell        GET+POST /entity/spell/create/{ownerId}-{ownerTypeId}          urlencoded → 302 {owner edit page}#spells
//   deletes      POST /entity/limited-use/{id}/delete, /entity/level-scale/{id}/delete, /entity/spell/{id}/delete
//                (all `ajax-post` behind a confirm modal: hrefs are taken verbatim from the owner's edit page)
// Owner entity type ids (live-verified for the first three): feat 1088085227, racial trait mapping
// 1960452172, class feature 12168134. Species option 1228963568 is NOT verified.
//
// Live-observed quirks (see docs/ddb-homebrew-types.md once these land there):
//   - The limited-use create form has NO number-of-uses control. Uses live in a separate
//     "limited use data" row (`level-scale`), added after the action exists. The owner page shows
//     that block only when the action has a Reset Type: rows posted for an action without one are
//     accepted and then invisible (and uncheckable), so uses without a reset are refused up front.
//   - Action Type is the one field DDB insists on (name alone → 200 + "An Action Type must be
//     selected"); a nameless action is accepted, so the name check is ours. Weapon needs an Attack
//     Range and a Ranged spell action needs a Range (server-validated, but we say so before posting).
//   - The browser's page script DISABLES fields that don't apply (save DC without a save type, AoE
//     size without an AoE type, …), which a browser then never submits. We post every control, so
//     "doesn't apply" is checked here and a stray value is an error instead of a silent drop.
//   - Entity-spell creates answer with a redirect to the OWNER's edit page — no sub-id. One POST is
//     ONE row however many spells the multi-select holds. An entirely empty form is accepted and
//     makes a useless empty row, so that is refused up front. The id is found by diffing the owner's
//     spell listing across the POST.
//   - Feats' spell form lacks eight controls that class features and species traits have
//     (always prepared, counts as known, consumes warlock slot, available-at-level, min/max
//     charges, save DC, restriction). Asking for one on a feat is an error.
//   - Level-scale rows allow several "Base" rows and duplicate levels without complaint; we refuse them.
//   - Reads lag writes: verification runs through settle().

import { parse } from "node-html-parser";
import type { SiteSession } from "./ddb-rt.js";
import { parseForm, setControl, controlById, type ParsedForm, type OptionValue, type FormControl } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import { getPage, loadFormPage, submit, settle, SETTLE_DELAYS_MS, type Asked } from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const ENTITY_OWNER_TYPE_IDS = {
  feat: 1088085227,
  racialTrait: 1960452172,
  classFeature: 12168134,
  /** Options are owners too (live 2026-10-13, used by the feat and subclass modules). */
  featOption: 400581042,
  classFeatureOption: 258900837,
  /** Linked from a species trait option's edit page (modifier/spell/limited-use); not yet exercised. */
  speciesTraitOption: 306912077,
  /** Not an owner of these forms: a species option's traits are racial-trait mappings (1960452172). */
  speciesOption: 1228963568,
} as const;

// --- caller-facing field model (labels, not DDB ids) ---

export type EntityAbility = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";
/** A select option by LABEL, or { value } where labels repeat. */
export type EntityOptionRef = string | OptionValue;
export type UsesOperator = "add" | "multiply";

/**
 * How many uses. DDB computes `count <op> ability modifier`, then `<op> proficiency bonus`; the
 * listing prints e.g. "Proficiency Bonus", "2 + CON Modifier", "2 x Proficiency Bonus".
 * "Number of times equal to your Proficiency Bonus" is { proficiencyBonus: true }.
 */
export interface HomebrewUses {
  count?: number;                         // non-negative integer base, default 0
  abilityModifier?: EntityAbility;
  abilityOperator?: UsesOperator;         // count <op> modifier; default "add"
  proficiencyBonus?: boolean;
  proficiencyBonusOperator?: UsesOperator; // default "add"
}

/** A uses row; `level` makes it apply from that character level up (rows without one are the base). */
export interface HomebrewUsesScale extends HomebrewUses { level?: number }

export interface HomebrewLimitedUse {
  name: string;
  actionType: "General" | "Weapon" | "Spell";
  description?: string;                   // HTML
  snippet?: string;
  level?: number;                         // 1-20: character level at which the action is granted
  activation?: EntityOptionRef;           // "Action", "Bonus Action", "Reaction", "No Action", "Minute", "Hour", "Special"
  activationTime?: number;                // the N of "10 Minutes"; only with Minute / Hour / Special
  reset?: EntityOptionRef;                // "Short Rest", "Long Rest", "Dawn", "Other"
  uses?: HomebrewUsesScale | HomebrewUsesScale[]; // needs `reset`
  abilityScore?: EntityAbility;           // "Ability Score Type": the stat behind the attack / save DC
  proficient?: boolean;
  attackRange?: "Melee" | "Ranged";       // required for Weapon actions
  attackSubtype?: "Natural" | "Unarmed";  // Weapon only
  displayAsAttack?: boolean;
  martialArts?: boolean;
  onMiss?: string;                        // "Effect on Miss"; needs attackRange
  save?: { ability: EntityAbility; dc?: number; onSuccess?: string; onFail?: string };
  damage?: { dice?: { count: number; die: 4 | 6 | 8 | 10 | 12 | 20 | 100 }; fixedValue?: number; type?: EntityOptionRef };
  spellRange?: EntityOptionRef;           // Spell only: "Self", "Touch", "Ranged", "Sight", "Unlimited"
  range?: number;                         // feet; required for a Ranged spell, valid for Weapon actions
  longRange?: number;                     // Ranged weapon attacks only
  areaOfEffect?: { type: EntityOptionRef; size?: number; special?: boolean };
}

export interface HomebrewEntitySpell {
  /** Spells granted: a full label ("Alarm - [Level 1]"), a unique plain name ("Alarm"), or { value } (the spell id). */
  spells?: EntityOptionRef[];
  // Filters (a "choose a spell like this" grant instead of / besides named spells)
  levels?: number[];                      // 0 = cantrip … 9
  classes?: EntityOptionRef[];            // class labels repeat for Legacy ("Wizard" ×2): pass { value }
  schools?: string[];
  attackType?: "Melee" | "Ranged" | "Melee and Ranged";
  levelDivisor?: 2 | 3 | 4 | 5;
  onlyRituals?: boolean;
  // Casting
  castingAbility?: EntityAbility;
  uses?: HomebrewUses;                    // number of times it can be cast
  reset?: EntityOptionRef;                // "Short Rest", "Long Rest", "Dawn", "Other"
  castAtLevel?: number;                   // 1-9
  castingTime?: number;
  activation?: EntityOptionRef;           // "Action", "Bonus Action", …
  rangeType?: EntityOptionRef;            // "Self", "Touch", "Ranged", "Sight", "Unlimited"
  range?: number;
  additionalDescription?: string;
  ritual?: "Can Cast As Ritual" | "Must Cast As Ritual";
  atWill?: boolean;                       // "Is Infinite"
  // Class features and species traits only (the feat form has none of these)
  alwaysPrepared?: boolean;
  countsAsKnown?: boolean;
  consumesWarlockSlot?: boolean;
  availableAtLevel?: number;
  minCharges?: number;
  maxCharges?: number;
  saveDc?: number;
  restriction?: string;
}

// --- validation (before anything is posted) ---

const bad = (m: string): never => { throw new DdbWriteError(`ddb-homebrew entity: ${m}`, 400, null); };
const isNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const isLevel = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20;
const refIsNamed = (r: EntityOptionRef | undefined, ...names: string[]) => typeof r === "string" && names.includes(r.trim().toLowerCase());

function validateUses(u: HomebrewUses, where: string): void {
  if (u.count !== undefined && !isNonNegInt(u.count)) bad(`${where}.count must be a non-negative integer`);
  if (u.abilityOperator !== undefined && !u.abilityModifier) bad(`${where}.abilityOperator needs abilityModifier`);
  if (u.proficiencyBonusOperator !== undefined && !u.proficiencyBonus) bad(`${where}.proficiencyBonusOperator needs proficiencyBonus: true`);
  if (!(u.count ?? 0) && !u.abilityModifier && !u.proficiencyBonus) bad(`${where} grants 0 uses — set count, abilityModifier or proficiencyBonus`);
}

export const usesList = (a: HomebrewLimitedUse): HomebrewUsesScale[] => (a.uses === undefined ? [] : Array.isArray(a.uses) ? a.uses : [a.uses]);

/** Structural checks that need no network, so a bad request fails before anything is created. */
export function validateLimitedUse(a: HomebrewLimitedUse): void {
  const who = `action "${a.name}"`;
  if (!a.name?.trim()) bad("a limited-use action needs a name (DDB accepts a nameless one and lists a blank row)");
  if (!["General", "Weapon", "Spell"].includes(a.actionType)) bad(`${who}: actionType must be General, Weapon or Spell`);
  if (a.level !== undefined && !isLevel(a.level)) bad(`${who}: level must be an integer 1-20`);
  const weapon = a.actionType === "Weapon", spell = a.actionType === "Spell";
  if (weapon && !a.attackRange) bad(`${who}: a Weapon action needs attackRange (Melee or Ranged)`);
  if (a.attackSubtype && !weapon) bad(`${who}: attackSubtype only applies to Weapon actions`);
  if (a.spellRange !== undefined && !spell) bad(`${who}: spellRange only applies to Spell actions`);
  if (spell && refIsNamed(a.spellRange, "ranged") && a.range === undefined) bad(`${who}: a Ranged spell action needs range (feet)`);
  if (a.onMiss !== undefined && !a.attackRange) bad(`${who}: onMiss ("Effect on Miss") needs attackRange`);
  if (a.longRange !== undefined && !(weapon && a.attackRange === "Ranged")) bad(`${who}: longRange only applies to Ranged weapon actions`);
  if (a.range !== undefined && !(weapon || spell)) bad(`${who}: range applies to Weapon and Spell actions`);
  for (const [k, v] of [["range", a.range], ["longRange", a.longRange], ["activationTime", a.activationTime]] as const) {
    if (v !== undefined && !isNonNegInt(v)) bad(`${who}: ${k} must be a non-negative integer`);
  }
  if (a.activationTime !== undefined && !(typeof a.activation === "string" ? ["hour", "minute", "special"].includes(a.activation.trim().toLowerCase()) : a.activation !== undefined)) {
    bad(`${who}: activationTime only applies with activation Minute, Hour or Special`);
  }
  if (a.save) {
    if (a.save.dc !== undefined && !isNonNegInt(a.save.dc)) bad(`${who}: save.dc must be a non-negative integer`);
  }
  if (a.damage?.dice) {
    const { count, die } = a.damage.dice;
    if (!Number.isInteger(count) || count < 1) bad(`${who}: damage.dice.count must be a positive integer`);
    if (![4, 6, 8, 10, 12, 20, 100].includes(die)) bad(`${who}: damage.dice.die must be one of 4, 6, 8, 10, 12, 20, 100`);
  }
  if (a.damage?.fixedValue !== undefined && !Number.isInteger(a.damage.fixedValue)) bad(`${who}: damage.fixedValue must be an integer`);
  if (a.areaOfEffect) {
    if (a.areaOfEffect.size !== undefined && !isNonNegInt(a.areaOfEffect.size)) bad(`${who}: areaOfEffect.size must be a non-negative integer`);
  }
  const uses = usesList(a);
  if (uses.length) {
    if (a.reset === undefined) bad(`${who}: uses need a reset ("Short Rest", "Long Rest", "Dawn" or "Other") — DDB hides and ignores the uses of an action with no reset type`);
    const seen = new Set<number | "base">();
    uses.forEach((u, i) => {
      validateUses(u, `${who}: uses[${i}]`);
      if (u.level !== undefined && !isLevel(u.level)) bad(`${who}: uses[${i}].level must be an integer 1-20`);
      const key = u.level ?? "base";
      if (seen.has(key)) bad(`${who}: two uses rows for ${key === "base" ? "the base (no level)" : `level ${key}`} — DDB accepts the duplicate but the result is ambiguous`);
      seen.add(key);
    });
  }
}

export function validateEntitySpell(sp: HomebrewEntitySpell): void {
  const filters = [sp.levels?.length, sp.classes?.length, sp.schools?.length, sp.attackType, sp.levelDivisor, sp.onlyRituals];
  if (!sp.spells?.length && !filters.some(Boolean)) {
    bad("a spell grant needs spells and/or a filter (levels, classes, schools, attackType, …) — DDB accepts an empty one and keeps a useless blank row");
  }
  for (const l of sp.levels ?? []) if (!Number.isInteger(l) || l < 0 || l > 9) bad(`spell level filter ${l} must be an integer 0-9`);
  if (sp.castAtLevel !== undefined && !(Number.isInteger(sp.castAtLevel) && sp.castAtLevel >= 1 && sp.castAtLevel <= 9)) bad("castAtLevel must be an integer 1-9");
  if (sp.uses) validateUses(sp.uses, "uses");
  for (const [k, v] of [["castingTime", sp.castingTime], ["range", sp.range], ["minCharges", sp.minCharges], ["maxCharges", sp.maxCharges], ["saveDc", sp.saveDc]] as const) {
    if (v !== undefined && !isNonNegInt(v)) bad(`${k} must be a non-negative integer`);
  }
  if (sp.availableAtLevel !== undefined && !isLevel(sp.availableAtLevel)) bad("availableAtLevel must be an integer 1-20");
}

// --- form fill ---

const OP_LABEL: Record<UsesOperator, string> = { add: "1", multiply: "2" }; // option values: "+ (Addition)" = 1, "x (Multiplication)" = 2
const OP_NAME: Record<string, UsesOperator> = { "1": "add", "2": "multiply" };

function setter(form: ParsedForm, asked: Asked, owner: string) {
  const has = (id: string) => form.controls.some((c) => c.id === id);
  return (id: string, v: Parameters<typeof setControl>[2] | undefined, what: string) => {
    if (v === undefined) return;
    if (!has(id)) bad(`this ${owner} form has no control for ${what} (#${id}) — DDB doesn't offer it on this owner type`);
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
}

// A description is a (hidden type, wysiwyg, markup) trio; the server reads the wysiwyg copy.
function setDescription(set: ReturnType<typeof setter>, key: string, html: string): void {
  set(`field-${key}-type`, "1", "description");
  set(`field-${key}-wysiwyg`, html, "description");
  set(`field-${key}`, html, "description");
}

function fillUsesControls(set: ReturnType<typeof setter>, u: HomebrewUses, ids: { count: string; op: string; stat: string; pb: string; pbOp: string }): void {
  set(ids.count, u.count ?? 0, "uses.count");
  set(ids.op, { value: OP_LABEL[u.abilityOperator ?? "add"] }, "uses.abilityOperator");
  if (u.abilityModifier) set(ids.stat, u.abilityModifier, "uses.abilityModifier");
  set(ids.pb, u.proficiencyBonus ?? false, "uses.proficiencyBonus");
  set(ids.pbOp, { value: OP_LABEL[u.proficiencyBonusOperator ?? "add"] }, "uses.proficiencyBonusOperator");
}

export interface FilledLimitedUse {
  /** Control id → values set: what a re-read of the action's edit form must show. */
  asked: Asked;
}

/**
 * Fill the limited-use create/edit form (the uses rows are separate: see fillUsesScaleForm). Pure.
 * Throws on a field this form doesn't have or that doesn't apply to the action type.
 */
export function fillLimitedUseForm(form: ParsedForm, a: HomebrewLimitedUse): FilledLimitedUse {
  validateLimitedUse(a);
  // Live: on feats and species traits ("character" owners in the page script) an attack range or a
  // save needs an Ability Score Type; class features don't (DDB: "An Ability Score must be specified
  // for this action" otherwise). The create URL names the owner type; an edit form's doesn't.
  const ownerType = Number(form.action.match(/\/create\/\d+-(\d+)/)?.[1]);
  if (ownerType && ownerType !== ENTITY_OWNER_TYPE_IDS.classFeature && (a.attackRange || a.save) && !a.abilityScore) {
    bad(`action "${a.name}": on this owner type an attackRange or save needs abilityScore ("Ability Score Type") — DDB refuses the action without it`);
  }
  const asked: Asked = new Map();
  const set = setter(form, asked, "limited-use");
  set("field-action-type", a.actionType, "actionType");
  set("field-name-field", a.name, "name");
  set("field-snippet-field", a.snippet, "snippet");
  if (a.description !== undefined) setDescription(set, "description-field", a.description);
  set("field-level", a.level === undefined ? undefined : String(a.level), "level");
  set("field-activation", a.activation, "activation");
  set("field-activation-time", a.activationTime, "activationTime");
  set("field-reset-type", a.reset, "reset");
  set("field-ability-score-type", a.abilityScore, "abilityScore");
  set("field-is-proficient", a.proficient, "proficient");
  set("field-attack-range", a.attackRange, "attackRange");
  set("field-attack-subtype", a.attackSubtype, "attackSubtype");
  set("field-is-martial-arts", a.martialArts, "martialArts");
  set("field-on-miss-description-field", a.onMiss, "onMiss");
  if (a.save) {
    set("field-ability-score-save-type", a.save.ability, "save.ability");
    set("field-fixed-save-dc", a.save.dc, "save.dc");
    set("field-action-save-success", a.save.onSuccess, "save.onSuccess");
    set("field-action-save-fail", a.save.onFail, "save.onFail");
  }
  if (a.damage) {
    if (a.damage.dice) { set("field-dice-count", a.damage.dice.count, "damage.dice"); set("field-die-type", `d${a.damage.dice.die}`, "damage.dice"); }
    set("field-fixed-value", a.damage.fixedValue, "damage.fixedValue");
    set("field-damage-type", a.damage.type, "damage.type");
  }
  // The page script flips "Display As Attack" to Yes when a weapon action gains a save or dice and
  // the field is still blank; a browserless post has no script, so apply the same default.
  const displayAsAttack = a.displayAsAttack ?? (a.actionType === "Weapon" && (a.save || a.damage?.dice) ? true : undefined);
  set("field-display-as-attack", displayAsAttack === undefined ? undefined : displayAsAttack ? "Yes" : "No", "displayAsAttack");
  set("field-spell-range-type", a.spellRange, "spellRange");
  set("field-range", a.range, "range");
  set("field-long-range", a.longRange, "longRange");
  if (a.areaOfEffect) {
    set("field-area-of-effect-type", a.areaOfEffect.type, "areaOfEffect.type");
    set("field-area-of-effect-size", a.areaOfEffect.size, "areaOfEffect.size");
    set("field-aoe-special-description", a.areaOfEffect.special, "areaOfEffect.special");
  }
  return { asked };
}

/** Fill a limited-use "uses" row (`…/level-scale/create`). Pure. Returns what its edit form must show. */
export function fillUsesScaleForm(form: ParsedForm, u: HomebrewUsesScale): Asked {
  validateUses(u, "uses");
  const asked: Asked = new Map();
  const set = setter(form, asked, "limited-use uses");
  fillUsesControls(set, u, { count: "field-number-of-uses", op: "field-operator", stat: "field-stat-modifier", pb: "field-use-proficiency-bonus", pbOp: "field-proficiency-bonus-operator" });
  set("field-level", u.level === undefined ? undefined : String(u.level), "level");
  return asked;
}

// --- spell option resolution ---

const plainSpellName = (label: string) => label.replace(/\s+-\s+\[[^\]]*\]\s*$/, "").trim();

/**
 * The option VALUE (spell id) for a spell reference on the multi-select. The labels are
 * "Acid Splash - [Cantrip]" and unique in full, so: exact full label, then exact plain name
 * ("Acid Splash", which never matches the "(Legacy)" twin), each case-insensitively second.
 * Several hits (a homebrew spell sharing a name) throw with the candidate values — pass { value }.
 */
export function resolveSpellOption(c: FormControl, ref: EntityOptionRef): string {
  if (typeof ref === "object") {
    if (!c.options.some((o) => o.value === ref.value && o.value !== "")) bad(`no spell with value "${ref.value}" on this form`);
    return ref.value;
  }
  const want = ref.trim();
  const tiers: Array<(label: string) => boolean> = [
    (l) => l === want,
    (l) => plainSpellName(l) === want,
    (l) => l.toLowerCase() === want.toLowerCase(),
    (l) => plainSpellName(l).toLowerCase() === want.toLowerCase(),
  ];
  for (const match of tiers) {
    const hits = c.options.filter((o) => o.value !== "" && match(o.label));
    if (hits.length > 1) bad(`spell "${want}" is ambiguous — ${hits.map((h) => `${h.value} ("${h.label}")`).join(", ")}; pass { value } to choose`);
    if (hits.length === 1) return hits[0].value;
  }
  const near = c.options.filter((o) => o.label.toLowerCase().includes(want.toLowerCase())).map((o) => o.label).slice(0, 8);
  return bad(`"${want}" is not a spell on this form${near.length ? `. Similar: ${near.join(", ")}` : ""}. Legacy spells are "Name (Legacy) - [Level n]".`);
}

export interface FilledEntitySpell {
  asked: Asked;
  /** The spells selected, resolved (id + the label DDB lists them under). */
  spells: Array<{ value: string; label: string }>;
}

/** Fill the entity-spell create/edit form. Pure. Throws on a control the owner's form lacks. */
export function fillEntitySpellForm(form: ParsedForm, sp: HomebrewEntitySpell): FilledEntitySpell {
  validateEntitySpell(sp);
  const asked: Asked = new Map();
  const set = setter(form, asked, "entity spell");
  const spellControl = controlById(form, "field-spell");
  const picked = (sp.spells ?? []).map((r) => resolveSpellOption(spellControl, r));
  if (new Set(picked).size !== picked.length) bad("the same spell is listed twice");
  if (picked.length) set("field-spell", picked.map((value) => ({ value })), "spells");
  if (sp.levels?.length) set("field-spell-levels", sp.levels.map((l) => ({ value: String(l) })), "levels");
  if (sp.classes?.length) set("field-spell-class", sp.classes, "classes");
  if (sp.schools?.length) set("field-spell-school", sp.schools, "schools");
  set("field-attack-type", sp.attackType, "attackType");
  set("field-level-divisor", sp.levelDivisor === undefined ? undefined : String(sp.levelDivisor), "levelDivisor");
  set("field-must-be-ritual", sp.onlyRituals, "onlyRituals");
  set("field-ability-score", sp.castingAbility, "castingAbility");
  if (sp.uses) fillUsesControls(set, sp.uses, { count: "field-number-of-uses", op: "field-operator", stat: "field-number-of-uses-ability-modifier", pb: "field-use-proficiency-bonus", pbOp: "field-proficiency-bonus-operator" });
  set("field-reset-type", sp.reset, "reset");
  set("field-cast-at-level", sp.castAtLevel === undefined ? undefined : String(sp.castAtLevel), "castAtLevel");
  set("field-spell-casting-time", sp.castingTime, "castingTime");
  set("field-spell-activation", sp.activation, "activation");
  set("field-origin", sp.rangeType, "rangeType");
  set("field-spell-range", sp.range, "range");
  set("field-additional-description", sp.additionalDescription, "additionalDescription");
  set("field-ritual-cast-type", sp.ritual, "ritual");
  set("field-is-infinite", sp.atWill, "atWill");
  const yn = (b: boolean | undefined) => (b === undefined ? undefined : b ? "Yes" : "No");
  set("field-always-prepared", yn(sp.alwaysPrepared), "alwaysPrepared");
  set("field-counts-as-known-spell", yn(sp.countsAsKnown), "countsAsKnown");
  set("field-consumes-warlock-slot", yn(sp.consumesWarlockSlot), "consumesWarlockSlot");
  set("field-available-at-character-level", sp.availableAtLevel, "availableAtLevel");
  set("field-min-charges", sp.minCharges, "minCharges");
  set("field-max-charges", sp.maxCharges, "maxCharges");
  set("field-save-dc", sp.saveDc, "saveDc");
  set("field-restriction", sp.restriction, "restriction");
  return { asked, spells: picked.map((value) => ({ value, label: spellControl.options.find((o) => o.value === value)!.label })) };
}

// --- reading the owner's edit page ---

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const tableRows = (html: string, tableClass: string) =>
  parse(html, { blockTextElements: { script: false, style: false, textarea: true } }).querySelectorAll(`table.${tableClass} tbody tr`);
const headers = (html: string, tableClass: string): string[] =>
  parse(html, { blockTextElements: { script: false, style: false, textarea: true } }).querySelectorAll(`table.${tableClass} thead th`).map((th) => clean(th.text));

export interface ListedLimitedUse {
  id: number;
  name: string;
  activation: string;      // as listed: "Action", "10 Minutes", …
  dice: string;            // "2d6"
  reset: string;           // "Long Rest"
  editHref: string;
  deleteHref: string;
}

/** The limited-use actions listed on an owner's edit page (all owner types: `listing-rpgentity-limited-use-mapping`). */
export function listLimitedUses(ownerEditHtml: string): ListedLimitedUse[] {
  return tableRows(ownerEditHtml, "listing-rpgentity-limited-use-mapping").flatMap((tr) => {
    const edit = tr.toString().match(/href="(\/entity\/limited-use\/(\d+)\/edit)"/);
    const del = tr.toString().match(/href="(\/entity\/limited-use\/\d+\/delete)"/);
    if (!edit || !del) return [];
    const td = tr.querySelectorAll("td").map((x) => clean(x.text));
    return [{ id: Number(edit[2]), name: td[0] ?? "", activation: td[1] ?? "", dice: td[2] ?? "", reset: td[3] ?? "", editHref: edit[1], deleteHref: del[1] }];
  });
}

export interface ListedEntitySpell {
  id: number;
  /** The "Spells" cell: spell names joined by ", " (empty for a filter-only grant). */
  spellsText: string;
  /** Every cell keyed by its column header ("Levels", "Classes", "School", "Minimum Charges", …; the Edit column excluded). */
  cells: Record<string, string>;
  editHref: string;
  deleteHref: string;
}

/** The spell grants listed on an owner's edit page (`listing-rpgentity-spell-mapping`). */
export function listEntitySpells(ownerEditHtml: string): ListedEntitySpell[] {
  const cols = headers(ownerEditHtml, "listing-rpgentity-spell-mapping");
  return tableRows(ownerEditHtml, "listing-rpgentity-spell-mapping").flatMap((tr) => {
    const edit = tr.toString().match(/href="(\/entity\/spell\/(\d+)\/edit)"/);
    const del = tr.toString().match(/href="(\/entity\/spell\/\d+\/delete)"/);
    if (!edit || !del) return [];
    const td = tr.querySelectorAll("td").map((x) => clean(x.text));
    const cells: Record<string, string> = {};
    cols.forEach((h, i) => { if (h !== "Edit") cells[h] = td[i] ?? ""; });
    return [{ id: Number(edit[2]), spellsText: cells["Spells"] ?? td[0] ?? "", cells, editHref: edit[1], deleteHref: del[1] }];
  });
}

export interface ListedUsesScale { id: number; level: string; uses: string; editHref: string; deleteHref: string }

/** The uses rows on an action's own edit page ("Base" | "5", "Proficiency Bonus" | "2 + CON Modifier" | "2 x Proficiency Bonus" | "3"). */
export function listUsesScales(limitedUseEditHtml: string): ListedUsesScale[] {
  return tableRows(limitedUseEditHtml, "listing-rpgentity-limited-use-level-scale").flatMap((tr) => {
    const edit = tr.toString().match(/href="(\/entity\/level-scale\/(\d+)\/edit)"/);
    const del = tr.toString().match(/href="(\/entity\/level-scale\/\d+\/delete)"/);
    if (!edit || !del) return [];
    const td = tr.querySelectorAll("td").map((x) => clean(x.text));
    return [{ id: Number(edit[2]), level: td[0] ?? "", uses: td[1] ?? "", editHref: edit[1], deleteHref: del[1] }];
  });
}

/**
 * Delete hrefs of one sub-entry kind on an owner's edit page, verbatim (the hrefs are the contract),
 * for the ajaxPost() calls of a replace. Deleting a limited-use action takes its uses rows with it.
 */
export function entityDeleteLinks(ownerEditHtml: string, kind: "limitedUse" | "spell"): string[] {
  const re = kind === "limitedUse" ? /href="(\/entity\/limited-use\/\d+\/delete)"/g : /href="(\/entity\/spell\/\d+\/delete)"/g;
  return [...new Set([...ownerEditHtml.matchAll(re)].map((m) => m[1]))];
}

// --- reading a sub-entry's own edit form ---

const selectedLabel = (form: ParsedForm, id: string): string | undefined => {
  const c = form.controls.find((x) => x.id === id);
  if (!c) return undefined;
  const v = c.values[0];
  if (v === undefined || v === "") return undefined;
  return c.options.find((o) => o.value === v)?.label ?? v;
};
const textOf = (form: ParsedForm, id: string): string | undefined => {
  const v = form.controls.find((x) => x.id === id)?.values[0];
  return v === undefined || v === "" ? undefined : v;
};
const numOf = (form: ParsedForm, id: string): number | undefined => { const t = textOf(form, id); return t === undefined ? undefined : Number(t); };
const checked = (form: ParsedForm, id: string): boolean | undefined => {
  const c = form.controls.find((x) => x.id === id);
  return c ? c.values.length > 0 : undefined;
};
const yesNo = (form: ParsedForm, id: string): boolean | undefined => { const l = selectedLabel(form, id); return l === undefined ? undefined : l === "Yes"; };
const labelsOf = (form: ParsedForm, id: string): string[] => {
  const c = form.controls.find((x) => x.id === id);
  return (c?.values ?? []).map((v) => c!.options.find((o) => o.value === v)?.label ?? v);
};

export interface ReadLimitedUse {
  id: number;
  form: ParsedForm;
  /** The form read back in the caller's own vocabulary (labels). Unset fields are undefined. */
  value: Omit<HomebrewLimitedUse, "uses">;
}

/** Parse a limited-use action's own edit page (`/entity/limited-use/{id}/edit`). */
export function parseLimitedUseEdit(html: string): ReadLimitedUse {
  const form = parseForm(html, /\/entity\/limited-use\/\d+\/edit$/);
  const id = Number(form.action.match(/limited-use\/(\d+)\/edit/)![1]);
  const die = selectedLabel(form, "field-die-type");
  const diceCount = numOf(form, "field-dice-count");
  const saveAbility = selectedLabel(form, "field-ability-score-save-type") as EntityAbility | undefined;
  const aoeType = selectedLabel(form, "field-area-of-effect-type");
  const fixedValue = numOf(form, "field-fixed-value");
  const damageType = selectedLabel(form, "field-damage-type");
  const value: ReadLimitedUse["value"] = {
    name: textOf(form, "field-name-field") ?? "",
    actionType: selectedLabel(form, "field-action-type") as HomebrewLimitedUse["actionType"],
    description: textOf(form, "field-description-field-wysiwyg"),
    snippet: textOf(form, "field-snippet-field"),
    level: numOf(form, "field-level"),
    activation: selectedLabel(form, "field-activation"),
    activationTime: numOf(form, "field-activation-time"),
    reset: selectedLabel(form, "field-reset-type"),
    abilityScore: selectedLabel(form, "field-ability-score-type") as EntityAbility | undefined,
    proficient: checked(form, "field-is-proficient"),
    attackRange: selectedLabel(form, "field-attack-range") as HomebrewLimitedUse["attackRange"],
    attackSubtype: selectedLabel(form, "field-attack-subtype") as HomebrewLimitedUse["attackSubtype"],
    displayAsAttack: yesNo(form, "field-display-as-attack"),
    martialArts: checked(form, "field-is-martial-arts"),
    onMiss: textOf(form, "field-on-miss-description-field"),
    save: saveAbility ? { ability: saveAbility, dc: numOf(form, "field-fixed-save-dc"), onSuccess: textOf(form, "field-action-save-success"), onFail: textOf(form, "field-action-save-fail") } : undefined,
    damage: die || diceCount !== undefined || fixedValue !== undefined || damageType
      ? { dice: die && diceCount !== undefined ? { count: diceCount, die: Number(die.replace(/^d/, "")) as 4 } : undefined, fixedValue, type: damageType }
      : undefined,
    spellRange: selectedLabel(form, "field-spell-range-type"),
    range: numOf(form, "field-range"),
    longRange: numOf(form, "field-long-range"),
    areaOfEffect: aoeType ? { type: aoeType, size: numOf(form, "field-area-of-effect-size"), special: checked(form, "field-aoe-special-description") } : undefined,
  };
  return { id, form, value };
}

export interface ReadUsesScale { id: number; form: ParsedForm; value: Required<Pick<HomebrewUses, "count" | "abilityOperator" | "proficiencyBonus" | "proficiencyBonusOperator">> & Pick<HomebrewUsesScale, "abilityModifier" | "level"> }

/** Parse a uses row's own edit page (`/entity/level-scale/{id}/edit`). */
export function parseUsesScaleEdit(html: string): ReadUsesScale {
  const form = parseForm(html, /\/entity\/level-scale\/\d+\/edit$/);
  const id = Number(form.action.match(/level-scale\/(\d+)\/edit/)![1]);
  const lvl = textOf(form, "field-level");
  return {
    id, form,
    value: {
      count: numOf(form, "field-number-of-uses") ?? 0,
      abilityOperator: OP_NAME[form.controls.find((c) => c.id === "field-operator")?.values[0] ?? "1"],
      abilityModifier: selectedLabel(form, "field-stat-modifier") as EntityAbility | undefined,
      proficiencyBonus: checked(form, "field-use-proficiency-bonus") ?? false,
      proficiencyBonusOperator: OP_NAME[form.controls.find((c) => c.id === "field-proficiency-bonus-operator")?.values[0] ?? "1"],
      level: lvl === undefined ? undefined : Number(lvl),
    },
  };
}

export interface ReadEntitySpell {
  id: number;
  form: ParsedForm;
  /** Selected spells as { value, label }. */
  spells: Array<{ value: string; label: string }>;
  value: Omit<HomebrewEntitySpell, "spells">;
}

/** Parse a spell grant's own edit page (`/entity/spell/{id}/edit`). */
export function parseEntitySpellEdit(html: string): ReadEntitySpell {
  const form = parseForm(html, /\/entity\/spell\/\d+\/edit$/);
  const id = Number(form.action.match(/spell\/(\d+)\/edit/)![1]);
  const sc = form.controls.find((c) => c.id === "field-spell")!;
  const stat = selectedLabel(form, "field-number-of-uses-ability-modifier") as EntityAbility | undefined;
  const pb = checked(form, "field-use-proficiency-bonus");
  const count = numOf(form, "field-number-of-uses");
  const hasUses = count !== undefined || stat !== undefined || pb;
  const levels = labelsOf(form, "field-spell-levels");
  const classes = form.controls.find((c) => c.id === "field-spell-class")?.values ?? [];
  const schools = labelsOf(form, "field-spell-school");
  const opName = (id: string) => OP_NAME[form.controls.find((c) => c.id === id)?.values[0] ?? "1"];
  return {
    id, form,
    spells: sc.values.map((v) => ({ value: v, label: sc.options.find((o) => o.value === v)?.label ?? v })),
    value: {
      levels: levels.length ? levels.map((l) => (l === "Cantrip" ? 0 : Number(l))) : undefined,
      classes: classes.length ? classes.map((value) => ({ value })) : undefined,
      schools: schools.length ? schools : undefined,
      attackType: selectedLabel(form, "field-attack-type") as HomebrewEntitySpell["attackType"],
      levelDivisor: numOf(form, "field-level-divisor") as HomebrewEntitySpell["levelDivisor"],
      onlyRituals: checked(form, "field-must-be-ritual"),
      castingAbility: selectedLabel(form, "field-ability-score") as EntityAbility | undefined,
      uses: hasUses ? { count, abilityModifier: stat, abilityOperator: opName("field-operator"), proficiencyBonus: pb, proficiencyBonusOperator: opName("field-proficiency-bonus-operator") } : undefined,
      reset: selectedLabel(form, "field-reset-type"),
      castAtLevel: numOf(form, "field-cast-at-level"),
      castingTime: numOf(form, "field-spell-casting-time"),
      activation: selectedLabel(form, "field-spell-activation"),
      rangeType: selectedLabel(form, "field-origin"),
      range: numOf(form, "field-spell-range"),
      additionalDescription: textOf(form, "field-additional-description"),
      ritual: selectedLabel(form, "field-ritual-cast-type") as HomebrewEntitySpell["ritual"],
      atWill: checked(form, "field-is-infinite"),
      alwaysPrepared: yesNo(form, "field-always-prepared"),
      countsAsKnown: yesNo(form, "field-counts-as-known-spell"),
      consumesWarlockSlot: yesNo(form, "field-consumes-warlock-slot"),
      availableAtLevel: numOf(form, "field-available-at-character-level"),
      minCharges: numOf(form, "field-min-charges"),
      maxCharges: numOf(form, "field-max-charges"),
      saveDc: numOf(form, "field-save-dc"),
      restriction: textOf(form, "field-restriction"),
    },
  };
}

// --- verification ---

/** Mismatches between what a fill asked and what the re-read edit form holds (HTML compared whitespace-insensitively). */
export function entityFormMismatches(asked: Asked, edit: ParsedForm): string[] {
  const out: string[] = [];
  const norm = (vs: string[]) => vs.map(clean).sort();
  for (const [id, want] of asked) {
    const got = edit.controls.find((c) => c.id === id)?.values ?? [];
    if (JSON.stringify(norm(want)) !== JSON.stringify(norm(got))) out.push(`${id}: asked ${JSON.stringify(want)}, DDB has ${JSON.stringify(got)}`);
  }
  return out;
}

const scaleKey = (u: { count?: number; abilityModifier?: string; abilityOperator?: string; proficiencyBonus?: boolean; proficiencyBonusOperator?: string; level?: number }) =>
  JSON.stringify([u.count ?? 0, u.abilityModifier ?? null, u.abilityModifier ? (u.abilityOperator ?? "add") : null, Boolean(u.proficiencyBonus), u.proficiencyBonus ? (u.proficiencyBonusOperator ?? "add") : null, u.level ?? null]);

export interface AddedLimitedUse {
  /** The new action's id (from the create redirect). */
  id: number;
  editPath: string;
  asked: Asked;
  /** The uses rows that were added, as asked (verifyLimitedUse matches them against what DDB lists). */
  uses: HomebrewUsesScale[];
}

/** POST a form and require a redirect to `expect`, returning its first capture group's match. */
async function postForId(s: SiteSession, form: ParsedForm, what: string, expect: RegExp): Promise<RegExpMatchArray> {
  const location = await submit(s, form, what);
  const m = location.match(expect);
  if (!m) throw new DdbWriteError(`ddb-homebrew ${what}: unexpected redirect ${location}`, 302, location);
  return m;
}

/**
 * Add a limited-use action (and its uses rows) to an owner. The action exists from the first POST
 * on; a failure after that names its id so the caller can delete it.
 */
export async function addLimitedUse(s: SiteSession, ownerId: number, ownerTypeId: number, a: HomebrewLimitedUse): Promise<AddedLimitedUse> {
  validateLimitedUse(a);
  const { form } = await loadFormPage(s, `/entity/limited-use/create/${ownerId}-${ownerTypeId}`, /\/entity\/limited-use\/create\//);
  const { asked } = fillLimitedUseForm(form, a);
  const what = `add limited-use action "${a.name}" to owner ${ownerId}-${ownerTypeId}`;
  const id = Number((await postForId(s, form, what, /\/entity\/limited-use\/(\d+)\/edit/))[1]);
  const uses = usesList(a);
  try {
    for (const u of uses) {
      const sf = await loadFormPage(s, `/entity/limited-use/${id}/level-scale/create`, /\/level-scale\/create$/);
      fillUsesScaleForm(sf.form, u);
      await postForId(s, sf.form, `add uses row to limited-use action ${id}`, new RegExp(`/entity/limited-use/${id}/edit`));
    }
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: limited-use action ${id} ("${a.name}") was created, then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
  return { id, editPath: `/entity/limited-use/${id}/edit`, asked, uses };
}

/**
 * Read back an added action (settle-retried): its own edit form against what was asked, and its
 * uses rows (matched as a set) against the uses asked. Throws DdbWriteError listing mismatches.
 */
export async function verifyLimitedUse(s: SiteSession, added: AddedLimitedUse): Promise<ReadLimitedUse> {
  const { value, mismatches } = await settle(async () => {
    const html = await getPage(s, added.editPath);
    const read = parseLimitedUseEdit(html);
    const out = entityFormMismatches(added.asked, read.form);
    const rows = listUsesScales(html);
    if (rows.length !== added.uses.length) out.push(`uses rows: asked ${added.uses.length}, action lists ${rows.length}`);
    else if (rows.length) {
      const got: string[] = [];
      for (const r of rows) got.push(scaleKey(parseUsesScaleEdit(await getPage(s, r.editHref)).value));
      const want = added.uses.map(scaleKey);
      if (JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort())) out.push(`uses rows: asked ${JSON.stringify(want)}, DDB has ${JSON.stringify(got)}`);
    }
    return { value: read, mismatches: out };
  }, settleDelays);
  if (mismatches.length) throw new DdbWriteError(`ddb-homebrew: limited-use action ${added.id} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  return value;
}

export interface AddedEntitySpell {
  /** The new row's id, found by diffing the owner's spell listing across the POST (the redirect carries none). */
  id: number;
  editPath: string;
  asked: Asked;
  spells: Array<{ value: string; label: string }>;
}

/**
 * Add a spell grant to an owner. The redirect goes to the owner's edit page and carries no
 * sub-id, so the owner's spell listing (its path is the create form's Cancel link) is read before
 * and after, and the new id is the one that appears. Throws if none or several appear within the
 * settle window (a concurrent writer on the same owner would make it ambiguous).
 */
export async function addEntitySpell(s: SiteSession, ownerId: number, ownerTypeId: number, sp: HomebrewEntitySpell): Promise<AddedEntitySpell> {
  validateEntitySpell(sp);
  const { form, html } = await loadFormPage(s, `/entity/spell/create/${ownerId}-${ownerTypeId}`, /\/entity\/spell\/create\//);
  const filled = fillEntitySpellForm(form, sp);
  const ownerPath = parse(html).querySelector("a.button-cancel")?.getAttribute("href")?.replace(/#.*$/, "");
  if (!ownerPath) throw new DdbWriteError(`ddb-homebrew add spell to owner ${ownerId}-${ownerTypeId}: the create form has no Cancel link to the owner page (DDB changed the page?)`, 200, null);
  const before = new Set(listEntitySpells(await getPage(s, ownerPath)).map((r) => r.id));
  await submit(s, form, `add spell grant to owner ${ownerId}-${ownerTypeId}`);
  const { value: fresh, mismatches } = await settle(async () => {
    const rows = listEntitySpells(await getPage(s, ownerPath)).filter((r) => !before.has(r.id));
    return { value: rows, mismatches: rows.length === 1 ? [] : [`${rows.length} new spell rows on the owner page (expected 1)`] };
  }, settleDelays);
  if (fresh.length !== 1) {
    throw new DdbWriteError(`ddb-homebrew: spell grant was POSTed to owner ${ownerId}-${ownerTypeId} but ${mismatches.join("; ")} — check ${ownerPath} and delete strays`, 200, fresh.map((r) => r.id));
  }
  return { id: fresh[0].id, editPath: `/entity/spell/${fresh[0].id}/edit`, asked: filled.asked, spells: filled.spells };
}

/** Read back an added spell grant (settle-retried) against what was asked. Throws DdbWriteError listing mismatches. */
export async function verifyEntitySpell(s: SiteSession, added: AddedEntitySpell): Promise<ReadEntitySpell> {
  const { value, mismatches } = await settle(async () => {
    const read = parseEntitySpellEdit(await getPage(s, added.editPath));
    return { value: read, mismatches: entityFormMismatches(added.asked, read.form) };
  }, settleDelays);
  if (mismatches.length) throw new DdbWriteError(`ddb-homebrew: spell grant ${added.id} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  return value;
}
