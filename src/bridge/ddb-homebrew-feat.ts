// D&D Beyond homebrew FEAT creation — create, update, delete — without the site's builder UX.
//
// Same approach as ddb-homebrew.ts (monsters): drive the site's server-rendered builder over plain
// HTTP, address controls by their stable element ids, and read every write back. Routes verified
// live on 2026-10-12 (docs/ddb-homebrew-types.md, "feat"):
//   create    GET+POST /homebrew/creations/create-feat/create               urlencoded → 302 …/create-feat/{id}-{slug}/edit
//   update    GET+POST /homebrew/creations/create-feat/{id}-{slug}/edit     urlencoded → 302 (slug follows renames)
//   prereq    GET+POST /entity/prerequisite/create/{id}-1088085227          urlencoded → 303 /entity/prerequisite/{pid}/edit
//   mapping   GET+POST /entity/prerequisite-mapping/create/{pid}            urlencoded → 303 (the form is on the prereq edit page)
//   modifier  GET+POST /modifier/create/{id}-1088085227/0                   the generic modifier editor
//   sub-del   POST /entity/prerequisite/{pid}/delete, /modifier/{mid}/delete    (ajax-post, hrefs taken verbatim from the edit page)
//   delete    POST /homebrew/creations/delete?entityTypeId=1088085227&id={id}  (ajax-post; re-delete 404 is the oracle)
//
//   option    GET+POST /feats/{id}-{slug}/feat-option/create                 urlencoded → 302 …/feat-option/{oid}/edit
//             (name, description trio, snippet; delete = GET modal → `ajax-post` /feats/{id}-{slug}/feat-option/{oid}/delete)
//   actions / spells: the shared sub-forms in ddb-homebrew-entity.ts (feat owner type 1088085227). A
//             feat OPTION is itself an owner (entity type 400581042, live-verified): its own "Add Action".
// Out of scope (exist on the edit page, not wrapped): creature rules.
//
// Verification uses three oracles, none of which covers everything:
//   - the re-rendered EDIT FORM: version and tags (and the other form controls);
//   - character-service game-data/feats (bearer; cookie-only omits homebrew): name, description,
//     snippet and prerequisites with their mappings;
//   - the EDIT PAGE's listings: modifier rows ("Bonus - Strength Score") and counts, since
//     modifiers are in neither of the above.
// All three lag writes, so the check runs through settle().

import { parse } from "node-html-parser";
import { rtSiteSession, rtRawFetch, type SiteSession } from "./ddb-rt.js";
import { parseForm, setControl, controlById, type ParsedForm } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  addLimitedUse, verifyLimitedUse, validateLimitedUse, validateEntitySpell, addEntitySpell, verifyEntitySpell,
  entityDeleteLinks, listLimitedUses, listEntitySpells,
  type HomebrewLimitedUse, type HomebrewEntitySpell,
} from "./ddb-homebrew-entity.js";
import {
  getPage, loadForm, submit, ajaxPost, verifyEditForm, deleteCreation, settle, SETTLE_DELAYS_MS,
  embeddedSubTypes, resolveSubType, fillModifierForm, resolveEditPath, type Asked, type HomebrewModifier,
} from "./ddb-homebrew-core.js";

export type { HomebrewModifier } from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const FEAT_ENTITY_TYPE_ID = 1088085227;
/** Owner entity type of a feat option (live-verified: its edit page links /entity/limited-use/create/{oid}-400581042). */
export const FEAT_OPTION_ENTITY_TYPE_ID = 400581042;
const FEATS_JSON = "https://character-service.dndbeyond.com/character/v5/game-data/feats";

// --- caller-facing field model (labels, not DDB ids) ---

export interface HomebrewFeatRequirement {
  type: string;                    // prerequisite type label: "Ability Score", "Class", "Level", "Species", …
  subType: string | number;        // name within the type ("Strength"), or the catalogue id when ambiguous
  value?: number;                  // e.g. 13 for "Strength 13 or higher"
  exclude?: boolean;               // "must NOT have" (create-should-exclude)
}
export interface HomebrewFeatPrerequisite { description: string; requirements?: HomebrewFeatRequirement[] }

/** A choice offered by the feat ("Choose one: Steady Aim, Quick Shot, ..."). */
export interface HomebrewFeatOption {
  name: string;
  description?: string;            // HTML
  snippet?: string;
  actions?: HomebrewLimitedUse[];  // the option's own "Add Action" (e.g. a use-limited benefit)
}

export type { HomebrewLimitedUse, HomebrewEntitySpell } from "./ddb-homebrew-entity.js";

export interface HomebrewFeatFields {
  name?: string;
  version?: string;
  description?: string;            // HTML
  snippet?: string;
  tags?: string[];                 // feat tag labels
  // Sub-entries. On update, a provided list REPLACES that kind wholesale; omitted = untouched.
  prerequisites?: HomebrewFeatPrerequisite[];
  modifiers?: HomebrewModifier[];
  options?: HomebrewFeatOption[];
  actions?: HomebrewLimitedUse[];  // limited-use actions of the feat itself
  spells?: HomebrewEntitySpell[];  // spell grants (the feat form has no always-prepared / level controls)
}

/** Fill the main builder form. Pure (no I/O). Returns the controls it set whose values a re-read of the form must show. */
export function fillFeatForm(form: ParsedForm, f: HomebrewFeatFields): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: string | string[] | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-name", f.name);
  set("field-version", f.version);
  set("field-snippet", f.snippet);
  set("field-feat-tags-public", f.tags);
  if (f.description !== undefined) {
    // A (hidden type, wysiwyg, markup) trio; the server reads the wysiwyg copy. Not in `asked`:
    // the server may normalize the HTML, so the description is compared via game-data instead.
    setControl(form, "field-item-description-type", "1");
    setControl(form, "field-item-description-wysiwyg", f.description);
    setControl(form, "field-item-description", f.description);
  }
  return asked;
}

/** Structural checks that need no network, so a bad request fails before anything is created. */
export function validateFeatFields(f: HomebrewFeatFields): void {
  const bad = (m: string) => { throw new DdbWriteError(`ddb-homebrew feat: ${m}`, 400, null); };
  for (const [i, o] of (f.options ?? []).entries()) {
    if (!o.name.trim()) bad(`options[${i}] needs a name`);
    for (const a of o.actions ?? []) validateLimitedUse(a);
  }
  for (const a of f.actions ?? []) validateLimitedUse(a);
  for (const sp of f.spells ?? []) validateEntitySpell(sp);
  for (const [i, p] of (f.prerequisites ?? []).entries()) {
    if (!p.description.trim()) bad(`prerequisites[${i}] needs a description`);
    for (const [j, r] of (p.requirements ?? []).entries()) {
      // DDB answers a mapping POST with no subtype with a silent 303 and creates nothing.
      if (typeof r.subType === "string" ? !r.subType.trim() : !Number.isInteger(r.subType)) bad(`prerequisites[${i}].requirements[${j}] needs a subType (a blank mapping is silently ignored by DDB)`);
      if (!r.type.trim()) bad(`prerequisites[${i}].requirements[${j}] needs a type`);
      if (r.value !== undefined && !Number.isFinite(r.value)) bad(`prerequisites[${i}].requirements[${j}].value must be a number`);
    }
  }
}

// --- edit-page structure ---

const EDIT_LOCATION = /\/homebrew\/creations\/create-feat\/((\d+)-[^/?#]+)\/edit/;
const EDIT_FORM = /\/create-feat\/[^/]+\/edit$/;

/** Delete links of one sub-entry kind on a feat's edit page, verbatim (the hrefs are the contract). */
export function deleteLinks(editHtml: string, kind: "prerequisites" | "modifiers"): string[] {
  const re = kind === "prerequisites" ? /href="(\/entity\/prerequisite\/\d+\/delete)"/g : /href="(\/modifier\/\d+\/delete)"/g;
  return [...new Set([...editHtml.matchAll(re)].map((m) => m[1]))];
}

/** Options listed on a feat's edit page: ids and verbatim delete hrefs (the listing shows only descriptions). */
export function optionLinks(editHtml: string): Array<{ id: number; deleteHref: string }> {
  const re = /href="(\/feats\/[^"/]+\/feat-option\/(\d+)\/delete)"/g;
  const seen = new Map<number, string>();
  for (const m of editHtml.matchAll(re)) seen.set(Number(m[2]), m[1]);
  return [...seen].map(([id, deleteHref]) => ({ id, deleteHref }));
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** First-column text of each row of a listing table on the edit page (empty when the table is absent). */
function listingRows(editHtml: string, tableClass: string): string[][] {
  const root = parse(editHtml, { blockTextElements: { script: false, style: false, textarea: true } });
  return root.querySelectorAll(`table.${tableClass} tbody tr`).map((tr) => tr.querySelectorAll("td").map((td) => clean(td.text)));
}

// --- adding sub-entries ---

interface ExpectedPrereq { description: string; mappings: Array<{ type: string; subType: string; value?: number; exclude: boolean }> }

const optionLabelOf = (form: ParsedForm, id: string): string => {
  const c = controlById(form, id);
  return c.options.find((o) => o.value === c.values[0])?.label ?? "";
};

async function addPrerequisite(s: SiteSession, featId: number, p: HomebrewFeatPrerequisite): Promise<ExpectedPrereq> {
  const form = await loadForm(s, `/entity/prerequisite/create/${featId}-${FEAT_ENTITY_TYPE_ID}`, /prerequisite\/create\//);
  setControl(form, "field-description", p.description);
  const location = await submit(s, form, `add prerequisite to feat ${featId}`);
  const pagePath = location.match(/\/entity\/prerequisite\/(\d+)\/edit/)?.[0];
  if (!pagePath) throw new DdbWriteError(`ddb-homebrew add prerequisite to feat ${featId}: unexpected redirect ${location}`, 303, location);
  const expected: ExpectedPrereq = { description: p.description, mappings: [] };
  for (const r of p.requirements ?? []) {
    // The mapping form lives on the prerequisite's edit page, which also carries the subtype
    // catalogue (the same `var subTypes = [[{id,name,type}]]` literal, `type` = prereq-type id).
    const html = await getPage(s, pagePath);
    const mf = parseForm(html, /prerequisite-mapping\/create\//);
    setControl(mf, "field-prereq-type", r.type);
    const typeId = Number(controlById(mf, "field-prereq-type").values[0]);
    const catalogue = embeddedSubTypes(html);
    const subTypeId = resolveSubType(catalogue, typeId, r.subType);
    controlById(mf, "field-prereq-sub-type").values = [String(subTypeId)]; // JS-filtered select
    if (r.value !== undefined) setControl(mf, "field-value", r.value);
    setControl(mf, "field-create-should-exclude", r.exclude ?? false);
    await submit(s, mf, `add requirement to prerequisite of feat ${featId}`);
    expected.mappings.push({
      type: optionLabelOf(mf, "field-prereq-type"),
      subType: catalogue.find((c) => c.id === subTypeId && c.type === typeId)!.name,
      value: r.value, exclude: r.exclude ?? false,
    });
  }
  return expected;
}

/** Add one modifier; returns the listing label the edit page must show ("Bonus - Strength Score"). */
async function addModifier(s: SiteSession, featId: number, m: HomebrewModifier): Promise<string> {
  const html = await getPage(s, `/modifier/create/${featId}-${FEAT_ENTITY_TYPE_ID}/0`);
  const form = parseForm(html, /\/modifier\/create\//);
  const { typeId, subTypeId } = fillModifierForm(form, html, m);
  const sub = embeddedSubTypes(html).find((c) => c.id === subTypeId && c.type === typeId)!.name;
  await submit(s, form, `add modifier to feat ${featId}`);
  return `${optionLabelOf(form, "field-spell-modifier-type")} - ${sub}`;
}

// --- read-back verification ---

async function readFeatJson(featId: number): Promise<any | undefined> {
  const res = await rtRawFetch(FEATS_JSON);
  if (res.status !== 200) throw new DdbWriteError(`ddb-homebrew feat ${featId}: game-data/feats → ${res.status}`, res.status, null);
  const body = await res.json() as { data?: Array<{ id: number }> };
  return (body.data ?? []).find((x) => x.id === featId);
}

interface Expectation {
  asked: Asked;
  json: { name?: string; description?: string; snippet?: string };
  prerequisites?: ExpectedPrereq[];
  modifiers?: string[];
  /** Counts the feat's edit page must list (options, actions, spell grants). */
  counts?: { options?: number; actions?: number; spells?: number };
}

const norm = (s: unknown) => clean(String(s ?? "")).toLowerCase();
const sorted = (xs: string[]) => [...xs].sort();

/** Mismatches between what was asked and what the three oracles show. Pure; exported for tests. */
export function featMismatches(want: Expectation, edit: ParsedForm, editHtml: string, feat: any | undefined): string[] {
  const out = verifyEditForm(want.asked, edit);
  if (!feat) {
    out.push("not (yet) listed in game-data/feats");
  } else {
    for (const k of ["name", "description", "snippet"] as const) {
      const w = want.json[k];
      if (w !== undefined && clean(w) !== clean(String(feat[k] ?? ""))) out.push(`${k}: asked ${JSON.stringify(w)}, game-data has ${JSON.stringify(feat[k] ?? null)}`);
    }
    if (want.prerequisites) {
      const got = (feat.prerequisites ?? []).map((p: any) => ({
        description: clean(p.description ?? ""),
        mappings: sorted((p.prerequisiteMappings ?? []).map((m: any) => JSON.stringify([norm(m.friendlyTypeName), norm(m.friendlySubTypeName), m.value ?? null, Boolean(m.shouldExclude)]))),
      }));
      const wantP = want.prerequisites.map((p) => ({
        description: clean(p.description),
        mappings: sorted(p.mappings.map((m) => JSON.stringify([norm(m.type), norm(m.subType), m.value ?? null, m.exclude]))),
      }));
      // Mapping values are only compared when asked: a requirement without a value reads back null.
      const key = (p: { description: string; mappings: string[] }) => JSON.stringify(p);
      if (JSON.stringify(wantP.map(key).sort()) !== JSON.stringify(got.map(key).sort())) {
        out.push(`prerequisites: asked ${wantP.map(key).sort().join(" ") || "none"}, game-data has ${got.map(key).sort().join(" ") || "none"}`);
      }
    }
  }
  if (want.prerequisites) {
    const rows = listingRows(editHtml, "listing-rpgentity-prerequisite").map((r) => r[0] ?? "");
    if (JSON.stringify(sorted(rows.map(clean))) !== JSON.stringify(sorted(want.prerequisites.map((p) => clean(p.description))))) {
      out.push(`edit page prerequisites: asked ${JSON.stringify(want.prerequisites.map((p) => p.description))}, page lists ${JSON.stringify(rows)}`);
    }
  }
  if (want.modifiers) {
    const rows = listingRows(editHtml, "listing-rpgentity-modifier").map((r) => r[0] ?? "");
    if (JSON.stringify(sorted(rows.map(norm))) !== JSON.stringify(sorted(want.modifiers.map(norm)))) {
      out.push(`edit page modifiers: asked ${JSON.stringify(want.modifiers)}, page lists ${JSON.stringify(rows)}`);
    }
  }
  if (want.counts) {
    const got = { options: optionLinks(editHtml).length, actions: listLimitedUses(editHtml).length, spells: listEntitySpells(editHtml).length };
    for (const k of ["options", "actions", "spells"] as const) {
      if (want.counts[k] !== undefined && want.counts[k] !== got[k]) out.push(`edit page ${k}: asked ${want.counts[k]}, page lists ${got[k]}`);
    }
  }
  return out;
}

async function verifyOrThrow(s: SiteSession, featId: number, editPath: string, want: Expectation): Promise<any> {
  const { value: feat, mismatches } = await settle(async () => {
    const html = await getPage(s, editPath);
    const edit = parseForm(html, EDIT_FORM);
    const feat = await readFeatJson(featId);
    return { value: feat, mismatches: featMismatches(want, edit, html, feat) };
  }, settleDelays);
  if (mismatches.length) {
    throw new DdbWriteError(`ddb-homebrew: feat ${featId} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  }
  return feat;
}

/** Add one option (and its own actions); verifies the option's edit form. */
async function addOption(s: SiteSession, featId: number, slug: string, o: HomebrewFeatOption): Promise<void> {
  const form = await loadForm(s, `/feats/${slug}/feat-option/create`, /feat-option\/create$/);
  const asked: Asked = new Map();
  const set = (id: string, v: string | undefined) => { if (v === undefined) return; setControl(form, id, v); asked.set(id, [...controlById(form, id).values]); };
  set("field-name", o.name);
  set("field-snippet", o.snippet);
  if (o.description !== undefined) {
    setControl(form, "field-description-type", "1");
    setControl(form, "field-description-wysiwyg", o.description);
    setControl(form, "field-description", o.description);
  }
  const location = await submit(s, form, `add option "${o.name}" to feat ${featId}`);
  const m = location.match(/\/feat-option\/(\d+)\/edit/);
  if (!m) throw new DdbWriteError(`ddb-homebrew add option "${o.name}" to feat ${featId}: unexpected redirect ${location}`, 303, location);
  const optionId = Number(m[1]);
  const optionPath = `/feats/${slug}/feat-option/${optionId}/edit`;
  try {
    for (const a of o.actions ?? []) await verifyLimitedUse(s, await addLimitedUse(s, optionId, FEAT_OPTION_ENTITY_TYPE_ID, a));
    const { mismatches } = await settle(async () => {
      const edit = parseForm(await getPage(s, optionPath), /feat-option\/\d+\/edit$/);
      const out = verifyEditForm(asked, edit);
      const gotDesc = controlById(edit, "field-description-wysiwyg").values[0] ?? "";
      if (o.description !== undefined && clean(gotDesc) !== clean(o.description)) out.push(`description: asked ${JSON.stringify(o.description)}, DDB has ${JSON.stringify(gotDesc)}`);
      return { value: null, mismatches: out };
    }, settleDelays);
    if (mismatches.length) throw new DdbWriteError(`ddb-homebrew: feat option ${optionId} was written but the read-back differs - ${mismatches.join("; ")}`, 200, mismatches);
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: option "${o.name}" (${optionId}) of feat ${featId} was created, then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

type Added = Pick<Expectation, "prerequisites" | "modifiers" | "counts">;

/** Add the provided sub-entry kinds; returns what the verification must find. */
async function addSubEntries(s: SiteSession, featId: number, slug: string, f: HomebrewFeatFields): Promise<Added> {
  const out: Added = {};
  if (f.prerequisites !== undefined) {
    out.prerequisites = [];
    for (const p of f.prerequisites) out.prerequisites.push(await addPrerequisite(s, featId, p));
  }
  if (f.modifiers !== undefined) {
    out.modifiers = [];
    for (const m of f.modifiers) out.modifiers.push(await addModifier(s, featId, m));
  }
  if (f.options !== undefined) {
    for (const o of f.options) await addOption(s, featId, slug, o);
    out.counts = { ...out.counts, options: f.options.length };
  }
  if (f.actions !== undefined) {
    for (const a of f.actions) await verifyLimitedUse(s, await addLimitedUse(s, featId, FEAT_ENTITY_TYPE_ID, a));
    out.counts = { ...out.counts, actions: f.actions.length };
  }
  if (f.spells !== undefined) {
    for (const sp of f.spells) await verifyEntitySpell(s, await addEntitySpell(s, featId, FEAT_ENTITY_TYPE_ID, sp));
    out.counts = { ...out.counts, spells: f.spells.length };
  }
  return out;
}

function jsonExpectation(f: HomebrewFeatFields): Expectation["json"] {
  return { name: f.name, description: f.description, snippet: f.snippet };
}

// --- the primitives ---

export interface HomebrewFeatResult { id: number; editUrl: string; raw: any }

export async function createHomebrewFeat(f: HomebrewFeatFields): Promise<HomebrewFeatResult> {
  validateFeatFields(f);
  const s = rtSiteSession();
  const form = await loadForm(s, "/homebrew/creations/create-feat/create", /\/create-feat\/create$/);
  const asked = fillFeatForm(form, f);
  const location = await submit(s, form, "create feat");
  const m = location.match(EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew create feat: unexpected redirect ${location}`, 303, location);
  const id = Number(m[2]);
  const editPath = `/homebrew/creations/create-feat/${m[1]}/edit`;
  // The feat exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    const subs = await addSubEntries(s, id, m[1], f);
    const raw = await verifyOrThrow(s, id, editPath, { asked, json: jsonExpectation(f), ...subs });
    return { id, editUrl: `https://www.dndbeyond.com${editPath}`, raw };
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: feat ${id} was created (${m[1]}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

export async function updateHomebrewFeat(featId: number, f: HomebrewFeatFields): Promise<HomebrewFeatResult> {
  validateFeatFields(f);
  const s = rtSiteSession();
  // The generic edit redirect, not game-data: the feat list lags writes (a just-created feat can be missing).
  let editPath = await resolveEditPath(s, FEAT_ENTITY_TYPE_ID, featId);
  try {
    const editHtml = await getPage(s, editPath);
    let asked: Asked = new Map();
    if (f.name !== undefined || f.version !== undefined || f.description !== undefined || f.snippet !== undefined || f.tags !== undefined) {
      const form = parseForm(editHtml, EDIT_FORM);
      asked = fillFeatForm(form, f);
      const location = await submit(s, form, `update feat ${featId}`);
      const slug = location.match(EDIT_LOCATION)?.[1];
      if (!slug) throw new DdbWriteError(`ddb-homebrew update feat ${featId}: unexpected redirect ${location}`, 303, location);
      editPath = `/homebrew/creations/create-feat/${slug}/edit`;
    }
    // Replace each provided kind: drop what the edit page listed (hrefs verbatim), then add the new set.
    for (const kind of ["prerequisites", "modifiers"] as const) {
      if (f[kind] === undefined) continue;
      for (const href of deleteLinks(editHtml, kind)) await ajaxPost(s, href, `remove ${kind.replace(/s$/, "")} from feat ${featId} (${href})`);
    }
    const hrefs: Array<[string, string[]]> = [];
    if (f.options !== undefined) hrefs.push(["option", optionLinks(editHtml).map((o) => o.deleteHref)]);
    if (f.actions !== undefined) hrefs.push(["action", entityDeleteLinks(editHtml, "limitedUse")]);
    if (f.spells !== undefined) hrefs.push(["spell grant", entityDeleteLinks(editHtml, "spell")]);
    for (const [what, list] of hrefs) for (const href of list) await ajaxPost(s, href, `remove ${what} from feat ${featId} (${href})`);
    const slugNow = editPath.match(/create-feat\/([^/]+)\/edit/)![1];
    const subs = await addSubEntries(s, featId, slugNow, f);
    const raw = await verifyOrThrow(s, featId, editPath, { asked, json: jsonExpectation(f), ...subs });
    return { id: featId, editUrl: `https://www.dndbeyond.com${editPath}`, raw };
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    // Verification failures already say the feat was written; anything else happened part-way through.
    const msg = (err as Error).message;
    throw new DdbWriteError(msg.includes(`feat ${featId} was written`) ? msg : `ddb-homebrew: update of feat ${featId} failed part-way: ${msg}`, e?.status ?? 500, e?.detail ?? null);
  }
}

/** Delete a homebrew feat (cascades to its sub-entries). Confirmed by a repeat delete answering 404. */
export async function deleteHomebrewFeat(featId: number): Promise<{ id: number; deleted: true }> {
  const s = rtSiteSession();
  return deleteCreation(s, FEAT_ENTITY_TYPE_ID, featId, await resolveEditPath(s, FEAT_ENTITY_TYPE_ID, featId));
}
