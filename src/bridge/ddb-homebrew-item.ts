// D&D Beyond homebrew MAGIC ITEM creation — create, update, delete — through the site's
// server-rendered builder (see ddb-homebrew.ts for the monster flavour and
// docs/ddb-homebrew-protocol.md + ddb-homebrew-types.md for the shared protocol). Routes below were
// probed live on 2026-10-12; the condition delete and id → edit-page resolution were checked
// live while this module was written.
//
//   create   GET+POST /homebrew/creations/create-magic-item/create       multipart → 303 …/magic-items/{id}-{slug}/edit
//   update   GET+POST /homebrew/creations/magic-items/{id}-{slug}/edit   multipart → 303 (slug follows renames)
//   modifier GET+POST /modifier/create/{id}-112130694/0                  urlencoded → 302 …/edit#…; del /modifier/{subId}/delete
//   condition GET+POST /magic-items/condition/create/{id}                                         del /magic-items/condition/{subId}/delete
//   spell    GET+POST /magic-items/spell/create/{id}                                              del /magic-items/spell/{subId}/delete
//   delete   POST /homebrew/creations/delete?entityTypeId=112130694&id={id}                        (ajax-post)
//
// There is NO JSON read-back for private items (game-data/items excludes homebrew), so every write
// is proven against the re-rendered edit page: its form controls, and the sub-entry listing tables
// (whose rows also carry the sub-entry ids, in their delete links).

import { parse } from "node-html-parser";
import { rtSiteSession, type SiteSession } from "./ddb-rt.js";
import { setControl, clearControl, controlById, type ParsedForm, type OptionValue } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  getPage, loadForm, loadFormPage, submit, ajaxPost, verifyEditForm, deleteCreation, resolveEditPath, settle, SETTLE_DELAYS_MS,
  embeddedSubTypes, fillModifierForm, type Asked, type HomebrewModifier,
} from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const MAGIC_ITEM_ENTITY_TYPE_ID = 112130694;

// --- caller-facing field model (labels, not DDB ids) ---

/** A select choice: the builder's label, or { value } (an option id) where labels repeat. */
export type OptionRef = string | OptionValue;

export type ItemBaseType = "Item" | "Armor" | "Weapon";

export interface HomebrewItemCondition {
  condition: string;                                                  // "Charmed", "Poisoned", …
  duration?: { interval: number; unit: "Round" | "Minute" | "Hour" | "Day" | "Special" | "Until Dispelled" };
  exception?: string;
}

export interface HomebrewItemSpell {
  spell: OptionRef;       // full label "Fireball - [Level 3]", or a plain name that has exactly one non-Legacy match
  minCharges?: number;
  maxCharges?: number;
  saveDc?: number;
  castAtLevel?: number;
  restriction?: string;
}

export interface HomebrewMagicItemFields {
  name?: string;
  version?: string;
  rarity?: string;                  // "Common" … "Artifact", "Varies", "Unknown Rarity"
  baseType?: ItemBaseType;
  itemType?: string;                // Item only: "Wondrous Item", "Rod", "Scroll", "Staff", "Wand", "Ring", "Potion"
  // Armor only
  baseArmor?: OptionRef;
  dexterityModifier?: string;       // "Full Modifier" | "Max 2" | "None"
  strengthRequirement?: number;
  stealthCheck?: string;            // "None" | "Disadvantage"
  // Weapon only (the list holds duplicate labels — pass { value } to disambiguate)
  baseWeapon?: OptionRef;
  requiresAttunement?: boolean;
  attunementDescription?: string;
  description?: string;             // HTML; sent to both the wysiwyg and markup textareas
  // Edit-form-only fields: on create they are applied by a follow-up save.
  charges?: { count: number; resetCondition?: string; resetDescription?: string } | null;   // null switches has-charges off
  notes?: string;
  weight?: number;
  tags?: string[];
  // Sub-entries. On update, a provided list REPLACES that kind wholesale; omitted = untouched.
  modifiers?: HomebrewModifier[];
  conditions?: HomebrewItemCondition[];
  spells?: HomebrewItemSpell[];
}

const ARMOR_FIELDS = ["baseArmor", "dexterityModifier", "strengthRequirement", "stealthCheck"] as const;
const EDIT_ONLY_KEYS = ["charges", "notes", "weight", "tags"] as const;
const SUB_KEYS = ["modifiers", "conditions", "spells"] as const;
type SubKind = (typeof SUB_KEYS)[number];

const bad = (msg: string) => new DdbWriteError(`ddb-homebrew-item: ${msg}`, 400, null);

// --- main form ---

export interface ItemAsked { asked: Asked; weight?: number }

function selectedLabel(form: ParsedForm, id: string): string {
  const c = controlById(form, id);
  return c.options.find((o) => o.value === (c.values[0] ?? ""))?.label ?? "";
}

/**
 * Fill the builder form from caller fields. Pure (no I/O). The server SILENTLY NULLS fields that
 * don't fit the base type (armor fields on a weapon, `type` on armor, …) — live — so a combination
 * that would be dropped is rejected here, against the base type the form will end up with.
 */
export function fillItemForm(form: ParsedForm, f: HomebrewMagicItemFields): ItemAsked {
  const asked: Asked = new Map();
  const set = (id: string, v: Parameters<typeof setControl>[2] | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };

  if (f.baseType === "Item") clearControl(form, "field-item-base-type"); // "Item" is the blank-valued option
  else if (f.baseType !== undefined) setControl(form, "field-item-base-type", f.baseType);
  if (f.baseType !== undefined) asked.set("field-item-base-type", [...controlById(form, "field-item-base-type").values]);
  const kind = (selectedLabel(form, "field-item-base-type") || "Item") as ItemBaseType;

  const misfit = (key: string, wants: string) => bad(
    `"${key}" doesn't apply to a ${kind} item — DDB silently drops it (it applies to ${wants}). ` +
    `${f.baseType === undefined ? `This item's base type is ${kind}; ` : ""}set baseType to the matching kind or omit the field.`);
  if (kind !== "Armor") for (const k of ARMOR_FIELDS) if (f[k] !== undefined) throw misfit(k, "Armor items");
  if (kind !== "Weapon" && f.baseWeapon !== undefined) throw misfit("baseWeapon", "Weapon items");
  if (kind !== "Item" && f.itemType !== undefined) throw misfit("itemType", "plain Items (baseType \"Item\")");

  set("field-name", f.name);
  set("field-version", f.version);
  set("field-rarity", f.rarity);
  set("field-type", f.itemType);
  set("field-base-armor", f.baseArmor);
  set("field-dexterity-modifier", f.dexterityModifier);
  set("field-strength-requirement", f.strengthRequirement);
  set("field-stealth-check", f.stealthCheck);
  set("field-base-weapon", f.baseWeapon);
  set("field-requires-attunement", f.requiresAttunement);
  set("field-attunement-description", f.attunementDescription);
  if (f.attunementDescription && controlById(form, "field-requires-attunement").values.length === 0) {
    throw bad("attunementDescription given but the item doesn't require attunement — set requiresAttunement: true");
  }
  if (kind === "Item" && !controlById(form, "field-type").values[0]) {
    throw bad(`itemType is required for a plain Item ("Wondrous Item", "Rod", "Scroll", "Staff", "Wand", "Ring", "Potion"); for armor or a weapon set baseType.`);
  }
  // Description is a (hidden type, wysiwyg, markup) trio; the server reads the wysiwyg copy.
  // Not compared on read-back: the server may normalize HTML.
  if (f.description !== undefined) {
    setControl(form, "field-item-description-type", "1");
    setControl(form, "field-item-description-wysiwyg", f.description);
    setControl(form, "field-item-description", f.description);
  }

  // Edit-form-only controls (absent from the create form → setControl throws there; create defers them).
  if (f.charges === null) set("field-has-charges", false);
  else if (f.charges) {
    set("field-has-charges", true);
    set("field-number-of-charges", f.charges.count);
    set("field-charge-reset-condition", f.charges.resetCondition);
    set("field-charge-reset-description", f.charges.resetDescription);
  }
  set("field-notes", f.notes);
  set("field-weight", f.weight);
  set("field-magic-item-tags-public", f.tags);
  // The server normalizes "2.5" to "2.50": weight is compared numerically, not as text.
  asked.delete("field-weight");
  return { asked, weight: f.weight };
}

// --- sub-entries ---

/** A loaded + filled sub-form, and how to recognise its entry in the edit page's listing. */
interface Prepared { form: ParsedForm; describe: string; matches(cells: string[]): boolean }

interface SubSpec<T> {
  /** table.<class> on the edit page listing this kind's rows */
  table: string;
  /** a row's delete link (capture 1 = sub-entry id) — taken verbatim from the page */
  deleteLink: RegExp;
  prepare(s: SiteSession, itemId: number, entry: T): Promise<Prepared>;
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
// The condition table renders "2 Hour"/"1 Hour" (no plural); tolerate plural anyway.
const normDuration = (t: string) => norm(t).replace(/s\b/g, "");

/** Resolve a spell choice against the item-spell select; see HomebrewItemSpell.spell. */
export function resolveItemSpell(options: Array<{ value: string; label: string }>, want: OptionRef): { value: string; label: string } {
  const real = options.filter((o) => o.value !== "");
  if (typeof want === "object") {
    const hit = real.find((o) => o.value === want.value);
    if (!hit) throw bad(`item-spell has no option with value "${want.value}"`);
    return hit;
  }
  const w = want.trim();
  let hits = real.filter((o) => o.label === w);
  if (!hits.length) hits = real.filter((o) => o.label.toLowerCase() === w.toLowerCase());
  if (!hits.length) {
    // A plain name: the options are "Name - [Level N]" / "Name (Legacy) - [Level N]". Matching the
    // "Name - [" prefix is what excludes the Legacy and "Jim's Name" variants.
    const prefix = `${w} - [`.toLowerCase();
    hits = real.filter((o) => o.label.toLowerCase().startsWith(prefix));
  }
  if (hits.length === 1) return hits[0];
  const list = (os: typeof real) => os.slice(0, 20).map((o) => `"${o.label}" (value ${o.value})`).join(", ");
  if (hits.length > 1) throw bad(`spell "${w}" matches ${hits.length} options — pass the full label or { value }: ${list(hits)}`);
  const near = real.filter((o) => o.label.toLowerCase().includes(w.toLowerCase()));
  throw bad(`spell "${w}" is not an option of the item spell list.${near.length ? ` Close matches: ${list(near)}` : " No close matches."} Labels look like "Fireball - [Level 3]".`);
}

const spellBase = (label: string) => norm(label.replace(/\s*-\s*\[[^\]]*\]\s*$/, "").replace(/\(legacy\)/i, ""));

const SUBS: { [K in SubKind]: SubSpec<NonNullable<HomebrewMagicItemFields[K]>[number]> } = {
  modifiers: {
    table: "listing-rpgentity-modifier",
    deleteLink: /^\/modifier\/(\d+)\/delete$/,
    async prepare(s, id, m: HomebrewModifier) {
      const { form, html } = await loadFormPage(s, `/modifier/create/${id}-${MAGIC_ITEM_ENTITY_TYPE_ID}/0`, /\/modifier\/create\//);
      const { typeId, subTypeId } = fillModifierForm(form, html, m);
      const typeLabel = controlById(form, "field-spell-modifier-type").options.find((o) => o.value === String(typeId))?.label ?? "";
      const subName = embeddedSubTypes(html).find((st) => st.id === subTypeId)?.name ?? "";
      const label = `${typeLabel} - ${subName}`;
      // Listing columns: Modifier | Dice Roll | Primary Stat | Fixed Value | Restriction | Duration | Actions
      return {
        form, describe: label + (m.fixedValue !== undefined ? ` =${m.fixedValue}` : ""),
        matches: (c) => norm(c[0]) === norm(label)
          && (m.fixedValue === undefined || Number(c[3]) === m.fixedValue)
          && (m.restriction === undefined || norm(c[4]) === norm(m.restriction)),
      };
    },
  },
  conditions: {
    table: "listing-rpgmagic-item-condition-mapping",
    deleteLink: /^\/magic-items\/condition\/(\d+)\/delete$/,
    async prepare(s, id, c: HomebrewItemCondition) {
      const form = await loadForm(s, `/magic-items/condition/create/${id}`, /\/condition\/create\//);
      // The select's NAME is hashed per render; its id is stable.
      setControl(form, "field-item-condition", c.condition);
      const label = selectedLabel(form, "field-item-condition");
      if (c.duration) { setControl(form, "field-condition-duration", c.duration.interval); setControl(form, "field-duration-unit", c.duration.unit); }
      if (c.exception !== undefined) setControl(form, "field-condition-exception", c.exception);
      // Listing columns: Condition Name | Condition Duration | Condition Exception | Actions
      return {
        form, describe: label,
        matches: (cells) => norm(cells[0]) === norm(label)
          && (!c.duration || normDuration(cells[1]) === normDuration(`${c.duration.interval} ${c.duration.unit}`))
          && (c.exception === undefined || norm(cells[2]) === norm(c.exception)),
      };
    },
  },
  spells: {
    table: "listing-rpgitem-spell-mapping",
    deleteLink: /^\/magic-items\/spell\/(\d+)\/delete$/,
    async prepare(s, id, sp: HomebrewItemSpell) {
      const form = await loadForm(s, `/magic-items/spell/create/${id}`, /\/spell\/create\//);
      const opt = resolveItemSpell(controlById(form, "field-item-spell").options, sp.spell);
      setControl(form, "field-item-spell", { value: opt.value });
      if (sp.minCharges !== undefined) setControl(form, "field-min-charges", sp.minCharges);
      if (sp.maxCharges !== undefined) setControl(form, "field-max-charges", sp.maxCharges);
      if (sp.saveDc !== undefined) setControl(form, "field-save-dc", sp.saveDc);
      if (sp.castAtLevel !== undefined) setControl(form, "field-cast-at-level", sp.castAtLevel);
      if (sp.restriction !== undefined) setControl(form, "field-restriction", sp.restriction);
      // Listing columns: Spell Name | Min Charges | Max Charges | Recovery Type | Save DC | Restriction | Actions.
      // (cast-at-level isn't listed anywhere, so it is the one sub-field that can't be read back.)
      return {
        form, describe: opt.label,
        matches: (c) => spellBase(c[0]) === spellBase(opt.label)
          && (sp.minCharges === undefined || Number(c[1]) === sp.minCharges)
          && (sp.maxCharges === undefined || Number(c[2]) === sp.maxCharges)
          && (sp.saveDc === undefined || Number(c[4]) === sp.saveDc)
          && (sp.restriction === undefined || norm(c[5]) === norm(sp.restriction)),
      };
    },
  },
};

export interface ListingRow { subId: number; deletePath: string; cells: string[] }

/** The rows of one sub-entry listing table on an edit page; a row is identified by its delete link. */
export function listingRows(editHtml: string, kind: SubKind): ListingRow[] {
  const spec = SUBS[kind];
  const table = parse(editHtml).querySelector(`table.${spec.table}`);
  if (!table) return [];
  const rows: ListingRow[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const href = tr.querySelectorAll("a").map((a) => a.getAttribute("href") ?? "").find((h) => spec.deleteLink.test(h));
    if (!href) continue;
    rows.push({ subId: Number(href.match(spec.deleteLink)![1]), deletePath: href, cells: tr.querySelectorAll("td").map((td) => td.text.replace(/\s+/g, " ").trim()) });
  }
  return rows;
}

async function prepareAll(s: SiteSession, id: number, f: HomebrewMagicItemFields, kind: SubKind): Promise<Prepared[]> {
  const out: Prepared[] = [];
  for (const entry of (f[kind] ?? []) as unknown[]) out.push(await (SUBS[kind] as SubSpec<unknown>).prepare(s, id, entry));
  return out;
}

/** Add every provided sub-entry; returns what to expect in each kind's listing. */
async function addSubEntries(s: SiteSession, id: number, f: HomebrewMagicItemFields): Promise<Map<SubKind, Prepared[]>> {
  const expected = new Map<SubKind, Prepared[]>();
  for (const kind of SUB_KEYS) {
    if (f[kind] === undefined) continue;
    const prepared = await prepareAll(s, id, f, kind);
    for (const p of prepared) await submit(s, p.form, `add ${kind.replace(/s$/, "")} to magic item ${id}`);
    expected.set(kind, prepared);
  }
  return expected;
}

/** Each expected entry must claim a distinct listed row, and no unexpected row may remain. */
function verifyListing(editHtml: string, expected: Map<SubKind, Prepared[]>): string[] {
  const out: string[] = [];
  for (const [kind, prepared] of expected) {
    const rows = listingRows(editHtml, kind);
    const free = [...rows];
    const missing: string[] = [];
    for (const p of prepared) {
      const i = free.findIndex((r) => p.matches(r.cells));
      if (i < 0) missing.push(p.describe); else free.splice(i, 1);
    }
    if (missing.length || free.length) {
      out.push(`${kind}: asked ${prepared.map((p) => p.describe).join(", ") || "none"}; DDB lists ${rows.map((r) => `[${r.cells.slice(0, -1).join(" | ")}]`).join(" ") || "none"}`);
    }
  }
  return out;
}

// --- plumbing ---

const EDIT_LOCATION = /\/homebrew\/creations\/magic-items\/((\d+)-[^/?#]+)\/edit/;

/** POST the edit form with `f` applied; returns the (possibly renamed) edit path and what was asked. */
async function saveBuilder(s: SiteSession, id: number, editPath: string, f: HomebrewMagicItemFields): Promise<{ editPath: string; ask: ItemAsked }> {
  const form = await loadForm(s, editPath, /\/edit$/);
  const ask = fillItemForm(form, f);
  const location = await submit(s, form, `update magic item ${id}`);
  const slug = location.match(EDIT_LOCATION)?.[1];
  if (!slug) throw new DdbWriteError(`ddb-homebrew-item update magic item ${id}: unexpected redirect ${location}`, 303, location);
  return { editPath: `/homebrew/creations/magic-items/${slug}/edit`, ask };
}

export interface HomebrewItemResult {
  id: number;
  editUrl: string;
  name: string;
  rarity: string;
  baseType: string;
  itemType: string;
  modifiers: number;
  conditions: number;
  spells: number;
}

async function verifyOrThrow(
  s: SiteSession, id: number, editPath: string, asked: Asked, weight: number | undefined, expected: Map<SubKind, Prepared[]>,
): Promise<HomebrewItemResult> {
  const { value, mismatches } = await settle(async () => {
    const { form, html } = await loadFormPage(s, editPath, /\/edit$/);
    const mm = [...verifyEditForm(asked, form), ...verifyListing(html, expected)];
    if (weight !== undefined) {
      const got = controlById(form, "field-weight").values[0] ?? "";
      if (got.trim() === "" || Number(got) !== weight) mm.push(`field-weight: asked ${weight}, DDB has ${JSON.stringify(got)}`);
    }
    return { value: { form, html }, mismatches: mm };
  }, settleDelays);
  if (mismatches.length) {
    throw new DdbWriteError(`ddb-homebrew-item: magic item ${id} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  }
  const { form, html } = value;
  return {
    id, editUrl: `https://www.dndbeyond.com${editPath}`,
    name: controlById(form, "field-name").values[0] ?? "",
    rarity: selectedLabel(form, "field-rarity"),
    baseType: selectedLabel(form, "field-item-base-type") || "Item",
    itemType: selectedLabel(form, "field-type"),
    modifiers: listingRows(html, "modifiers").length,
    conditions: listingRows(html, "conditions").length,
    spells: listingRows(html, "spells").length,
  };
}

// --- the primitives ---

export async function createHomebrewMagicItem(f: HomebrewMagicItemFields): Promise<HomebrewItemResult> {
  const s = rtSiteSession();
  // The create form lacks charges/notes/weight/tags (live: edit-only), so they're a follow-up save.
  const { charges, notes, weight, tags, modifiers, conditions, spells, ...base } = f;
  const editOnly: HomebrewMagicItemFields = { charges, notes, weight, tags };
  const hasEditOnly = EDIT_ONLY_KEYS.some((k) => editOnly[k] !== undefined);
  const form = await loadForm(s, "/homebrew/creations/create-magic-item/create", /\/create-magic-item\/create$/);
  const { asked } = fillItemForm(form, base);
  const location = await submit(s, form, "create magic item");
  const m = location.match(EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew-item create: unexpected redirect ${location}`, 303, location);
  const id = Number(m[2]);
  let editPath = `/homebrew/creations/magic-items/${m[1]}/edit`;
  // The item exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    let wantWeight: number | undefined;
    if (hasEditOnly) {
      const saved = await saveBuilder(s, id, editPath, editOnly);
      editPath = saved.editPath;
      for (const [k, v] of saved.ask.asked) asked.set(k, v);
      wantWeight = saved.ask.weight;
    }
    const expected = await addSubEntries(s, id, { modifiers, conditions, spells });
    return await verifyOrThrow(s, id, editPath, asked, wantWeight, expected);
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew-item: magic item ${id} was created (${m[1]}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

export async function updateHomebrewMagicItem(id: number, f: HomebrewMagicItemFields): Promise<HomebrewItemResult> {
  const s = rtSiteSession();
  let editPath = await resolveEditPath(s, MAGIC_ITEM_ENTITY_TYPE_ID, id);
  const { modifiers, conditions, spells, ...builder } = f;
  const subs = { modifiers, conditions, spells };
  const replacing = SUB_KEYS.filter((k) => subs[k] !== undefined);
  // Validate every new sub-entry (labels, spell names) BEFORE the first destructive call, so a typo
  // can't leave a kind half-replaced. The forms are re-fetched for the real submit (fresh tokens).
  for (const kind of replacing) await prepareAll(s, id, subs, kind);

  let asked: Asked = new Map();
  let weight: number | undefined;
  if (Object.values(builder).some((v) => v !== undefined)) {
    const saved = await saveBuilder(s, id, editPath, builder);
    editPath = saved.editPath; asked = saved.ask.asked; weight = saved.ask.weight;
  }
  let expected = new Map<SubKind, Prepared[]>();
  if (replacing.length) {
    try {
      // Replace: drop the rows the edit page lists (hrefs verbatim), then add the new set.
      const html = await getPage(s, editPath);
      for (const kind of replacing) {
        for (const row of listingRows(html, kind)) await ajaxPost(s, row.deletePath, `remove ${kind.replace(/s$/, "")} ${row.subId} from magic item ${id}`);
      }
      expected = await addSubEntries(s, id, subs);
    } catch (err) {
      const e = err instanceof DdbWriteError ? err : null;
      throw new DdbWriteError(`ddb-homebrew-item: magic item ${id}: replacing ${replacing.join("/")} failed part-way (the old rows may be gone and the new ones incomplete): ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
    }
  }
  return verifyOrThrow(s, id, editPath, asked, weight, expected);
}

/**
 * Delete a homebrew magic item (sub-entries cascade). Confirmed by a repeat delete answering 404;
 * the edit page and public view flap after a delete.
 */
export async function deleteHomebrewMagicItem(id: number): Promise<{ id: number; deleted: true }> {
  const s = rtSiteSession();
  return deleteCreation(s, MAGIC_ITEM_ENTITY_TYPE_ID, id, await resolveEditPath(s, MAGIC_ITEM_ENTITY_TYPE_ID, id));
}
