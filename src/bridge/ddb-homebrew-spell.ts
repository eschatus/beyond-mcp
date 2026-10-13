// D&D Beyond homebrew SPELL creation — create, update, delete — through the site's builder forms.
// Same approach as the monster module (ddb-homebrew.ts, docs/ddb-homebrew-protocol.md): GET the
// live form, fill controls by their stable element ids, POST them all, follow nothing, and prove
// the write by reading it back. A primitive surface: no policy, the caller owns intent.
//
// Routes, live-verified 2026-10-12/13 against throwaway private spells (docs/ddb-homebrew-types.md):
//   create   GET+POST /homebrew/creations/create-spell/create                multipart → 303 …/spells/{id}-{slug}/edit
//   update   GET+POST /homebrew/creations/spells/{id}-{slug}/edit            multipart → 303 (slug follows renames)
//   resolve  GET /homebrew/creations/edit?entityTypeId=1118725998&id={id}    302 → the current edit path
//   sub-add  GET+POST /spells/{modifier|condition|additional}/create/{id}    urlencoded → 302 …/edit#section
//   sub-del  POST /spells/{modifier|condition|additional}/{subId}/delete     (ajax-post)
//   delete   POST /homebrew/creations/delete?entityTypeId=1118725998&id={id} (ajax-post)
// The edit URL needs the current slug and the id alone 404s, so every id-only entry point resolves
// the slug through the generic /homebrew/creations/edit redirect.

import { rtSiteSession, rtRawFetch, type SiteSession } from "./ddb-rt.js";
import { parseForm, setControl, clearControl, controlById, type ParsedForm, type OptionValue } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  getPage, loadFormPage, submit, ajaxPost, verifyEditForm, deleteCreation, resolveEditPath, settle, SETTLE_DELAYS_MS,
  embeddedSubTypes, resolveSubType, embeddedSubTypeValue, type Asked,
} from "./ddb-homebrew-core.js";

let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const SPELL_ENTITY_TYPE_ID = 1118725998;
const CHAR_SVC_SPELLS = "https://character-service.dndbeyond.com/character/v5/game-data/spells";

// --- caller-facing field model (labels, not DDB ids) ---

export type SpellDie = 4 | 6 | 8 | 10 | 12 | 20;

export interface HomebrewSpellModifier {
  type: string;                                   // modifier type label: "Damage", "Bonus", "Resistance", …
  subType: string | number;                       // name within the type, or the subtype id when the name is ambiguous
  dice?: { count: number; die: SpellDie };
  fixedValue?: number;
  usesPrimaryStat?: boolean;                      // the "primary stat" checkbox
  duration?: { interval: number; unit: "Round" | "Minute" | "Hour" | "Day" };
  restriction?: string;
}
export interface HomebrewSpellCondition {
  effect: "apply" | "remove" | "suppress";
  condition: string;                              // "Charmed", "Poisoned", …
  duration?: { interval: number; unit: "Round" | "Minute" | "Hour" | "Day" | "Special" | "Until Dispelled" };
  exception?: string;
  hide?: boolean;
}
export interface HomebrewSpellHigherLevel {
  level: number;                                  // the slot level this entry applies from
  effect: string;                                 // "Additional Targets", "Extended Range", …
  dice?: { count: number; die: SpellDie };
  fixedValue?: number;
  details?: string;
}

export interface HomebrewSpellFields {
  // --- create form ---
  name?: string;
  version?: string;
  level?: string;                                 // "Cantrip", "1st" … "9th"
  school?: string;
  /** Replaces the whole casting-time group: an omitted `note` clears it. */
  castingTime?: { amount: number; activation: string; note?: string };
  /** Replaces the group: an omitted flag is false, an omitted materialText is blank. */
  components?: { verbal?: boolean; somatic?: boolean; material?: boolean; materialText?: string };
  /** Replaces the group: an omitted feet is blank (Self, Touch, Sight, Unlimited carry none). */
  range?: { origin: string; feet?: number };
  /** Replaces the group: omitted interval/unit are cleared. */
  duration?: { type: string; interval?: number; unit?: string };
  description?: string;                           // HTML
  ritual?: boolean;
  higherLevelScale?: string | null;               // "Character Level" | "Spell Scale" | "Spell Level"; null = no scaling
  classes?: Array<string | OptionValue>;          // class-mapping labels, or { value } when a label repeats
  // --- edit-only fields (applied by a follow-up save after create) ---
  areaOfEffect?: { type: string; size: number } | null;
  attack?: { type: "Melee" | "Ranged" } | null;   // ticks "as part of weapon attack"
  /** Replaces the group: omitted texts are cleared. */
  save?: { ability: string; onMiss?: string; onSuccess?: string; onFail?: string } | null;
  tags?: string[];
  // --- sub-entries; on update a provided list REPLACES that kind wholesale ([] clears it) ---
  modifiers?: HomebrewSpellModifier[];
  conditions?: HomebrewSpellCondition[];
  higherLevels?: HomebrewSpellHigherLevel[];
}

const EDIT_ONLY = ["areaOfEffect", "attack", "save", "tags"] as const;
const SUB_FIELDS = ["modifiers", "conditions", "higherLevels"] as const;
type SubKind = (typeof SUB_FIELDS)[number];

const LEVEL_LABEL = /^(Cantrip|[1-9](st|nd|rd|th))$/;

/** Input checks the server does weakly or not at all: fail before any request is made. */
export function validateSpellFields(f: HomebrewSpellFields, mode: "create" | "update"): void {
  const bad = (msg: string): never => { throw new Error(`ddb-homebrew spell: ${msg}`); };
  if (mode === "create") {
    for (const [k, v] of [["name", f.name], ["school", f.school], ["castingTime", f.castingTime], ["range", f.range], ["duration", f.duration]] as const) {
      if (v === undefined || v === "") bad(`"${k}" is required to create a spell`);
    }
    if (!f.classes?.length) bad(`"classes" needs at least one class-mapping label to create a spell (the builder rejects a spell with no class)`);
  } else if (f.classes && !f.classes.length) {
    bad(`"classes" cannot be emptied — a spell needs at least one class`);
  }
  if (f.name !== undefined && f.name.trim().length < 2) bad(`"name" must be at least 2 characters`);
  if (f.level !== undefined && !LEVEL_LABEL.test(f.level)) bad(`level "${f.level}" is not a builder label — use "Cantrip", "1st", "2nd" … "9th"`);
  if (f.castingTime && !(Number.isInteger(f.castingTime.amount) && f.castingTime.amount >= 0)) bad(`castingTime.amount must be a non-negative integer`);
  if (f.components?.materialText && !f.components.material) bad(`components.materialText was given but components.material is not true`);
  if (f.range?.feet !== undefined && !(Number.isInteger(f.range.feet) && f.range.feet >= 0)) bad(`range.feet must be a non-negative integer`);
  if (f.duration && (f.duration.interval === undefined) !== (f.duration.unit === undefined)) bad(`duration.interval and duration.unit go together — give both or neither`);
  if (f.areaOfEffect && !(Number.isInteger(f.areaOfEffect.size) && f.areaOfEffect.size >= 0)) bad(`areaOfEffect.size must be a non-negative integer`);
  if (f.save && !f.save.ability) bad(`save.ability is required when save is given`);
  for (const [i, h] of (f.higherLevels ?? []).entries()) {
    if (!Number.isInteger(h.level) || h.level < 1 || h.level > 9) bad(`higherLevels[${i}].level must be 1-9`);
    if (!h.effect) bad(`higherLevels[${i}].effect is required`);
  }
  for (const [i, c] of (f.conditions ?? []).entries()) {
    if (!["apply", "remove", "suppress"].includes(c.effect)) bad(`conditions[${i}].effect must be apply, remove or suppress`);
  }
  if (mode === "update" && !Object.values(f).some((v) => v !== undefined)) bad(`nothing to update — give at least one field`);
}

// --- filling the builder form ---

function setDescription(form: ParsedForm, html: string): void {
  setControl(form, "field-spell-description-type", "1");
  setControl(form, "field-spell-description-wysiwyg", html);
  setControl(form, "field-spell-description", html);
}

/**
 * Fill the spell builder form (create or edit) from caller fields; pure, so it is testable against
 * a captured page. Returns the non-description controls it set — what a re-read of the edit form
 * must show (descriptions aren't compared: the server may normalize their HTML). Group fields
 * (castingTime, components, range, duration, save) replace the whole group, so an omitted member is
 * explicitly cleared rather than left as whatever the form held.
 */
export function fillSpellForm(form: ParsedForm, f: HomebrewSpellFields): Asked {
  const asked: Asked = new Map();
  const record = (id: string) => asked.set(id, [...controlById(form, id).values]);
  const set = (id: string, v: Parameters<typeof setControl>[2] | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    record(id);
  };
  const clear = (id: string) => { clearControl(form, id); record(id); };
  const text = (id: string, v: string | number | undefined) => set(id, v === undefined ? "" : v);
  const select = (id: string, v: string | undefined) => { if (v === undefined) clear(id); else set(id, v); };

  set("field-Name", f.name);
  set("field-version", f.version);
  set("field-spell-level", f.level);
  set("field-spell-school", f.school);
  if (f.castingTime) {
    set("field-spell-casting-time", f.castingTime.amount);
    set("field-spell-activation", f.castingTime.activation);
    text("field-spell-casting-time-description", f.castingTime.note);
  }
  if (f.components) {
    set("field-verbal-field", f.components.verbal ?? false);
    set("field-somatic-field", f.components.somatic ?? false);
    set("field-material-field", f.components.material ?? false);
    text("field-spell-components", f.components.materialText);
  }
  if (f.range) {
    set("field-origin", f.range.origin);
    text("field-spell-range", f.range.feet);
  }
  if (f.duration) {
    set("field-spell-duration", f.duration.type);
    text("field-spell-duration-interval", f.duration.interval);
    select("field-spell-duration-unit", f.duration.unit);
  }
  if (f.description !== undefined) setDescription(form, f.description);
  set("field-can-cast-as-ritual", f.ritual);
  if (f.higherLevelScale !== undefined) {
    if (f.higherLevelScale === null) { clear("field-higher-level-scale"); set("field-can-cast-at-higher-level", false); }
    else { set("field-higher-level-scale", f.higherLevelScale); set("field-can-cast-at-higher-level", true); }
  }
  set("field-class-mapping", f.classes);

  if (f.areaOfEffect !== undefined) {
    if (f.areaOfEffect === null) { clear("field-spell-aoe"); text("field-spell-aoe-size", undefined); }
    else { set("field-spell-aoe", f.areaOfEffect.type); text("field-spell-aoe-size", f.areaOfEffect.size); }
  }
  if (f.attack !== undefined) {
    if (f.attack === null) { set("field-as-part-of-weapon-attack", false); clear("field-attack-type"); }
    else { set("field-as-part-of-weapon-attack", true); set("field-attack-type", f.attack.type); }
  }
  if (f.save !== undefined) {
    if (f.save === null) { clear("field-spell-save-type"); for (const id of ["field-on-miss", "field-spell-save-success", "field-spell-save-fail"]) text(id, undefined); }
    else {
      set("field-spell-save-type", f.save.ability);
      text("field-on-miss", f.save.onMiss);
      text("field-spell-save-success", f.save.onSuccess);
      text("field-spell-save-fail", f.save.onFail);
    }
  }
  set("field-spell-tags-public", f.tags);
  return asked;
}

// --- sub-entries (modifiers / conditions / higher-level entries) ---
//
// Each kind has its own form under /spells/{kind}/create/{spellId}. The edit page lists every
// entry with /spells/{kind}/{subId}/edit and …/delete links and is the only index of sub-entry
// ids. Sub-forms validate weakly (a blank one is accepted and creates an empty entry), so each
// entry is proven by reading its own edit form back and comparing a signature of its controls.

interface SubSpec<T> {
  kind: string;                                   // URL segment
  deleteLink: RegExp;
  /** Control ids whose values make up an entry's signature (see signature()). */
  sigIds: string[];
  fill(form: ParsedForm, html: string, entry: T): void;
}

const NUMERIC_IDS = new Set(["field-dice-count", "field-fixed-value", "field-dice-fixed", "field-duration", "field-condition-duration", "field-level"]);

/** A normalized fingerprint of an entry form: what was filled in, or what DDB now holds. */
function signature(form: ParsedForm, html: string, ids: string[]): string {
  const part = (id: string): string => {
    if (id === "field-spell-modifier-sub-type") {
      // The edit page doesn't mark the subtype in its flat select; the page script holds it.
      return embeddedSubTypeValue(html)?.toString() ?? controlById(form, id).values.join(",");
    }
    if (id === "condition-effect") {
      return ["apply", "remove", "suppress"].find((e) => controlById(form, `field-condition-effect-${e}`).values.length) ?? "";
    }
    const raw = controlById(form, id).values.map((v) => v.trim()).join(",");
    // A blank numeric reads back as "0" or "" depending on the field; they mean the same.
    return NUMERIC_IDS.has(id) ? String(Number(raw || 0)) : raw;
  };
  return JSON.stringify(ids.map(part));
}

const SUBS: { [K in SubKind]: SubSpec<NonNullable<HomebrewSpellFields[K]>[number]> } = {
  modifiers: {
    kind: "modifier",
    deleteLink: /href="\/spells\/modifier\/(\d+)\/delete"/g,
    sigIds: ["field-spell-modifier-type", "field-spell-modifier-sub-type", "field-dice-count", "field-dice-value", "field-fixed-value", "field-primary-stat", "field-duration", "field-duration-unit", "field-restriction"],
    fill(form, html, m: HomebrewSpellModifier) {
      setControl(form, "field-spell-modifier-type", m.type);
      const typeId = Number(controlById(form, "field-spell-modifier-type").values[0]);
      // The spell form's subtype select is one flat list with duplicate labels across types, and
      // the server accepts any type/subtype pairing — so resolve within the type via the page's
      // own catalogue and set the id raw.
      const subTypeId = resolveSubType(embeddedSubTypes(html), typeId, m.subType);
      controlById(form, "field-spell-modifier-sub-type").values = [String(subTypeId)];
      if (m.dice) { setControl(form, "field-dice-count", m.dice.count); setControl(form, "field-dice-value", `d${m.dice.die}`); }
      if (m.fixedValue !== undefined) setControl(form, "field-fixed-value", m.fixedValue);
      if (m.usesPrimaryStat !== undefined) setControl(form, "field-primary-stat", m.usesPrimaryStat);
      if (m.duration) { setControl(form, "field-duration", m.duration.interval); setControl(form, "field-duration-unit", m.duration.unit); }
      if (m.restriction !== undefined) setControl(form, "field-restriction", m.restriction);
    },
  },
  conditions: {
    kind: "condition",
    deleteLink: /href="\/spells\/condition\/(\d+)\/delete"/g,
    sigIds: ["condition-effect", "field-condition", "field-condition-duration", "field-duration-unit", "field-condition-exception", "field-hide"],
    fill(form, _html, c: HomebrewSpellCondition) {
      setControl(form, `field-condition-effect-${c.effect}`, true);
      setControl(form, "field-condition", c.condition);
      if (c.duration) { setControl(form, "field-condition-duration", c.duration.interval); setControl(form, "field-duration-unit", c.duration.unit); }
      if (c.exception !== undefined) setControl(form, "field-condition-exception", c.exception);
      if (c.hide !== undefined) setControl(form, "field-hide", c.hide);
    },
  },
  higherLevels: {
    kind: "additional",
    deleteLink: /href="\/spells\/additional\/(\d+)\/delete"/g,
    sigIds: ["field-level", "field-effect-type", "field-dice-count", "field-dice-value", "field-dice-fixed", "field-dice-details"],
    fill(form, _html, h: HomebrewSpellHigherLevel) {
      setControl(form, "field-level", h.level);
      setControl(form, "field-effect-type", h.effect);
      if (h.dice) { setControl(form, "field-dice-count", h.dice.count); setControl(form, "field-dice-value", `d${h.dice.die}`); }
      if (h.fixedValue !== undefined) setControl(form, "field-dice-fixed", h.fixedValue);
      if (h.details !== undefined) setControl(form, "field-dice-details", h.details);
    },
  },
};

// Add modifiers first so a higher-level entry could reference them; REMOVE in reverse: a
// higher-level entry can point at a modifier, so those go before the modifiers, then conditions.
const ADD_ORDER: SubKind[] = ["modifiers", "conditions", "higherLevels"];
const DELETE_ORDER: SubKind[] = ["higherLevels", "modifiers", "conditions"];

/** Sub-entry ids of one kind listed on a spell's edit page (each id appears on several links). */
export function subEntryIds(editHtml: string, kind: SubKind): number[] {
  return [...new Set([...editHtml.matchAll(SUBS[kind].deleteLink)].map((m) => Number(m[1])))];
}

type Expected = Partial<Record<SubKind, string[]>>;

async function addSubEntries(s: SiteSession, spellId: number, f: HomebrewSpellFields): Promise<Expected> {
  const expected: Expected = {};
  for (const kind of ADD_ORDER) {
    const entries = f[kind];
    if (entries === undefined) continue;
    const spec = SUBS[kind] as SubSpec<unknown>;
    expected[kind] = [];
    for (const [i, entry] of entries.entries()) {
      const { form, html } = await loadFormPage(s, `/spells/${spec.kind}/create/${spellId}`, new RegExp(`/spells/${spec.kind}/create/`));
      try { spec.fill(form, html, entry); }
      catch (err) { throw new Error(`${kind}[${i}]: ${(err as Error).message}`, { cause: err }); }
      expected[kind]!.push(signature(form, html, spec.sigIds));
      await submit(s, form, `add ${spec.kind} to spell ${spellId}`);
    }
  }
  return expected;
}

async function removeSubEntries(s: SiteSession, spellId: number, editPath: string, f: HomebrewSpellFields): Promise<void> {
  const html = await getPage(s, editPath);
  for (const kind of DELETE_ORDER) {
    if (f[kind] === undefined) continue;
    for (const sub of subEntryIds(html, kind)) await ajaxPost(s, `/spells/${SUBS[kind].kind}/${sub}/delete`, `remove ${SUBS[kind].kind} ${sub} from spell ${spellId}`);
  }
}

/** Mismatches between the entries asked (as signatures) and the entry forms DDB now serves. */
async function verifySubEntries(s: SiteSession, editHtml: string, expected: Expected): Promise<string[]> {
  const out: string[] = [];
  for (const kind of SUB_FIELDS) {
    const want = expected[kind];
    if (!want) continue;
    const spec = SUBS[kind] as SubSpec<unknown>;
    const ids = subEntryIds(editHtml, kind);
    if (ids.length !== want.length) { out.push(`${kind}: asked ${want.length}, the edit page lists ${ids.length}`); continue; }
    const got: string[] = [];
    for (const id of ids) {
      const { form, html } = await loadFormPage(s, `/spells/${spec.kind}/${id}/edit`, new RegExp(`/spells/${spec.kind}/${id}/edit`));
      got.push(signature(form, html, spec.sigIds));
    }
    if (JSON.stringify([...want].sort()) !== JSON.stringify(got.sort())) out.push(`${kind}: asked ${want.sort().join(" ")}, DDB has ${got.join(" ")}`);
  }
  return out;
}

// --- read-back verification ---
//
// Three oracles: the re-rendered EDIT FORM (every builder field), each sub-entry's own EDIT FORM,
// and character-service's game-data/spells (name, level, school, timing, range, duration, … — it
// returns LABELS, so it also checks the caller's labels independently of how this module resolved
// them to option ids). The JSON lists a spell only under a class it is mapped to, so the query uses
// a class the edit form itself reports.

/** Mismatches between the caller's labels and a game-data spell definition. Only fields the caller set are checked. */
export function verifyDefinition(def: any, f: HomebrewSpellFields, asked: Asked): string[] {
  const out: string[] = [];
  const eq = (field: string, want: unknown, got: unknown) => {
    const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
    if (norm(want) !== norm(got)) out.push(`${field}: asked ${JSON.stringify(want)}, DDB reads back ${JSON.stringify(got ?? null)}`);
  };
  if (f.name !== undefined) eq("name", f.name, def.name);
  if (f.version !== undefined) eq("version", f.version, def.version);
  if (f.level !== undefined) eq("level", f.level === "Cantrip" ? 0 : parseInt(f.level, 10), def.level);
  if (f.school !== undefined) eq("school", f.school, def.school);
  if (f.castingTime) {
    eq("castingTime.amount", f.castingTime.amount, def.activation?.activationTime);
    eq("castingTime.activation (option id)", asked.get("field-spell-activation")?.[0], def.activation?.activationType);
    eq("castingTime.note", f.castingTime.note ?? "", def.castingTimeDescription);
  }
  if (f.components) {
    const want = [f.components.verbal && 1, f.components.somatic && 2, f.components.material && 3].filter(Boolean);
    eq("components", JSON.stringify(want), JSON.stringify([...(def.components ?? [])].sort()));
    eq("components.materialText", f.components.materialText ?? "", def.componentsDescription);
  }
  if (f.range) {
    eq("range.origin", f.range.origin, def.range?.origin);
    eq("range.feet", f.range.feet ?? 0, def.range?.rangeValue ?? 0);
  }
  if (f.duration) {
    eq("duration.type", f.duration.type, def.duration?.durationType);
    eq("duration.interval", f.duration.interval ?? 0, def.duration?.durationInterval ?? 0);
    eq("duration.unit", f.duration.unit ?? "", def.duration?.durationUnit);
  }
  if (f.ritual !== undefined) eq("ritual", f.ritual, def.ritual);
  if (f.higherLevelScale !== undefined) eq("canCastAtHigherLevel", f.higherLevelScale !== null, def.canCastAtHigherLevel);
  if (f.areaOfEffect !== undefined) {
    eq("areaOfEffect.type", f.areaOfEffect?.type ?? "", def.range?.aoeType);
    eq("areaOfEffect.size", f.areaOfEffect?.size ?? 0, def.range?.aoeValue ?? 0);
  }
  if (f.attack !== undefined) eq("attack (as weapon attack)", f.attack !== null, def.asPartOfWeaponAttack);
  if (f.save !== undefined) eq("save.ability (option id)", f.save === null ? "" : asked.get("field-spell-save-type")?.[0], def.saveDcAbilityId);
  if (f.tags !== undefined) {
    const norm = (xs: unknown[]) => JSON.stringify(xs.map((x) => String(x).toLowerCase()).sort());
    eq("tags", norm(f.tags), norm(def.tags ?? []));
  }
  if (f.modifiers !== undefined) eq("modifiers (count)", f.modifiers.length, def.modifiers?.length ?? 0);
  if (f.conditions !== undefined) eq("conditions (count)", f.conditions.length, def.conditions?.length ?? 0);
  return out;
}

async function readDefinition(spellId: number, classId: string): Promise<any | null> {
  const res = await rtRawFetch(`${CHAR_SVC_SPELLS}?classId=${encodeURIComponent(classId)}&classLevel=20&sharingSetting=2`);
  if (res.status !== 200) throw new DdbWriteError(`ddb-homebrew spell ${spellId}: game-data/spells (classId ${classId}) → ${res.status}`, res.status, null);
  const json = await res.json() as { data?: Array<{ definition?: { id?: number } }> };
  return json.data?.find((x) => x.definition?.id === spellId)?.definition ?? null;
}

async function verifyOrThrow(s: SiteSession, spellId: number, editPath: string, asked: Asked, f: HomebrewSpellFields, expected: Expected): Promise<any> {
  const { value: def, mismatches } = await settle(async () => {
    const editHtml = await getPage(s, editPath);
    const edit = parseForm(editHtml, /\/edit$/);
    const mism = [...verifyEditForm(asked, edit), ...await verifySubEntries(s, editHtml, expected)];
    const mapped = controlById(edit, "field-class-mapping");
    // Prefer a base class: subclass-only mappings may not be listed under their own id.
    const classId = mapped.values.find((v) => !/ - |\(Legacy\)/.test(mapped.options.find((o) => o.value === v)?.label ?? "")) ?? mapped.values[0];
    let def: any = null;
    if (classId === undefined) mism.push("class-mapping: DDB reports no class on the spell");
    else {
      def = await readDefinition(spellId, classId);
      if (!def) mism.push(`game-data/spells (classId ${classId}) does not list the spell yet`);
      else mism.push(...verifyDefinition(def, f, asked));
    }
    return { value: def, mismatches: mism };
  }, settleDelays);
  if (mismatches.length) {
    throw new DdbWriteError(`ddb-homebrew: spell ${spellId} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  }
  return def;
}

// --- the primitives ---

const EDIT_LOCATION = /\/homebrew\/creations\/spells\/((\d+)-[^/?#]+)\/edit/;
const editUrl = (path: string) => `https://www.dndbeyond.com${path}`;

export interface HomebrewSpellWriteResult { id: number; editUrl: string; raw: any }

/** The current edit path of a spell (the slug follows renames and the id alone 404s). */
const editPathFor = (s: SiteSession, spellId: number) => resolveEditPath(s, SPELL_ENTITY_TYPE_ID, spellId);

/** POST the edit form with `f` applied; returns the (possibly renamed) edit path and what was asked. */
async function saveBuilder(s: SiteSession, spellId: number, editPath: string, f: HomebrewSpellFields): Promise<{ editPath: string; asked: Asked }> {
  const form = parseForm(await getPage(s, editPath), /\/edit$/);
  const asked = fillSpellForm(form, f);
  const location = await submit(s, form, `update spell ${spellId}`);
  const slug = location.match(EDIT_LOCATION)?.[1];
  if (!slug) throw new DdbWriteError(`ddb-homebrew update spell ${spellId}: unexpected redirect ${location}`, 303, location);
  return { editPath: `/homebrew/creations/spells/${slug}/edit`, asked };
}

const scalars = (f: HomebrewSpellFields): HomebrewSpellFields => {
  const rest = { ...f };
  for (const k of SUB_FIELDS) delete rest[k];
  return rest;
};

export async function createHomebrewSpell(f: HomebrewSpellFields): Promise<HomebrewSpellWriteResult> {
  validateSpellFields(f, "create");
  const s = rtSiteSession();
  const { form } = await loadFormPage(s, "/homebrew/creations/create-spell/create", /\/create-spell\/create$/);
  // area / attack / save / tags exist only on the EDIT form, so they go in a follow-up save.
  const base: HomebrewSpellFields = scalars(f);
  const followUp: HomebrewSpellFields = {};
  for (const k of EDIT_ONLY) if (base[k] !== undefined) { Object.assign(followUp, { [k]: base[k] }); delete base[k]; }
  const asked = fillSpellForm(form, base);
  const location = await submit(s, form, "create spell");
  const m = location.match(EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew create spell: unexpected redirect ${location}`, 303, location);
  const id = Number(m[2]);
  let editPath = `/homebrew/creations/spells/${m[1]}/edit`;
  // The spell exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    if (Object.keys(followUp).length) {
      const saved = await saveBuilder(s, id, editPath, followUp);
      editPath = saved.editPath;
      for (const [k, v] of saved.asked) asked.set(k, v);
    }
    const expected = await addSubEntries(s, id, f);
    const raw = await verifyOrThrow(s, id, editPath, asked, f, expected);
    return { id, editUrl: editUrl(editPath), raw };
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: spell ${id} was created (${m[1]}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

export async function updateHomebrewSpell(spellId: number, f: HomebrewSpellFields): Promise<HomebrewSpellWriteResult> {
  validateSpellFields(f, "update");
  const s = rtSiteSession();
  let editPath = await editPathFor(s, spellId);
  let asked: Asked = new Map();
  if (Object.values(scalars(f)).some((v) => v !== undefined)) ({ editPath, asked } = await saveBuilder(s, spellId, editPath, scalars(f)));
  await removeSubEntries(s, spellId, editPath, f);
  const expected = await addSubEntries(s, spellId, f);
  const raw = await verifyOrThrow(s, spellId, editPath, asked, f, expected);
  return { id: spellId, editUrl: editUrl(editPath), raw };
}

/** Delete a homebrew spell; confirmed by a repeat delete answering 404 (see deleteCreation). */
export async function deleteHomebrewSpell(spellId: number): Promise<{ id: number; deleted: true }> {
  const s = rtSiteSession();
  return deleteCreation(s, SPELL_ENTITY_TYPE_ID, spellId, await editPathFor(s, spellId));
}
