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

export type { HomebrewModifier } from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const SUBCLASS_ENTITY_TYPE_ID = 789467139;          // same id as classes
export const CLASS_FEATURE_ENTITY_TYPE_ID = 12168134;

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
  set("field-has-options", f.hasOptions);
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

interface Placed {
  id: number;
  spec: HomebrewSubclassFeature;
  asked: Asked;
  modifiers: string[];      // the labels the modifier table must list, e.g. "Resistance - Fire"
  levelScales: string[][];  // [level, dice, fixed, description] rows the level-scale table must list
}

const levelScaleRow = (l: HomebrewLevelScale) => [String(l.level), l.dice ? `${l.dice.count}d${l.dice.die}` : "", l.fixedValue === undefined ? "" : String(l.fixedValue), l.description ?? ""];

/** Create one feature with its modifiers and level scales. Each POST is made once; nothing here retries. */
async function createFeature(s: SiteSession, slug: string, f: HomebrewSubclassFeature): Promise<Placed> {
  const form = await loadForm(s, `/classes/${slug}/class-feature/create`, /class-feature\/create$/);
  const asked = fillFeatureForm(form, f);
  const location = await submit(s, form, `create feature "${f.name}"`);
  const id = location.match(/\/class-feature\/(\d+)\/edit/)?.[1];
  if (!id) throw new DdbWriteError(`ddb-homebrew-subclass: create feature "${f.name}": unexpected redirect ${location}`, 302, location);
  const fid = Number(id);
  const placed: Placed = { id: fid, spec: f, asked, modifiers: [], levelScales: [] };
  try {
    for (const m of f.modifiers ?? []) {
      const path = `/modifier/create/${fid}-${CLASS_FEATURE_ENTITY_TYPE_ID}/0`;
      const html = await getPage(s, path);
      const mform = parseForm(html, /modifier\/create/);
      const { typeId, subTypeId } = fillModifierForm(mform, html, m);
      const typeLabel = controlById(mform, "field-spell-modifier-type").options.find((o) => o.value === String(typeId))?.label ?? "";
      const subName = embeddedSubTypes(html).find((x) => x.id === subTypeId)?.name ?? "";
      await submit(s, mform, `add modifier to feature ${fid}`);
      placed.modifiers.push(`${typeLabel} - ${subName}`);
    }
    for (const l of f.levelScales ?? []) {
      const lform = await loadForm(s, `/entity/levelscale/create/${fid}-${CLASS_FEATURE_ENTITY_TYPE_ID}`, /levelscale\/create/);
      setControl(lform, "field-level", String(l.level));
      if (l.dice) { setControl(lform, "field-dice-count", l.dice.count); setControl(lform, "field-dice-value", `d${l.dice.die}`); }
      if (l.fixedValue !== undefined) setControl(lform, "field-fixed-value", l.fixedValue);
      if (l.description !== undefined) setControl(lform, "field-description", l.description);
      await submit(s, lform, `add level scale to feature ${fid}`);
      placed.levelScales.push(levelScaleRow(l));
    }
  } catch (err) {
    throw new DdbWriteError(`ddb-homebrew-subclass: feature "${f.name}" was created (id ${fid}), then: ${(err as Error).message}`, (err as DdbWriteError).status ?? 500, (err as DdbWriteError).detail ?? null);
  }
  return placed;
}

// --- read-back verification ---

const sortedJson = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
const same = (a: unknown[], b: unknown[]) => JSON.stringify(sortedJson(a)) === JSON.stringify(sortedJson(b));

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
    for (const feat of features) placed.push(await createFeature(s, subclassSlug(body), feat));
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
    try {
      for (const feat of features) placed.push(await createFeature(s, slug, feat));
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
