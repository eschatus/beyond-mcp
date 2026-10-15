// D&D Beyond homebrew SUBCLASS creation — create, update, delete — without the site's builder UX.
//
// Same approach as ddb-homebrew.ts (monsters): drive the site's own server-rendered builder forms,
// address controls by their stable element ids, verify by reading back. Subclasses differ from
// every other homebrew type in three ways, all live-verified on 2026-10-12 / 2026-10-13:
//   create   POST /homebrew/creations/create-subclass (class-type label) → 302 /classes/{classId}-{slug}/subclass/create
//            (creates NOTHING — it only resolves the parent class), then
//            POST /classes/{classId}-{slug}/subclass/create multipart → **200** + the new subclass page.
//            There is no redirect and no Location: the new id is read out of the body. A blind retry
//            created a duplicate live, so a create is POSTed exactly once, and an unreadable answer is an
//            error that says a subclass MAY exist (see /my-creations).
//   update   POST /classes/{parentClassId}-{slug}/subclass/{id}/edit multipart → 200 + re-render
//            (numeric id, slug ignored). The parent class is resolved from the id alone through the
//            generic GET /homebrew/creations/edit?entityTypeId=789467139&id={id} → 302 …/subclass/{id}/edit.
//   features POST /classes/{subId}-{subSlug}/class-feature/create multipart → 302 …/class-feature/{fid}/edit;
//            delete is an ajax-post on /classes/{subId}-{CURRENT subSlug}/class-feature/{fid}/delete.
//            A feature's type (Granted / Additional / Replacement) is CREATE-ONLY: an edit silently
//            ignores it, so a type change means delete + recreate — which is what a provided features
//            list does, wholesale.
//   modifiers / level scales of a feature: the generic /modifier/create/{fid}-12168134/0 form and
//            /entity/levelscale/create/{fid}-12168134 (urlencoded → 302).
// There is NO JSON read-back for private subclasses; the oracles are the subclass edit form, the feature
// table on the subclass edit page, and each feature's own edit page (form + modifier / level-scale tables).

import { parse } from "node-html-parser";
import { rtSiteSession, type SiteSession } from "./ddb-rt.js";
import { parseForm, setControl, controlById, formErrors, encodeForm, type ParsedForm, type ControlValue, type OptionValue } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  getPage, loadForm, submit, ajaxPost, verifyEditForm, deleteCreation, resolveEditPath, settle, SETTLE_DELAYS_MS,
  embeddedSubTypes, fillModifierForm, type Asked, type HomebrewModifier,
} from "./ddb-homebrew-core.js";
import {
  addLimitedUse, verifyLimitedUse, addEntitySpell, verifyEntitySpell, listLimitedUses, listEntitySpells,
  type HomebrewLimitedUse, type HomebrewEntitySpell,
} from "./ddb-homebrew-entity.js";

export type { HomebrewModifier } from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const SUBCLASS_ENTITY_TYPE_ID = 789467139;          // same id as classes
export const CLASS_FEATURE_ENTITY_TYPE_ID = 12168134;
/** Owner type of a class-feature OPTION (live 2026-10-13: the option edit page links /modifier|spell|limited-use/create/{optId}-258900837). */
export const CLASS_FEATURE_OPTION_ENTITY_TYPE_ID = 258900837;

// --- caller-facing field model (labels, not DDB ids) ---

export type FeatureType = "Granted" | "Additional" | "Replacement";
export type Ability = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";
/** A select option by LABEL, or by numeric option id where labels repeat (Legacy duplicates). */
export type OptionRef = string | OptionValue;   // label, or { value } where labels repeat

export interface HomebrewLevelScale {
  level: number;
  dice?: { count: number; die: 4 | 6 | 8 | 10 | 12 | 20 };
  fixedValue?: number;
  description?: string;
}

/**
 * A choosable option of a feature (`/classes/{sub}/class-feature/{fid}/option/create`). Replace semantics
 * come with the feature: a provided features list recreates every option. Options own modifiers, limited-use
 * actions and spell grants exactly like a feature does (owner type 258900837).
 */
export interface HomebrewFeatureOption {
  name: string;
  snippet?: string;
  description: string;                 // HTML
  multiclassDescription?: string;      // HTML
  /** "Is Granted": the option is always given instead of chosen. */
  isGranted?: boolean;
  /** Character level at which the option unlocks (1-20). */
  requiredLevel?: number;
  /**
   * Only offered when another option is chosen: that option as the builder labels it, "Feature name - Option name"
   * (e.g. "Lineage - First House"). The target must belong to a feature created EARLIER in the same list.
   */
  dependsOn?: string;
  prerequisiteText?: string;
  modifiers?: HomebrewModifier[];
  limitedUses?: HomebrewLimitedUse[];
  spells?: HomebrewEntitySpell[];
}

export interface HomebrewSubclassFeature {
  name: string;
  snippet?: string;
  description: string;                 // HTML
  multiclassDescription?: string;      // HTML
  level: number;                       // required character level, 1-20
  displayOrder?: number;
  type: FeatureType;                   // create-only
  hasOptions?: boolean;
  displayRequiredLevel?: boolean;
  hideInBuilder?: boolean;
  hideInSheet?: boolean;
  modifiers?: HomebrewModifier[];
  levelScales?: HomebrewLevelScale[];
  /** Choosable options; "has options" is switched on automatically. */
  options?: HomebrewFeatureOption[];
  /** Limited-use actions of the feature (shared entity form). */
  limitedUses?: HomebrewLimitedUse[];
  /** Spell grants of the feature (shared entity form); one entry = one DDB row. */
  spells?: HomebrewEntitySpell[];
}

export interface HomebrewSubclassSpellcasting {
  ability?: Ability;
  canCastSpells?: boolean;
  additionalSpellLists?: OptionRef[];  // class names ("Cleric") or option ids; [] clears
  prepareType?: "Half Level" | "Level";
  knowsAllSpells?: boolean;
  learningStyle?: "Learned" | "Prepared";
  additionalSpells?: OptionRef[];      // spell names ("Alarm") or option ids; [] clears
}

export interface HomebrewSubclassFields {
  name?: string;                       // ≤ 50
  version?: string;
  shortDescription?: string;           // HTML
  description?: string;                // HTML
  spellcasting?: HomebrewSubclassSpellcasting;
  /** On update a provided list REPLACES every feature (new ones are created first, then the old ones deleted). */
  features?: HomebrewSubclassFeature[];
}

/** Create needs the parent class ("Wizard"; pass the option id where a label repeats, e.g. Legacy classes). */
export type HomebrewSubclassCreate = HomebrewSubclassFields & { className: OptionRef; name: string; shortDescription: string; description: string };

export interface HomebrewSubclassFeatureRow { id: number; name: string; level: number; order: string; type: string }
export interface HomebrewSubclassResult {
  id: number;
  name: string;
  parentClassId: number;
  editUrl: string;
  features: HomebrewSubclassFeatureRow[];
}

// --- form fill ---

const optionValue = (o: OptionRef): ControlValue => o;
const yesNo = (b: boolean) => (b ? "Yes" : "No");

// Each description is a (hidden type, wysiwyg, markup) trio; type 1 = wysiwyg. The server reads the
// wysiwyg copy, so both textareas carry the same HTML.
function setDescription(form: ParsedForm, key: string, html: string): void {
  setControl(form, `field-${key}-type`, "1");
  setControl(form, `field-${key}-wysiwyg`, html);
  setControl(form, `field-${key}`, html);
}

/**
 * Fill the subclass builder form (create and edit share it). Pure (no I/O). Returns the non-description
 * controls it set — what a re-read of the edit form must show (descriptions are excluded: the server
 * may normalize HTML).
 */
export function fillSubclassForm(form: ParsedForm, f: HomebrewSubclassFields): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: ControlValue | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-name", f.name);
  set("field-version", f.version);
  if (f.shortDescription !== undefined) setDescription(form, "subclass-short-description", f.shortDescription);
  if (f.description !== undefined) setDescription(form, "subclass-description", f.description);
  const sc = f.spellcasting;
  if (sc) {
    set("field-spell-casting-ability", sc.ability);
    set("field-can-cast-spells", sc.canCastSpells === undefined ? undefined : yesNo(sc.canCastSpells));
    set("field-additional-spell-list", sc.additionalSpellLists?.map(optionValue) as ControlValue | undefined);
    set("field-spell-prepare-type", sc.prepareType);
    set("field-knows-all-spells", sc.knowsAllSpells === undefined ? undefined : yesNo(sc.knowsAllSpells));
    set("field-spell-learning-style", sc.learningStyle);
    set("field-spell-mapping", sc.additionalSpells?.map(optionValue) as ControlValue | undefined);
  }
  return asked;
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, "");

/** Up-front feature validation, so nothing is created for input the builder would reject mid-way. */
export function validateFeature(f: HomebrewSubclassFeature): void {
  const who = `feature "${f.name}"`;
  if (!f.name.trim() || f.name.length > 1024) throw new Error(`ddb-homebrew-subclass: ${who}: name must be 1-1024 characters`);
  if (!Number.isInteger(f.level) || f.level < 1 || f.level > 20) throw new Error(`ddb-homebrew-subclass: ${who}: level must be an integer 1-20`);
  if (textOf(f.description).length < 4) throw new Error(`ddb-homebrew-subclass: ${who}: description needs at least 4 characters of text (the builder rejects less)`);
  if (!["Granted", "Additional", "Replacement"].includes(f.type)) throw new Error(`ddb-homebrew-subclass: ${who}: type must be Granted, Additional or Replacement`);
  const seen = new Set<string>();
  for (const o of f.options ?? []) {
    const ow = `${who} option "${o.name}"`;
    if (!o.name.trim() || o.name.length > 1024) throw new Error(`ddb-homebrew-subclass: ${ow}: name must be 1-1024 characters`);
    if (seen.has(o.name)) throw new Error(`ddb-homebrew-subclass: ${ow}: duplicate option name in one feature`);
    seen.add(o.name);
    if (textOf(o.description).length < 4) throw new Error(`ddb-homebrew-subclass: ${ow}: description needs at least 4 characters of text`);
    if (o.requiredLevel !== undefined && (!Number.isInteger(o.requiredLevel) || o.requiredLevel < 1 || o.requiredLevel > 20)) throw new Error(`ddb-homebrew-subclass: ${ow}: requiredLevel must be an integer 1-20`);
    if (f.hasOptions === false) throw new Error(`ddb-homebrew-subclass: ${who}: hasOptions is false but options were given`);
  }
}

/** Fill the option form (/option/create and /option/{id}/edit share it). Returns what an edit page must read back. */
export function fillOptionForm(form: ParsedForm, o: HomebrewFeatureOption, dependsOnValue?: OptionValue): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: ControlValue | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-name", o.name);
  set("field-snippet", o.snippet);
  setDescription(form, "class-feature-option-description", o.description);
  if (o.multiclassDescription !== undefined) setDescription(form, "multiclass-class-feature-option-description", o.multiclassDescription);
  set("field-is-granted", o.isGranted);
  set("field-required-level", o.requiredLevel === undefined ? undefined : String(o.requiredLevel));
  set("field-dependent-class-feature-option", dependsOnValue ?? o.dependsOn);
  set("field-prerequisite-text", o.prerequisiteText);
  return asked;
}

/** Fill the class-feature form. Returns what an edit page must read back (descriptions excluded). */
export function fillFeatureForm(form: ParsedForm, f: HomebrewSubclassFeature): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: ControlValue | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-name", f.name);
  set("field-snippet", f.snippet);
  setDescription(form, "class-feature-description", f.description);
  if (f.multiclassDescription !== undefined) setDescription(form, "multiclass-class-feature-description", f.multiclassDescription);
  set("field-required-level", String(f.level));
  set("field-display-order-field", f.displayOrder === undefined ? undefined : String(f.displayOrder));
  set("field-has-options", f.hasOptions ?? (f.options?.length ? true : undefined));
  set("field-display-required-level", f.displayRequiredLevel);
  set("field-hide-in-builder", f.hideInBuilder);
  set("field-hide-in-sheet", f.hideInSheet);
  set("field-feature-type", f.type);
  return asked;
}

// --- page parsing ---

const EDIT_ACTION = /\/subclass\/\d+\/edit$/;
const FEATURE_EDIT_ACTION = /\/class-feature\/\d+\/edit$/;

/** The subclass's CURRENT `{id}-{slug}`, from its "Add a Class Feature" link. Throws if the page isn't a saved subclass. */
export function subclassSlug(html: string): string {
  const m = html.match(/href="\/classes\/(\d+-[^"/]+)\/class-feature\/create"/);
  if (!m) throw new Error("ddb-homebrew-subclass: page has no /class-feature/create link — it is not a saved subclass page (session not logged in, or DDB changed the page)");
  return m[1];
}

interface TableRow extends HomebrewSubclassFeatureRow { deleteHref: string }

/** The feature table on a subclass edit page: level, display order, name, type, and the row's links. */
export function featureRows(html: string): TableRow[] {
  const root = parse(html);
  return root.querySelectorAll("table.listing-rpgclass-feature tbody tr").flatMap((tr) => {
    const cells = tr.querySelectorAll("td").map((td) => td.text.replace(/\s+/g, " ").trim());
    const edit = tr.querySelector('a[href$="/edit"]')?.getAttribute("href") ?? "";
    const del = tr.querySelector('a[href$="/delete"]')?.getAttribute("href") ?? "";
    const id = edit.match(/\/class-feature\/(\d+)\/edit$/)?.[1];
    if (!id || cells.length < 4) return [];
    return [{ id: Number(id), level: Number(cells[0]), order: cells[1], name: cells[2], type: cells[3], deleteHref: del }];
  });
}

const rowsOf = (root: ReturnType<typeof parse>, cls: string) =>
  root.querySelectorAll(`table.${cls} tbody tr`).map((tr) => tr.querySelectorAll("td").map((td) => td.text.replace(/\s+/g, " ").trim()));

/** Modifier rows ("Resistance - Fire", …) and level-scale rows [level, dice, fixed, description] on a feature edit page. */
export function featureChildren(html: string): { modifiers: string[]; levelScales: string[][] } {
  const root = parse(html);
  return {
    modifiers: rowsOf(root, "listing-rpgentity-modifier").map((c) => c[0]),
    levelScales: rowsOf(root, "listing-rpgentity-level-scale").map((c) => c.slice(0, 4)),
  };
}

// --- routes ---

/** Resolve a subclass's edit path (with its parent class) from the id alone. */
async function editPathFor(s: SiteSession, id: number): Promise<{ editPath: string; parentClassId: number }> {
  const editPath = await resolveEditPath(s, SUBCLASS_ENTITY_TYPE_ID, id);
  const m = editPath.match(/^\/classes\/(\d+)-[^/?#]+\/subclass\/(\d+)\/edit/);
  if (!m || Number(m[2]) !== id) {
    throw new DdbWriteError(`ddb-homebrew-subclass: id ${id} resolved to ${editPath}, which is not a subclass edit page — it is not one of this account's homebrew subclasses (see /my-creations)`, 302, editPath);
  }
  return { editPath: editPath.replace(/[?#].*$/, ""), parentClassId: Number(m[1]) };
}

const siteUrl = (path: string) => `https://www.dndbeyond.com${path}`;

// --- features ---

type AddedActions = Awaited<ReturnType<typeof addLimitedUse>>[];
type AddedSpells = Awaited<ReturnType<typeof addEntitySpell>>[];

interface PlacedOption {
  id: number;
  spec: HomebrewFeatureOption;
  asked: Asked;
  modifiers: string[];
  limitedUses: AddedActions;
  spells: AddedSpells;
}

interface Placed {
  id: number;
  spec: HomebrewSubclassFeature;
  asked: Asked;
  modifiers: string[];      // the labels the modifier table must list, e.g. "Resistance - Fire"
  levelScales: string[][];  // [level, dice, fixed, description] rows the level-scale table must list
  limitedUses: AddedActions;
  spells: AddedSpells;
  options: PlacedOption[];
}

/** Add one modifier to a feature / option owner; returns the label its table row must show. */
async function addModifier(s: SiteSession, ownerId: number, ownerTypeId: number, m: HomebrewModifier): Promise<string> {
  const html = await getPage(s, `/modifier/create/${ownerId}-${ownerTypeId}/0`);
  const mform = parseForm(html, /modifier\/create/);
  const { typeId, subTypeId } = fillModifierForm(mform, html, m);
  const typeLabel = controlById(mform, "field-spell-modifier-type").options.find((o) => o.value === String(typeId))?.label ?? "";
  const subName = embeddedSubTypes(html).find((x) => x.id === subTypeId)?.name ?? "";
  await submit(s, mform, `add modifier to owner ${ownerId}-${ownerTypeId}`);
  return `${typeLabel} - ${subName}`;
}

/** Limited-use actions and spell grants of one owner (feature or option), each added once. */
async function addEntities(s: SiteSession, ownerId: number, ownerTypeId: number, spec: { limitedUses?: HomebrewLimitedUse[]; spells?: HomebrewEntitySpell[] }): Promise<{ limitedUses: AddedActions; spells: AddedSpells }> {
  const limitedUses: AddedActions = [];
  const spells: AddedSpells = [];
  for (const a of spec.limitedUses ?? []) limitedUses.push(await addLimitedUse(s, ownerId, ownerTypeId, a));
  for (const sp of spec.spells ?? []) spells.push(await addEntitySpell(s, ownerId, ownerTypeId, sp));
  return { limitedUses, spells };
}

/** Option labels ("Feature - Option") created so far in this call -> their ids: an update runs while the OLD options still exist, so a label alone would be ambiguous. */
type CreatedOptions = Map<string, string>;

async function createOption(s: SiteSession, slug: string, fid: number, featureName: string, o: HomebrewFeatureOption, created: CreatedOptions): Promise<PlacedOption> {
  const form = await loadForm(s, `/classes/${slug}/class-feature/${fid}/option/create`, /option\/create$/);
  const target = o.dependsOn === undefined ? undefined : created.get(o.dependsOn);
  const asked = fillOptionForm(form, o, target === undefined ? undefined : { value: target });
  const location = await submit(s, form, `create option "${o.name}" on feature ${fid}`);
  const id = location.match(/\/option\/(\d+)\/edit/)?.[1];
  if (!id) throw new DdbWriteError(`ddb-homebrew-subclass: create option "${o.name}": unexpected redirect ${location}`, 302, location);
  const oid = Number(id);
  created.set(`${featureName} - ${o.name}`, id);
  const placed: PlacedOption = { id: oid, spec: o, asked, modifiers: [], limitedUses: [], spells: [] };
  try {
    for (const m of o.modifiers ?? []) placed.modifiers.push(await addModifier(s, oid, CLASS_FEATURE_OPTION_ENTITY_TYPE_ID, m));
    Object.assign(placed, await addEntities(s, oid, CLASS_FEATURE_OPTION_ENTITY_TYPE_ID, o));
  } catch (err) {
    throw new DdbWriteError(`option "${o.name}" was created (id ${oid}), then: ${(err as Error).message}`, (err as DdbWriteError).status ?? 500, (err as DdbWriteError).detail ?? null);
  }
  return placed;
}

const levelScaleRow = (l: HomebrewLevelScale) => [String(l.level), l.dice ? `${l.dice.count}d${l.dice.die}` : "", l.fixedValue === undefined ? "" : String(l.fixedValue), l.description ?? ""];

/** Create one feature with its modifiers and level scales. Each POST is made once; nothing here retries. */
async function createFeature(s: SiteSession, slug: string, f: HomebrewSubclassFeature, created: CreatedOptions): Promise<Placed> {
  const form = await loadForm(s, `/classes/${slug}/class-feature/create`, /class-feature\/create$/);
  const asked = fillFeatureForm(form, f);
  const location = await submit(s, form, `create feature "${f.name}"`);
  const id = location.match(/\/class-feature\/(\d+)\/edit/)?.[1];
  if (!id) throw new DdbWriteError(`ddb-homebrew-subclass: create feature "${f.name}": unexpected redirect ${location}`, 302, location);
  const fid = Number(id);
  const placed: Placed = { id: fid, spec: f, asked, modifiers: [], levelScales: [], limitedUses: [], spells: [], options: [] };
  try {
    for (const m of f.modifiers ?? []) placed.modifiers.push(await addModifier(s, fid, CLASS_FEATURE_ENTITY_TYPE_ID, m));
    for (const l of f.levelScales ?? []) {
      const lform = await loadForm(s, `/entity/levelscale/create/${fid}-${CLASS_FEATURE_ENTITY_TYPE_ID}`, /levelscale\/create/);
      setControl(lform, "field-level", String(l.level));
      if (l.dice) { setControl(lform, "field-dice-count", l.dice.count); setControl(lform, "field-dice-value", `d${l.dice.die}`); }
      if (l.fixedValue !== undefined) setControl(lform, "field-fixed-value", l.fixedValue);
      if (l.description !== undefined) setControl(lform, "field-description", l.description);
      await submit(s, lform, `add level scale to feature ${fid}`);
      placed.levelScales.push(levelScaleRow(l));
    }
    Object.assign(placed, await addEntities(s, fid, CLASS_FEATURE_ENTITY_TYPE_ID, f));
    for (const o of f.options ?? []) placed.options.push(await createOption(s, slug, fid, f.name, o, created));
  } catch (err) {
    throw new DdbWriteError(`ddb-homebrew-subclass: feature "${f.name}" was created (id ${fid}), then: ${(err as Error).message}`, (err as DdbWriteError).status ?? 500, (err as DdbWriteError).detail ?? null);
  }
  return placed;
}

// --- read-back verification ---

const sortedJson = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
const same = (a: unknown[], b: unknown[]) => JSON.stringify(sortedJson(a)) === JSON.stringify(sortedJson(b));

const OPTION_EDIT_ACTION = /\/option\/\d+\/edit$/;

/** Ids of the options listed on a feature edit page. */
export function featureOptionIds(html: string): number[] {
  return [...html.matchAll(/class-feature\/\d+\/option\/(\d+)\/edit"/g)].map((m) => Number(m[1])).filter((v, i, a) => a.indexOf(v) === i);
}

/** Read back the actions / spell grants an owner page carries against what was added (counts, then each row's own edit page). */
async function verifyEntities(s: SiteSession, ownerHtml: string, p: { limitedUses: AddedActions; spells: AddedSpells }, who: string): Promise<string[]> {
  const out: string[] = [];
  const lu = listLimitedUses(ownerHtml), sp = listEntitySpells(ownerHtml);
  if (lu.length !== p.limitedUses.length) out.push(`${who}: lists ${lu.length} limited-use actions, added ${p.limitedUses.length}`);
  if (sp.length !== p.spells.length) out.push(`${who}: lists ${sp.length} spell grants, added ${p.spells.length}`);
  for (const a of p.limitedUses) { try { await verifyLimitedUse(s, a); } catch (err) { out.push(`${who}: ${(err as Error).message}`); } }
  for (const a of p.spells) { try { await verifyEntitySpell(s, a); } catch (err) { out.push(`${who}: ${(err as Error).message}`); } }
  return out;
}

async function verifyOption(s: SiteSession, slug: string, fid: number, o: PlacedOption, who: string): Promise<string[]> {
  let html: string;
  try { html = await getPage(s, `/classes/${slug}/class-feature/${fid}/option/${o.id}/edit`); }
  catch (err) { return [`${who}: edit page unreadable — ${(err as Error).message}`]; }
  const out = verifyEditForm(o.asked, parseForm(html, OPTION_EDIT_ACTION)).map((m) => `${who}: ${m}`);
  const kids = featureChildren(html);
  if (!same(kids.modifiers, o.modifiers)) out.push(`${who}: modifiers asked ${JSON.stringify(o.modifiers)}, DDB lists ${JSON.stringify(kids.modifiers)}`);
  out.push(...(await verifyEntities(s, html, o, who)));
  return out;
}

/** Mismatches between the features asked and the subclass page's table + each feature's own edit page. */
async function verifyFeatures(s: SiteSession, slug: string, rows: TableRow[], placed: Placed[]): Promise<string[]> {
  const out: string[] = [];
  const want = placed.map((p) => p.id).sort((a, b) => a - b);
  const have = rows.map((r) => r.id).sort((a, b) => a - b);
  if (JSON.stringify(want) !== JSON.stringify(have)) out.push(`feature table lists ids [${have.join(", ")}], expected [${want.join(", ")}]`);
  for (const p of placed) {
    const who = `feature "${p.spec.name}" (${p.id})`;
    const row = rows.find((r) => r.id === p.id);
    if (row) {
      if (row.name !== p.spec.name) out.push(`${who}: table name "${row.name}"`);
      if (row.level !== p.spec.level) out.push(`${who}: table level ${row.level}, asked ${p.spec.level}`);
      if (row.type !== p.spec.type) out.push(`${who}: table type "${row.type}", asked ${p.spec.type}`);
      if (p.spec.displayOrder !== undefined && row.order !== String(p.spec.displayOrder)) out.push(`${who}: table display order "${row.order}", asked ${p.spec.displayOrder}`);
    }
    let html: string;
    try { html = await getPage(s, `/classes/${slug}/class-feature/${p.id}/edit`); }
    catch (err) { out.push(`${who}: edit page unreadable — ${(err as Error).message}`); continue; }
    out.push(...verifyEditForm(p.asked, parseForm(html, FEATURE_EDIT_ACTION)).map((m) => `${who}: ${m}`));
    out.push(...(await verifyEntities(s, html, p, who)));
    for (const o of p.options) out.push(...(await verifyOption(s, slug, p.id, o, `${who} option "${o.spec.name}" (${o.id})`)));
    const optIds = featureOptionIds(html);
    if (optIds.length !== p.options.length) out.push(`${who}: lists ${optIds.length} options, asked ${p.options.length}`);
    const kids = featureChildren(html);
    if (!same(kids.modifiers, p.modifiers)) out.push(`${who}: modifiers asked ${JSON.stringify(p.modifiers)}, DDB lists ${JSON.stringify(kids.modifiers)}`);
    if (!same(kids.levelScales, p.levelScales)) out.push(`${who}: level scales asked ${JSON.stringify(p.levelScales)}, DDB lists ${JSON.stringify(kids.levelScales)}`);
  }
  return out;
}

async function verifyOrThrow(s: SiteSession, id: number, editPath: string, parentClassId: number, asked: Asked, placed: Placed[] | undefined): Promise<HomebrewSubclassResult> {
  const { value, mismatches } = await settle(async () => {
    const html = await getPage(s, editPath);
    const edit = parseForm(html, EDIT_ACTION);
    const rows = featureRows(html);
    const out = verifyEditForm(asked, edit);
    if (placed) out.push(...await verifyFeatures(s, subclassSlug(html), rows, placed));
    return { value: { name: controlById(edit, "field-name").values[0] ?? "", rows }, mismatches: out };
  }, settleDelays);
  if (mismatches.length) {
    throw new DdbWriteError(`ddb-homebrew-subclass: subclass ${id} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  }
  return {
    id, name: value.name, parentClassId, editUrl: siteUrl(editPath),
    features: value.rows.map((r) => ({ id: r.id, name: r.name, level: r.level, order: r.order, type: r.type })),
  };
}

// --- the primitives ---

/** POST the (already filled) subclass form once and return the 200 body, or throw with the builder's field errors. */
async function postSubclassForm(s: SiteSession, form: ParsedForm, what: string, mayHaveCreated: boolean): Promise<string> {
  const res = await s.fetch(form.action, { method: "POST", body: encodeForm(form) });
  const location = res.headers.get("location");
  if (res.status === 200) {
    const body = await res.text();
    const errors = formErrors(body);
    if (errors.length) throw new DdbWriteError(`ddb-homebrew-subclass ${what} POST ${form.action} → 200 with field errors: ${errors.map((e) => `${e.label || e.id}: ${e.message}`).join("; ")}`, 200, errors);
    return body;
  }
  throw new DdbWriteError(
    `ddb-homebrew-subclass ${what} POST ${form.action} → ${res.status}${location ? ` (→ ${location})` : ""}.` +
    (mayHaveCreated ? " A subclass MAY have been created anyway (the server answered unexpectedly) — check /my-creations before trying again; this call is never retried automatically." : ""),
    res.status, location);
}

export async function createHomebrewSubclass(f: HomebrewSubclassCreate): Promise<HomebrewSubclassResult> {
  const features = f.features ?? [];
  features.forEach(validateFeature);
  const s = rtSiteSession();

  // 1. The router: class-type label → the parent class's create URL. Creates nothing.
  const router = await loadForm(s, "/homebrew/creations/create-subclass", /create-subclass$/);
  setControl(router, "field-class-type", optionValue(f.className));
  const routed = await submit(s, router, "route subclass to its class");
  const parent = routed.match(/\/classes\/((\d+)-[^/?#]+)\/subclass\/create/);
  if (!parent) throw new DdbWriteError(`ddb-homebrew-subclass: class router answered an unexpected redirect ${routed}`, 302, routed);

  // 2. The create form (fresh CSRF tokens), filled and POSTed exactly once.
  const form = await loadForm(s, `/classes/${parent[1]}/subclass/create`, /subclass\/create$/);
  const asked = fillSubclassForm(form, f);
  const body = await postSubclassForm(s, form, "create", true);

  // 3. 200 + the new page: the id is in its links. No id → we cannot tell whether it saved, and must not retry.
  const m = body.match(/href="\/classes\/(\d+)-[^"/]+\/class-feature\/create"/);
  if (!m) {
    throw new DdbWriteError(
      `ddb-homebrew-subclass create: DDB answered 200 without errors, but the page carries no new subclass id — a subclass named "${f.name}" MAY have been created. ` +
      `Check https://www.dndbeyond.com/my-creations (or ddb_update_homebrew_subclass / ddb_delete_homebrew_subclass by id) before trying again; this call is never retried automatically.`, 200, null);
  }
  const id = Number(m[1]);
  const editPath = `/classes/${parent[1]}/subclass/${id}/edit`;
  // The subclass exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    const placed: Placed[] = [];
    const created: CreatedOptions = new Map();
    for (const feat of features) placed.push(await createFeature(s, subclassSlug(body), feat, created));
    return await verifyOrThrow(s, id, editPath, Number(parent[2]), asked, f.features === undefined ? undefined : placed);
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew-subclass: subclass ${id} was created (${editPath}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

export async function updateHomebrewSubclass(id: number, f: HomebrewSubclassFields): Promise<HomebrewSubclassResult> {
  const features = f.features;
  features?.forEach(validateFeature);
  const s = rtSiteSession();
  const { editPath, parentClassId } = await editPathFor(s, id);
  const before = await getPage(s, editPath);

  // Base fields. Skipped when only features were given (nothing to POST).
  const base: HomebrewSubclassFields = { ...f, features: undefined };
  let asked: Asked = new Map();
  let slug = subclassSlug(before);
  if (Object.values(base).some((v) => v !== undefined)) {
    const form = parseForm(before, EDIT_ACTION);
    asked = fillSubclassForm(form, base);
    slug = subclassSlug(await postSubclassForm(s, form, `update subclass ${id}`, false)); // a rename changes the slug
  }

  let placed: Placed[] | undefined;
  if (features) {
    // Create the new set first, then drop the old: a failure part-way leaves extra features, never fewer.
    const old = featureRows(before);
    placed = [];
    const created: CreatedOptions = new Map();
    try {
      for (const feat of features) placed.push(await createFeature(s, slug, feat, created));
      for (const row of old) await ajaxPost(s, `/classes/${slug}/class-feature/${row.id}/delete`, `remove feature ${row.id} from subclass ${id}`);
    } catch (err) {
      const e = err instanceof DdbWriteError ? err : null;
      throw new DdbWriteError(
        `ddb-homebrew-subclass: subclass ${id} update stopped part-way (new features created so far: [${placed.map((p) => p.id).join(", ")}]; old features: [${old.map((r) => r.id).join(", ")}]), then: ${(err as Error).message}`,
        e?.status ?? 500, e?.detail ?? null);
    }
  }
  return verifyOrThrow(s, id, editPath, parentClassId, asked, placed);
}

/** Delete a homebrew subclass; its features cascade. Confirmed by a repeat delete answering 404 (see deleteCreation). */
export async function deleteHomebrewSubclass(id: number): Promise<{ id: number; deleted: true }> {
  const s = rtSiteSession();
  const { editPath } = await editPathFor(s, id);
  return deleteCreation(s, SUBCLASS_ENTITY_TYPE_ID, id, editPath);
}
