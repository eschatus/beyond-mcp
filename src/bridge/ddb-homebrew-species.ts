// D&D Beyond homebrew SPECIES creation — create, update, delete — without the site's builder UX.
//
// Same approach as ddb-homebrew.ts (monsters): drive the site's own server-rendered builders over
// plain HTTP, addressing controls by their stable element ids. A species is a small tree:
//
//   species ─┬─ traits ─── modifiers      (a trait's mechanical effects: senses, resistances, …)
//            └─ options                   (sub-species / variants; their own creations)
//
// Routes (verified live 2026-10-12, see docs/ddb-homebrew-types.md "species"):
//   create   GET+POST /homebrew/creations/create-species/create                multipart → 302 …/species/{id}-{slug}/edit
//   update   GET+POST /homebrew/creations/species/{id}-{slug}/edit              multipart → 302 (slug follows renames)
//   trait    GET+POST /entity/species-trait/create/{id}-1743923279              urlencoded → 302 /entity/species-trait/{tid}/edit
//   trait-modifier  GET+POST /modifier/create/{tid}-1960452172/0                the generic modifier editor
//   option   GET+POST /homebrew/creations/species/{id}-{slug}/create-species-options/create
//                                                                               multipart → 302 …/species-options/{oid}-{slug}/edit
//   delete   POST /entity/species-trait/{tid}/delete                            (ajax-post)
//            POST /homebrew/creations/delete?entityTypeId={1743923279|1228963568}&id=   (ajax-post)
//
// Three things make species the fiddliest builder:
//   1. A trait POST missing a required field answers 200 with NO field errors and creates nothing,
//      so traits are validated up front and only a redirect counts as success.
//   2. Reads lag writes the most here (edit pages flapped old/new for minutes), so every check runs
//      through settle().
//   3. Species options do NOT cascade on species delete; they are deleted first, separately.
// Like the other homebrew modules this is a primitive surface: no policy, the caller owns intent.

import { parse } from "node-html-parser";
import { rtSiteSession, rtRawFetch, type SiteSession } from "./ddb-rt.js";
import { parseForm, setControl, controlById, type ParsedForm, type OptionValue } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  getPage, loadForm, resolveEditPath, submit, ajaxPost, verifyEditForm, deleteCreation, settle, SETTLE_DELAYS_MS,
  embeddedSubTypes, fillModifierForm, type Asked, type HomebrewModifier,
} from "./ddb-homebrew-core.js";

export type { HomebrewModifier } from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const SPECIES_ENTITY_TYPE_ID = 1743923279;
export const SPECIES_OPTION_ENTITY_TYPE_ID = 1228963568;
export const RACIAL_TRAIT_ENTITY_TYPE_ID = 1960452172;

const RACES_URL = "https://character-service.dndbeyond.com/character/v5/game-data/races?sharingSetting=2";

// --- caller-facing field model (labels, not DDB ids) ---

export type SpeciesFeatureType = "Granted" | "Additional" | "Replacement";
export type SpeedKey = "walk" | "burrow" | "climb" | "fly" | "swim";

export interface HomebrewSpeciesTrait {
  name: string;
  snippet: string;
  description: string;                 // HTML
  featureType: SpeciesFeatureType;     // CREATE-ONLY: DDB silently ignores it on an edit
  displayOrder?: number;
  requiredLevel?: number;              // character level at which the trait is gained
  hideInBuilder?: boolean;
  hideInSheet?: boolean;
  hideOnDetailsPage?: boolean;
  isCalledOut?: boolean;
  modifiers?: HomebrewModifier[];
}

export interface HomebrewSpeciesOption {
  name: string;
  version?: string;
  description: string;                 // HTML
  speciesGroup?: string | OptionValue;
  isVariant?: boolean;
}

export interface HomebrewSpeciesFields {
  name?: string;
  version?: string;
  size?: string;                       // "Tiny" … "Gargantuan", "Medium or Small"
  /** Feet; null clears that speed. Omitted keys are untouched. */
  speeds?: Partial<Record<SpeedKey, number | null>>;
  shortDescription?: string;           // HTML
  description?: string;                // HTML
  /** The race-group label ("Aarakocra"), or { value } where labels repeat ("-"). */
  speciesGroup?: string | OptionValue;
  traitIntroduction?: string;
  hideTraitsHeading?: boolean;
  supportsOptions?: boolean;
  // Sub-entries. On update, a provided list REPLACES that kind wholesale; omitted = untouched.
  traits?: HomebrewSpeciesTrait[];
  options?: HomebrewSpeciesOption[];
}

const SPEED_IDS: Record<SpeedKey, string> = {
  walk: "field-speed-walking", burrow: "field-speed-burrowing", climb: "field-speed-climbing",
  fly: "field-speed-flying", swim: "field-speed-swimming",
};

// Size labels → sizeId in game-data/races. Independent of the form's own option values, so a label
// resolved to the wrong option shows up as a mismatch against the JSON.
export const SPECIES_SIZE_IDS: Record<string, number> = {
  tiny: 2, small: 3, medium: 4, large: 5, huge: 6, gargantuan: 7, "medium or small": 10,
};

function setDescription(form: ParsedForm, key: string, html: string): void {
  setControl(form, `field-${key}-type`, "1");
  setControl(form, `field-${key}-wysiwyg`, html);
  setControl(form, `field-${key}`, html);
}

function setGroup(form: ParsedForm, label: string | OptionValue): void {
  setControl(form, "field-race-group", label);
}

/**
 * Fill the species builder form. Pure (no I/O). Returns the non-description controls it set;
 * descriptions are excluded because the server may normalize their HTML.
 */
export function fillSpeciesForm(form: ParsedForm, f: HomebrewSpeciesFields): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: string | number | boolean | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-name", f.name);
  set("field-version", f.version);
  set("field-size", f.size);
  for (const [k, v] of Object.entries(f.speeds ?? {}) as Array<[SpeedKey, number | null | undefined]>) {
    if (v === undefined) continue;
    set(SPEED_IDS[k], v === null ? "" : v);
  }
  if (f.shortDescription !== undefined) setDescription(form, "short-description", f.shortDescription);
  if (f.description !== undefined) setDescription(form, "description", f.description);
  if (f.speciesGroup !== undefined) { setGroup(form, f.speciesGroup); asked.set("field-race-group", [...controlById(form, "field-race-group").values]); }
  set("field-racial-trait-introduction", f.traitIntroduction);
  set("field-hide-traits-heading", f.hideTraitsHeading);
  set("field-supports-subrace", f.supportsOptions);
  return asked;
}

/** The species form fields (everything but the trait/option lists) the caller gave. */
function hasFormFields(f: HomebrewSpeciesFields): boolean {
  return Object.entries(f).some(([k, v]) => k !== "traits" && k !== "options" && v !== undefined);
}

// --- traits ---

/**
 * A trait POST with a required field missing answers 200 with no field errors and creates nothing
 * (live), so the requireds are checked here instead of discovered as a silent no-op.
 */
export function validateTrait(t: HomebrewSpeciesTrait, i: number): void {
  const bad = (m: string) => { throw new DdbWriteError(`ddb-homebrew species trait #${i + 1} ("${t.name}"): ${m} — DDB would silently ignore the trait`, 400, null); };
  if (typeof t.name !== "string" || t.name.trim().length < 2 || t.name.length > 256) bad("name must be 2-256 characters");
  if (!t.snippet || t.snippet.trim().length < 2) bad("snippet must be at least 2 characters (live: a 1-character snippet is silently rejected)");
  if (!t.description?.trim()) bad("description is required");
  if (!["Granted", "Additional", "Replacement"].includes(t.featureType)) bad(`featureType must be Granted, Additional or Replacement (got ${JSON.stringify(t.featureType)})`);
  if (t.requiredLevel !== undefined && (!Number.isInteger(t.requiredLevel) || t.requiredLevel < 1 || t.requiredLevel > 20)) bad("requiredLevel must be an integer 1-20");
  if (t.displayOrder !== undefined && !Number.isInteger(t.displayOrder)) bad("displayOrder must be an integer");
}

/** Fill a species-trait CREATE form. Returns what a re-read of the trait's edit form must show. */
export function fillTraitForm(form: ParsedForm, t: HomebrewSpeciesTrait): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: string | number | boolean) => { setControl(form, id, v); asked.set(id, [...controlById(form, id).values]); };
  set("field-name", t.name);
  set("field-snippet", t.snippet);
  setDescription(form, "racial-trait-mapping-description", t.description);
  set("field-feature-type", t.featureType);
  if (t.displayOrder !== undefined) set("field-display-order-field", t.displayOrder);
  if (t.requiredLevel !== undefined) {
    set("field-required-character-level", t.requiredLevel);
    // Level 1 is the default and DDB stores it as blank (live: asked "1", edit form reads back "").
    if (t.requiredLevel === 1) asked.set("field-required-character-level", [""]);
  }
  // The create form ships every box unchecked, but the caller's value is always applied explicitly.
  set("field-hide-in-builder", t.hideInBuilder ?? false);
  set("field-hide-in-sheet", t.hideInSheet ?? false);
  set("field-hide-on-details-page", t.hideOnDetailsPage ?? false);
  set("field-is-called-out", t.isCalledOut ?? false);
  return asked;
}

export function fillOptionForm(form: ParsedForm, o: HomebrewSpeciesOption): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: string | boolean) => { setControl(form, id, v); asked.set(id, [...controlById(form, id).values]); };
  set("field-name", o.name);
  if (o.version !== undefined) set("field-version", o.version);
  setDescription(form, "item-description", o.description);
  if (o.speciesGroup !== undefined) { setGroup(form, o.speciesGroup); asked.set("field-race-group", [...controlById(form, "field-race-group").values]); }
  set("field-is-variant", o.isVariant ?? false);
  return asked;
}

// --- reading the builder's listings ---

const cellText = (el: { text: string }) => el.text.replace(/\s+/g, " ").trim();

export interface ListedTrait { id: number; displayOrder: string; requiredLevel: string; name: string; featureType: string }
export interface ListedOption { id: number; name: string; editPath: string }

/** The trait and option listings on a species edit page (the parent listing is the oracle for sub-entries). */
export function parseSpeciesPage(html: string): { traits: ListedTrait[]; options: ListedOption[] } {
  const traits: ListedTrait[] = [];
  const options: ListedOption[] = [];
  for (const tr of parse(html).querySelectorAll("tr")) {
    const row = tr.toString();
    const td = tr.querySelectorAll("td").map(cellText);
    const t = row.match(/href="\/entity\/species-trait\/(\d+)\/edit"/);
    if (t && td.length >= 5) { traits.push({ id: Number(t[1]), displayOrder: td[0], requiredLevel: td[1], name: td[2], featureType: td[3] }); continue; }
    const o = row.match(/href="(\/homebrew\/creations\/species-options\/(\d+)-[^"]*\/edit)"/);
    if (o) options.push({ id: Number(o[2]), name: td[0] ?? "", editPath: o[1] });
  }
  return { traits, options };
}

export interface ListedModifier { id: number; label: string; fixedValue: string }

/** The modifier listing on a trait's edit page: "Sense - Darkvision" rows. */
export function parseModifierListing(html: string): ListedModifier[] {
  const out: ListedModifier[] = [];
  for (const tr of parse(html).querySelectorAll("table.listing-rpgentity-modifier tr")) {
    const id = tr.toString().match(/href="\/modifier\/(\d+)\/delete"/);
    if (!id) continue;
    const td = tr.querySelectorAll("td").map(cellText);
    out.push({ id: Number(id[1]), label: td[0] ?? "", fixedValue: td[3] ?? "" });
  }
  return out;
}

const SPECIES_EDIT_LOCATION = /\/homebrew\/creations\/species\/((\d+)-[^/?#]+)\/edit/;
const TRAIT_EDIT_LOCATION = /\/entity\/species-trait\/(\d+)\/edit/;
const OPTION_EDIT_LOCATION = /\/homebrew\/creations\/species-options\/(\d+)-[^/?#]+\/edit/;

// --- adding sub-entries ---

interface CreatedTrait { id: number; trait: HomebrewSpeciesTrait; asked: Asked; modifiers: Array<{ label: string; fixedValue?: number }> }
interface CreatedOption { id: number; option: HomebrewSpeciesOption; asked: Asked; editPath: string }

async function addTrait(s: SiteSession, speciesId: number, t: HomebrewSpeciesTrait): Promise<CreatedTrait> {
  const form = await loadForm(s, `/entity/species-trait/create/${speciesId}-${SPECIES_ENTITY_TYPE_ID}`, /species-trait\/create\//);
  const asked = fillTraitForm(form, t);
  let location: string;
  try { location = await submit(s, form, `add trait "${t.name}" to species ${speciesId}`); }
  catch (err) {
    if (err instanceof DdbWriteError && err.status === 200) {
      throw new DdbWriteError(`${err.message} (a trait POST DDB rejects is a silent 200 with no field errors — check name, snippet, description and feature type)`, 200, null);
    }
    throw err;
  }
  const tid = location.match(TRAIT_EDIT_LOCATION)?.[1];
  if (!tid) throw new DdbWriteError(`ddb-homebrew add trait "${t.name}" to species ${speciesId}: unexpected redirect ${location}`, 302, location);
  const id = Number(tid);
  const modifiers: CreatedTrait["modifiers"] = [];
  for (const m of t.modifiers ?? []) {
    const path = `/modifier/create/${id}-${RACIAL_TRAIT_ENTITY_TYPE_ID}/0`;
    const html = await getPage(s, path);
    const mform = parseForm(html, /modifier\/create\//);
    const { typeId, subTypeId } = fillModifierForm(mform, html, m);
    const typeLabel = controlById(mform, "field-spell-modifier-type").options.find((o) => o.value === String(typeId))?.label ?? "";
    const subName = embeddedSubTypes(html).find((x) => x.id === subTypeId && x.type === typeId)?.name ?? "";
    await submit(s, mform, `add ${typeLabel} modifier to trait ${id} ("${t.name}")`);
    modifiers.push({ label: `${typeLabel} - ${subName}`, fixedValue: m.fixedValue });
  }
  return { id, trait: t, asked, modifiers };
}

async function addOption(s: SiteSession, speciesEditPath: string, o: HomebrewSpeciesOption): Promise<CreatedOption> {
  const path = speciesEditPath.replace(/\/edit$/, "/create-species-options/create");
  const form = await loadForm(s, path, /create-species-options\/create$/);
  const asked = fillOptionForm(form, o);
  const location = await submit(s, form, `add option "${o.name}"`);
  const m = location.match(OPTION_EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew add species option "${o.name}": unexpected redirect ${location}`, 302, location);
  return { id: Number(m[1]), option: o, asked, editPath: m[0] };
}

// --- read-back verification ---
//
// Three oracles: the species EDIT FORM (every builder field), the species page's trait/option
// LISTINGS plus each trait's own edit form and modifier listing (sub-entries; no JSON has them),
// and character-service's game-data/races (size and speeds, from an independent source). The JSON
// omits the newest entry about 1 fetch in 4 and never lists a species that has options (only the
// options), so "absent" is "unchecked", not a mismatch.

interface RaceJson { entityRaceId: number; fullName?: string; sizeId?: number; weightSpeeds?: { normal?: Partial<Record<SpeedKey, number>> } }

export function verifyRaceJson(entry: RaceJson, f: HomebrewSpeciesFields): string[] {
  const out: string[] = [];
  if (f.name !== undefined && entry.fullName !== f.name) out.push(`json name: asked ${JSON.stringify(f.name)}, DDB reads back ${JSON.stringify(entry.fullName ?? null)}`);
  if (f.size !== undefined) {
    const want = SPECIES_SIZE_IDS[f.size.trim().toLowerCase()];
    if (want === undefined) out.push(`json size: "${f.size}" is not a known size label`);
    else if (entry.sizeId !== want) out.push(`json size: asked ${f.size} (${want}), DDB reads back sizeId ${entry.sizeId ?? null}`);
  }
  for (const [k, v] of Object.entries(f.speeds ?? {}) as Array<[SpeedKey, number | null | undefined]>) {
    if (v === undefined) continue;
    const want = v ?? 0; // a cleared speed reads back as 0
    const got = entry.weightSpeeds?.normal?.[k] ?? 0;
    if (got !== want) out.push(`json speed ${k}: asked ${want}, DDB reads back ${got}`);
  }
  return out;
}

// Live (14 polls of a fresh species over 55s): the entry is present ~70% of fetches, absent the rest,
// with no trend over time — each fetch is an independent draw, not lag. So a few quick re-fetches
// find it (0.3^4 ≈ 1% to miss), instead of letting the check silently skip on every unlucky read.
async function fetchRace(id: number, attempts: number): Promise<RaceJson | undefined> {
  for (let i = 0; i < attempts; i++) {
    const res = await rtRawFetch(RACES_URL);
    if (res.status !== 200) throw new DdbWriteError(`ddb-homebrew: game-data/races → ${res.status}`, res.status, null);
    const body = await res.json() as { data?: RaceJson[] };
    const hit = (body.data ?? []).find((r) => r.entityRaceId === id);
    if (hit) return hit;
  }
  return undefined;
}

const lc = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort();

export interface SpeciesExpectations {
  asked: Asked;
  fields: HomebrewSpeciesFields;
  traits?: CreatedTrait[];       // set = the species must have exactly these traits
  options?: CreatedOption[];     // set = the species must have exactly these options
}

interface SpeciesRead { page: ReturnType<typeof parseSpeciesPage>; race: RaceJson | undefined }

async function verifyOrThrow(s: SiteSession, id: number, editPath: string, exp: SpeciesExpectations): Promise<SpeciesRead> {
  const { value, mismatches } = await settle<SpeciesRead>(async () => {
    const out: string[] = [];
    const html = await getPage(s, editPath);
    const edit = parseForm(html, /\/edit$/);
    out.push(...verifyEditForm(exp.asked, edit));
    const page = parseSpeciesPage(html);

    if (exp.traits) {
      const want = exp.traits.map((t) => t.id).sort((a, b) => a - b);
      const got = page.traits.map((t) => t.id).sort((a, b) => a - b);
      if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`traits: asked ids [${want.join(", ")}], the species lists [${got.join(", ")}]`);
      for (const t of exp.traits) {
        const row = page.traits.find((r) => r.id === t.id);
        if (row && (row.name !== t.trait.name.trim() || row.featureType !== t.trait.featureType)) {
          out.push(`trait ${t.id}: asked "${t.trait.name}" (${t.trait.featureType}), the species lists "${row.name}" (${row.featureType})`);
        }
        const tpath = `/entity/species-trait/${t.id}/edit`;
        const thtml = await getPage(s, tpath);
        for (const m of verifyEditForm(t.asked, parseForm(thtml, /species-trait\/\d+\/edit$/))) out.push(`trait ${t.id} ("${t.trait.name}") ${m}`);
        const listed = parseModifierListing(thtml);
        const wantMods = t.modifiers.map((m) => m.label);
        if (JSON.stringify(lc(wantMods)) !== JSON.stringify(lc(listed.map((m) => m.label)))) {
          out.push(`trait ${t.id} ("${t.trait.name}") modifiers: asked [${wantMods.join(", ")}], DDB lists [${listed.map((m) => m.label).join(", ")}]`);
        } else {
          // Same label multiset: also compare fixed values where the caller gave one (matched label by label).
          const pool = [...listed];
          for (const m of t.modifiers) {
            const i = pool.findIndex((p) => p.label.toLowerCase() === m.label.toLowerCase() && (m.fixedValue === undefined || p.fixedValue === String(m.fixedValue)));
            if (i < 0 && m.fixedValue !== undefined) out.push(`trait ${t.id} ("${t.trait.name}") modifier ${m.label}: asked fixed value ${m.fixedValue}, DDB lists ${pool.filter((p) => p.label.toLowerCase() === m.label.toLowerCase()).map((p) => JSON.stringify(p.fixedValue)).join("/")}`);
            else if (i >= 0) pool.splice(i, 1);
          }
        }
      }
    }

    if (exp.options) {
      const want = exp.options.map((o) => o.id).sort((a, b) => a - b);
      const got = page.options.map((o) => o.id).sort((a, b) => a - b);
      if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`options: asked ids [${want.join(", ")}], the species lists [${got.join(", ")}]`);
      for (const o of exp.options) {
        for (const m of verifyEditForm(o.asked, parseForm(await getPage(s, o.editPath), /\/edit$/))) out.push(`option ${o.id} ("${o.option.name}") ${m}`);
      }
    }

    // A species with options is never listed itself (only its options), so don't burn re-fetches on it.
    const race = await fetchRace(id, controlById(edit, "field-supports-subrace").values.length ? 1 : 4);
    if (race) out.push(...verifyRaceJson(race, exp.fields));
    return { value: { page, race }, mismatches: out };
  }, settleDelays);
  if (mismatches.length) throw new DdbWriteError(`ddb-homebrew: species ${id} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  return value;
}

// --- the primitives ---

export interface HomebrewSpeciesResult {
  id: number;
  editUrl: string;
  name: string;
  traits: Array<{ id: number; name: string; featureType: string }>;
  options: Array<{ id: number; name: string }>;
  /** The game-data/races entry, or undefined when DDB didn't list it (a species with options never is). */
  raw: RaceJson | undefined;
}

function result(id: number, editPath: string, name: string, read: SpeciesRead): HomebrewSpeciesResult {
  return {
    id, name, editUrl: `https://www.dndbeyond.com${editPath}`, raw: read.race,
    traits: read.page.traits.map((t) => ({ id: t.id, name: t.name, featureType: t.featureType })),
    options: read.page.options.map((o) => ({ id: o.id, name: o.name })),
  };
}

function wrapAfterCreate(id: number, slug: string, err: unknown): never {
  const e = err instanceof DdbWriteError ? err : null;
  throw new DdbWriteError(`ddb-homebrew: species ${id} was created (${slug}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
}

/** The species page only lists (and the character builder only offers) options when supportsOptions is on (live). */
function requireOptionsSupport(f: HomebrewSpeciesFields, current: boolean | undefined): void {
  if (f.options?.length && !(f.supportsOptions ?? current)) {
    throw new DdbWriteError("ddb-homebrew species: options need supportsOptions: true — without it the species page doesn't list them and they could not be verified or deleted with the species", 400, null);
  }
}

export async function createHomebrewSpecies(f: HomebrewSpeciesFields): Promise<HomebrewSpeciesResult> {
  (f.traits ?? []).forEach((t, i) => validateTrait(t, i));
  requireOptionsSupport(f, false);
  const s = rtSiteSession();
  const form = await loadForm(s, "/homebrew/creations/create-species/create", /\/create-species\/create$/);
  const { traits, options, ...base } = f;
  const asked = fillSpeciesForm(form, base);
  const location = await submit(s, form, "create species");
  const m = location.match(SPECIES_EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew create species: unexpected redirect ${location}`, 302, location);
  const id = Number(m[2]);
  const editPath = `/homebrew/creations/species/${m[1]}/edit`;
  // The species exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    const createdTraits: CreatedTrait[] = [];
    for (const t of traits ?? []) createdTraits.push(await addTrait(s, id, t));
    const createdOptions: CreatedOption[] = [];
    for (const o of options ?? []) createdOptions.push(await addOption(s, editPath, o));
    const read = await verifyOrThrow(s, id, editPath, {
      asked, fields: base,
      traits: createdTraits, options: createdOptions,
    });
    return result(id, editPath, f.name ?? "", read);
  } catch (err) { return wrapAfterCreate(id, m[1], err); }
}

export async function updateHomebrewSpecies(id: number, f: HomebrewSpeciesFields): Promise<HomebrewSpeciesResult> {
  (f.traits ?? []).forEach((t, i) => validateTrait(t, i));
  const s = rtSiteSession();
  let editPath = await resolveEditPath(s, SPECIES_ENTITY_TYPE_ID, id);
  const { traits, options, ...base } = f;
  const html = await getPage(s, editPath);
  requireOptionsSupport(f, controlById(parseForm(html, /\/edit$/), "field-supports-subrace").values.length > 0);
  const before = parseSpeciesPage(html);
  let asked: Asked = new Map();
  try {
    if (hasFormFields(f)) {
      const form = parseForm(html, /\/edit$/);
      asked = fillSpeciesForm(form, base);
      const location = await submit(s, form, `update species ${id}`);
      const slug = location.match(SPECIES_EDIT_LOCATION)?.[1];
      if (!slug) throw new DdbWriteError(`ddb-homebrew update species ${id}: unexpected redirect ${location}`, 302, location);
      editPath = `/homebrew/creations/species/${slug}/edit`;
    }
    // Replace = add the new set, then drop what the listing showed before. Adding first means a
    // failure leaves duplicates (recoverable) rather than an emptied species.
    let createdTraits: CreatedTrait[] | undefined;
    if (traits !== undefined) {
      createdTraits = [];
      for (const t of traits) createdTraits.push(await addTrait(s, id, t));
      for (const old of before.traits) await ajaxPost(s, `/entity/species-trait/${old.id}/delete`, `remove trait ${old.id} ("${old.name}") from species ${id}`);
    }
    let createdOptions: CreatedOption[] | undefined;
    if (options !== undefined) {
      createdOptions = [];
      for (const o of options) createdOptions.push(await addOption(s, editPath, o));
      for (const old of before.options) await deleteCreation(s, SPECIES_OPTION_ENTITY_TYPE_ID, old.id, old.editPath);
    }
    const read = await verifyOrThrow(s, id, editPath, { asked, fields: base, traits: createdTraits, options: createdOptions });
    return result(id, editPath, f.name ?? controlName(html), read);
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: updating species ${id} failed: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

function controlName(html: string): string {
  return parseForm(html, /\/edit$/).controls.find((c) => c.id === "field-name")?.values[0] ?? "";
}

/**
 * Delete a homebrew species. Options don't cascade, so each is deleted first (the generic delete,
 * confirmed by its own re-delete 404), then the species. Sub-entries (traits, modifiers) cascade.
 */
export async function deleteHomebrewSpecies(id: number): Promise<{ id: number; deleted: true; optionsDeleted: number[] }> {
  const s = rtSiteSession();
  const editPath = await resolveEditPath(s, SPECIES_ENTITY_TYPE_ID, id);
  const { options } = parseSpeciesPage(await getPage(s, editPath));
  const optionsDeleted: number[] = [];
  for (const o of options) {
    try { await deleteCreation(s, SPECIES_OPTION_ENTITY_TYPE_ID, o.id, o.editPath); }
    catch (err) { throw new DdbWriteError(`ddb-homebrew: species ${id} NOT deleted; deleting its option ${o.id} ("${o.name}") failed: ${(err as Error).message}${optionsDeleted.length ? ` (options already deleted: ${optionsDeleted.join(", ")})` : ""}`, (err as DdbWriteError).status ?? 500, null); }
    optionsDeleted.push(o.id);
  }
  await deleteCreation(s, SPECIES_ENTITY_TYPE_ID, id, editPath);
  return { id, deleted: true, optionsDeleted };
}
