// D&D Beyond homebrew MONSTER creation — create, update, delete — without the site's builder UX.
//
// There is no JSON API for homebrew. The site's own server-rendered builders on www are the only
// write surface, so this module drives them over plain HTTP exactly as a browser would: GET the
// live form (fresh CSRF tokens + per-render hashed field names), fill controls by their STABLE
// element ids, post every control, and read the result back from monster-service. Like
// ddb-write.ts this is a primitive surface — no policy, the caller owns intent. Gating is
// DDB_WRITES, enforced where the tools register.
//
// Every route here was verified live on 2026-10-12 against a throwaway private monster (see
// docs/ddb-homebrew-protocol.md for the captured shapes):
//   create   GET+POST /homebrew/creations/create-monster/create          multipart → 303 …/{id}-{slug}/edit
//   update   GET+POST /homebrew/creations/monsters/{id}-{slug}/edit      multipart → 303 (slug follows renames)
//   sub-add  GET+POST /monster/{movement|senses|skills}/create/{id}, /entity/language/create/{id}-779871897
//                                                                        urlencoded → 302 …/edit#{section}
//   sub-del  POST /monster/{kind}/{subId}/delete, /entity/language/{subId}/delete      (ajax-post)
//   delete   POST /homebrew/creations/delete?entityTypeId=779871897&id={id}           (ajax-post)
// ajax-post = urlencoded `request-verification-token` = the RequestVerificationToken cookie, which
// POST /refresh-request-verification-token mints (the site's Cobalt.Utils does the same).
// A rejected form POST answers 200 + the re-rendered form with <span class="field-errors">.
// Sub-forms validate weakly server-side (a skill with no value is accepted), so read-back
// verification — not the redirect — is what proves a write landed as asked.

import { rtSiteSession, rtGetHomebrewMonster, type SiteSession } from "./ddb-rt.js";

export type { Asked } from "./ddb-homebrew-core.js";
export { verifyEditForm } from "./ddb-homebrew-core.js";
import { parseForm, setControl, controlById, type ParsedForm } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import { getPage, loadForm, submit, ajaxPost, verifyEditForm, deleteCreation, settle, SETTLE_DELAYS_MS, type Asked } from "./ddb-homebrew-core.js";

// Read-back retry schedule (see settle()); tests shorten it.
let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }
import { challengeRatingLabel, SIZES, ALIGNMENTS } from "./ddb-monster-tables.js";

export const MONSTER_ENTITY_TYPE_ID = 779871897;

// --- caller-facing field model (labels, not DDB ids — select values are matched by label) ---

export interface HomebrewMovement { type: string; speed: number; note?: string }
export interface HomebrewSense { sense: string; note?: string }
export interface HomebrewSkill { skill: string; value: number; additionalBonus?: number }
export interface HomebrewLanguage { language: string; note?: string }
export type AbilityKey = "str" | "dex" | "con" | "int" | "wis" | "cha";

export interface HomebrewMonsterFields {
  name?: string;
  statBlock?: string;            // "5e" | "5.5e" (the form's labels)
  version?: string;
  type?: string;                 // "Humanoid", "Fiend", …
  subTypes?: string[];
  size?: string;                 // "Medium", "Medium or Small", …
  alignment?: string;
  challengeRating?: string;      // "1/4", "5", …
  armorClass?: number;
  armorClassType?: string;
  initiativeBonus?: number;
  passivePerception?: number;
  averageHitPoints?: number;
  hitDice?: { count: number; die: number; modifier?: number };
  abilities?: Partial<Record<AbilityKey, number>>;
  savingThrows?: string[];       // proficiencies, by label: "DEX", "WIS"
  damageAdjustments?: string[];  // by label: "Fire - Resistance"
  conditionImmunities?: string[];
  habitats?: string[];
  tags?: string[];
  treasure?: string[];
  gear?: string;
  languagesNote?: string;
  // Descriptions are HTML (the builder's wysiwyg content). DDB markup works inside them, e.g.
  // [rollable]+5;{"diceNotation":"1d20+5","rollType":"to hit","rollAction":"Bite"}[/rollable].
  traits?: string;
  actions?: string;
  bonusActions?: string;
  reactions?: string;
  characteristics?: string;
  legendaryActions?: string | null;   // null clears is-legendary
  mythicActions?: string | null;
  lair?: { description: string; xp?: number } | null;   // xp: the "Lair XP" select (10 … 155000)
  // Sub-entries. On update, a provided list REPLACES that kind wholesale; omitted = untouched.
  movements?: HomebrewMovement[];
  senses?: HomebrewSense[];
  skills?: HomebrewSkill[];
  languages?: HomebrewLanguage[];
}

const ABILITY_IDS: Record<AbilityKey, { field: string; statId: number }> = {
  str: { field: "field-strength", statId: 1 },
  dex: { field: "field-dexterity", statId: 2 },
  con: { field: "field-constitution", statId: 3 },
  int: { field: "field-intelligence", statId: 4 },
  wis: { field: "field-wisdom", statId: 5 },
  cha: { field: "field-charisma", statId: 6 },
};

// Each description is a (hidden type, wysiwyg, markup) trio; type 1 = wysiwyg. The builder posts
// both textareas, so both carry the same HTML.
const DESCRIPTIONS = {
  traits: "special-traits",
  actions: "actions",
  bonusActions: "bonus-actions",
  reactions: "reactions",
  characteristics: "monster-characteristics",
  legendaryActions: "legendary-actions",
  mythicActions: "mythic-actions",
  lair: "lair",
} as const;

function setDescription(form: ParsedForm, key: string, html: string): void {
  setControl(form, `field-${key}-description-type`, "1");
  setControl(form, `field-${key}-description-wysiwyg`, html);
  setControl(form, `field-${key}-description`, html);
}

/**
 * Fill the main builder form from caller fields. Pure (no I/O) so it is unit-testable against a
 * captured page. `fresh` = a create form: its description textareas ship pre-filled with DDB's
 * placeholder templates ("Trait Name. Enter the description…"), which would be SAVED verbatim, so
 * every description the caller didn't supply is blanked. Returns the non-description controls it
 * set (descriptions are excluded: the server may normalize HTML, so they aren't compared).
 */
export function fillMonsterForm(form: ParsedForm, f: HomebrewMonsterFields, fresh: boolean): Asked {
  const asked: Asked = new Map();
  const set = (id: string, v: string | number | boolean | Array<string | number> | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-stat-block-type", f.statBlock);
  set("field-Name", f.name);
  set("field-version", f.version);
  set("field-monster-type", f.type);
  set("field-monster-sub-type", f.subTypes);
  set("field-size", f.size);
  set("field-alignment", f.alignment);
  set("field-challenge-rating", f.challengeRating);
  set("field-armor-class", f.armorClass);
  set("field-armor-class-type", f.armorClassType);
  set("field-initiative-bonus", f.initiativeBonus);
  set("field-passive-perception", f.passivePerception);
  set("field-average-hit-points", f.averageHitPoints);
  if (f.hitDice) {
    set("field-hit-points-die-count", f.hitDice.count);
    set("field-hit-points-die-value", `d${f.hitDice.die}`);
    // DDB stores a blank modifier as "0" (live), so an omitted modifier is sent as the 0 it becomes.
    set("field-hit-points-modifier", f.hitDice.modifier ?? 0);
  }
  for (const [k, v] of Object.entries(f.abilities ?? {}) as Array<[AbilityKey, number | undefined]>) {
    set(ABILITY_IDS[k].field, v);
  }
  set("field-monster-saving-throw", f.savingThrows);
  set("field-damage-adjustment", f.damageAdjustments);
  set("field-condition-immunity", f.conditionImmunities);
  set("field-monster-environments", f.habitats);
  set("field-monster-tags-public", f.tags);
  set("field-treasure", f.treasure);
  set("field-gear-description", f.gear);
  set("field-languages-note", f.languagesNote);

  for (const k of ["traits", "actions", "bonusActions", "reactions", "characteristics"] as const) {
    const html = f[k];
    if (html !== undefined) setDescription(form, DESCRIPTIONS[k], html);
    else if (fresh) setDescription(form, DESCRIPTIONS[k], "");
  }
  // Legendary / mythic / lair are a checkbox + description; null switches them off.
  const toggled: Array<[string, string, string | null | undefined]> = [
    ["field-is-legendary", DESCRIPTIONS.legendaryActions, f.legendaryActions],
    ["field-is-mythic", DESCRIPTIONS.mythicActions, f.mythicActions],
    ["field-has-lair", DESCRIPTIONS.lair, f.lair === undefined ? undefined : f.lair === null ? null : f.lair.description],
  ];
  for (const [box, key, html] of toggled) {
    if (html === undefined) { if (fresh) setDescription(form, key, ""); continue; }
    set(box, html !== null);
    setDescription(form, key, html ?? "");
  }
  set("field-lair-challenge-rating", f.lair?.xp === undefined ? undefined : String(f.lair.xp)); // the "Lair XP" select
  return asked;
}

// --- sub-entries (movement / senses / skills / languages) ---

type SubKind = "movements" | "senses" | "skills" | "languages";

interface SubformSpec<T> {
  createPath(monsterId: number): string;
  deletePath(subId: number): string;
  /** Matches this kind's per-entry delete links on the edit page (capture 1 = sub-entry id). */
  deleteLink: RegExp;
  fill(form: ParsedForm, entry: T): void;
}

const SUBFORMS: { [K in SubKind]: SubformSpec<NonNullable<HomebrewMonsterFields[K]>[number]> } = {
  movements: {
    createPath: (id) => `/monster/movement/create/${id}`,
    deletePath: (sub) => `/monster/movement/${sub}/delete`,
    deleteLink: /href="\/monster\/movement\/(\d+)\/delete"/g,
    fill: (form, m: HomebrewMovement) => {
      setControl(form, "field-movement-type", m.type);
      setControl(form, "field-speed", m.speed);
      if (m.note !== undefined) setControl(form, "field-note", m.note);
    },
  },
  senses: {
    createPath: (id) => `/monster/senses/create/${id}`,
    deletePath: (sub) => `/monster/senses/${sub}/delete`,
    deleteLink: /href="\/monster\/senses\/(\d+)\/delete"/g,
    fill: (form, s: HomebrewSense) => {
      setControl(form, "field-sense", s.sense);
      if (s.note !== undefined) setControl(form, "field-sense-note", s.note);
    },
  },
  skills: {
    createPath: (id) => `/monster/skills/create/${id}`,
    deletePath: (sub) => `/monster/skills/${sub}/delete`,
    deleteLink: /href="\/monster\/skills\/(\d+)\/delete"/g,
    // "Base Value" is the statblock's TOTAL bonus (value 4 renders as Perception +4).
    fill: (form, s: HomebrewSkill) => {
      setControl(form, "field-skill", s.skill);
      setControl(form, "field-value", s.value);
      if (s.additionalBonus !== undefined) setControl(form, "field-additional-bonus", s.additionalBonus);
    },
  },
  languages: {
    createPath: (id) => `/entity/language/create/${id}-${MONSTER_ENTITY_TYPE_ID}`,
    deletePath: (sub) => `/entity/language/${sub}/delete`,
    deleteLink: /href="\/entity\/language\/(\d+)\/delete"/g,
    fill: (form, l: HomebrewLanguage) => {
      setControl(form, "field-language", l.language);
      if (l.note !== undefined) setControl(form, "field-note", l.note);
    },
  },
};

const SUB_KINDS = Object.keys(SUBFORMS) as SubKind[];

/** Sub-entry ids of one kind listed on a monster's edit page. */
export function subEntryIds(editHtml: string, kind: SubKind): number[] {
  return [...editHtml.matchAll(SUBFORMS[kind].deleteLink)].map((m) => Number(m[1]));
}

/** Resolve a monster's current edit path. The slug changes on rename; monster-service's url tracks it. */
async function editPathFor(monsterId: number): Promise<string> {
  const raw = await rtGetHomebrewMonster(monsterId);
  if (!raw.isHomebrew) throw new DdbWriteError(`ddb-homebrew: monster ${monsterId} (${raw.name}) is not homebrew`, 400, null);
  const slug = String(raw.url ?? "").match(/\/monsters\/(\d+-[^/?#]+)/)?.[1];
  if (!slug) throw new DdbWriteError(`ddb-homebrew: monster ${monsterId} has no url to derive its edit page from`, 500, raw.url);
  return `/homebrew/creations/monsters/${slug}/edit`;
}

const EDIT_LOCATION = /\/homebrew\/creations\/monsters\/((\d+)-[^/?#]+)\/edit/;

// --- read-back verification ---
//
// Three oracles, because none covers everything: the re-rendered EDIT FORM shows every builder
// field (treasure, tags, habitats, saves aren't in monster-service), and MONSTER-SERVICE is the only
// place sub-entries (movements/senses/skills/languages) read back as data, and the read side's baked
// id tables check the caller's labels independently of how this module resolved them.

/**
 * Independent cross-check of the caller's LABELS against monster-service through the read side's
 * own baked id tables. The edit-form oracle only proves DDB stored what we posted; if a label were
 * resolved to the wrong option (it happened: value/label collision on CR), both sides would agree
 * and only this check would notice.
 */
export function verifyLabels(raw: any, f: HomebrewMonsterFields): string[] {
  const out: string[] = [];
  const eq = (field: string, want: string | number | undefined, got: string | number | undefined) => {
    if (want !== undefined && String(want).toLowerCase() !== String(got ?? "").toLowerCase()) {
      out.push(`${field}: asked ${JSON.stringify(want)}, DDB reads back ${JSON.stringify(got ?? null)}`);
    }
  };
  eq("name", f.name, raw.name);
  eq("challengeRating", f.challengeRating, challengeRatingLabel(raw.challengeRatingId));
  eq("size", f.size, SIZES[raw.sizeId]);
  eq("alignment", f.alignment, ALIGNMENTS[raw.alignmentId]);
  eq("armorClass", f.armorClass, raw.armorClass);
  eq("averageHitPoints", f.averageHitPoints, raw.averageHitPoints);
  eq("passivePerception", f.passivePerception, raw.passivePerception);
  if (f.hitDice) {
    eq("hitDice.count", f.hitDice.count, raw.hitPointDice?.diceCount);
    eq("hitDice.die", f.hitDice.die, raw.hitPointDice?.diceValue);
  }
  for (const [k, v] of Object.entries(f.abilities ?? {}) as Array<[AbilityKey, number | undefined]>) {
    eq(k, v, (raw.stats ?? []).find((st: { statId: number }) => st.statId === ABILITY_IDS[k].statId)?.value);
  }
  return out;
}

export interface ResolvedSubs {
  movements: Array<{ movementId: number; speed: number }>;
  senses: Array<{ senseId: number; notes: string }>;
  skills: Array<{ skillId: number; value: number }>;
  languages: Array<{ languageId: number }>;
}

/** Mismatches between the sub-entries asked (ids resolved from the live sub-forms) and monster-service's record. */
export function verifySubEntries(raw: any, kinds: SubKind[], resolved: ResolvedSubs): string[] {
  const got: ResolvedSubs = {
    movements: (raw.movements ?? []).map((m: any) => ({ movementId: m.movementId, speed: m.speed })),
    senses: (raw.senses ?? []).map((m: any) => ({ senseId: m.senseId, notes: m.notes ?? "" })),
    skills: (raw.skills ?? []).map((m: any) => ({ skillId: m.skillId, value: m.value })),
    languages: (raw.languages ?? []).map((m: any) => ({ languageId: m.languageId })),
  };
  const out: string[] = [];
  for (const kind of kinds) {
    const w = (resolved[kind] as object[]).map((o) => JSON.stringify(o)).sort();
    const g = (got[kind] as object[]).map((o) => JSON.stringify(o)).sort();
    if (JSON.stringify(w) !== JSON.stringify(g)) out.push(`${kind}: asked ${w.join(" ") || "none"}, DDB has ${g.join(" ") || "none"}`);
  }
  return out;
}

// Resolve sub-entry labels to the ids the sub-forms submit, for verification. Done while filling,
// from the live sub-form's options, so no id table is baked here.
async function addAndResolveSubEntries(s: SiteSession, monsterId: number, f: HomebrewMonsterFields): Promise<ResolvedSubs> {
  const resolved: ResolvedSubs = { movements: [], senses: [], skills: [], languages: [] };
  for (const kind of SUB_KINDS) {
    const spec = SUBFORMS[kind] as SubformSpec<unknown>;
    for (const entry of (f[kind] ?? []) as unknown[]) {
      const form = await loadForm(s, spec.createPath(monsterId), /create\//);
      spec.fill(form, entry);
      const sel = (id: string) => Number(controlById(form, id).values[0]);
      if (kind === "movements") resolved.movements.push({ movementId: sel("field-movement-type"), speed: (entry as HomebrewMovement).speed });
      if (kind === "senses") resolved.senses.push({ senseId: sel("field-sense"), notes: (entry as HomebrewSense).note ?? "" });
      if (kind === "skills") resolved.skills.push({ skillId: sel("field-skill"), value: (entry as HomebrewSkill).value });
      if (kind === "languages") resolved.languages.push({ languageId: sel("field-language") });
      await submit(s, form, `add ${kind.replace(/s$/, "")} to monster ${monsterId}`);
    }
  }
  return resolved;
}

async function verifyOrThrow(s: SiteSession, monsterId: number, editPath: string, asked: Asked, f: HomebrewMonsterFields, resolved: ResolvedSubs): Promise<any> {
  const { value: raw, mismatches } = await settle(async () => {
    const edit = parseForm(await getPage(s, editPath), /\/edit$/);
    const raw = await rtGetHomebrewMonster(monsterId);
    return { value: raw, mismatches: [...verifyEditForm(asked, edit), ...verifyLabels(raw, f), ...verifySubEntries(raw, SUB_KINDS.filter((k) => f[k] !== undefined), resolved)] };
  }, settleDelays);
  if (mismatches.length) {
    throw new DdbWriteError(`ddb-homebrew: monster ${monsterId} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  }
  return raw;
}

/** POST the edit form with `f` applied; returns the (possibly renamed) edit path and what was asked. */
async function saveBuilder(s: SiteSession, monsterId: number, editPath: string, f: HomebrewMonsterFields): Promise<{ editPath: string; editHtml: string; asked: Asked }> {
  const editHtml = await getPage(s, editPath);
  const form = parseForm(editHtml, /\/edit$/);
  const asked = fillMonsterForm(form, f, false);
  const location = await submit(s, form, `update monster ${monsterId}`);
  const slug = location.match(EDIT_LOCATION)?.[1];
  if (!slug) throw new DdbWriteError(`ddb-homebrew update monster ${monsterId}: unexpected redirect ${location}`, 303, location);
  return { editPath: `/homebrew/creations/monsters/${slug}/edit`, editHtml, asked };
}

// --- the primitives ---

export interface HomebrewWriteResult { id: number; editUrl: string; raw: any }

export async function createHomebrewMonster(f: HomebrewMonsterFields): Promise<HomebrewWriteResult> {
  const s = rtSiteSession();
  const form = await loadForm(s, "/homebrew/creations/create-monster/create", /\/create-monster\/create$/);
  // `treasure` crashes the CREATE handler (→ /error, live-verified with every option) but saves
  // fine through the edit form, so it is applied as a follow-up builder save.
  const { treasure, ...base } = f;
  const asked = fillMonsterForm(form, base, true);
  const location = await submit(s, form, "create monster");
  const m = location.match(EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew create monster: unexpected redirect ${location}`, 303, location);
  const id = Number(m[2]);
  let editPath = `/homebrew/creations/monsters/${m[1]}/edit`;
  // The monster exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    if (treasure !== undefined) {
      const saved = await saveBuilder(s, id, editPath, { treasure });
      editPath = saved.editPath;
      for (const [k, v] of saved.asked) asked.set(k, v);
    }
    const resolved = await addAndResolveSubEntries(s, id, f);
    const raw = await verifyOrThrow(s, id, editPath, asked, f, resolved);
    return { id, editUrl: `https://www.dndbeyond.com${editPath}`, raw };
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: monster ${id} was created (${m[1]}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

export async function updateHomebrewMonster(monsterId: number, f: HomebrewMonsterFields): Promise<HomebrewWriteResult> {
  const s = rtSiteSession();
  const { editPath, editHtml, asked } = await saveBuilder(s, monsterId, await editPathFor(monsterId), f);
  // Replace each provided sub-entry kind: drop what the edit page listed, then add the new set.
  // (The movement sub-form also hides types already present, so delete-first is required.)
  for (const kind of SUB_KINDS) {
    if (f[kind] === undefined) continue;
    for (const sub of subEntryIds(editHtml, kind)) await ajaxPost(s, SUBFORMS[kind].deletePath(sub), `remove ${kind.replace(/s$/, "")} ${sub} from monster ${monsterId}`);
  }
  const resolved = await addAndResolveSubEntries(s, monsterId, f);
  const raw = await verifyOrThrow(s, monsterId, editPath, asked, f, resolved);
  return { id: monsterId, editUrl: `https://www.dndbeyond.com${editPath}`, raw };
}

/**
 * Delete a homebrew monster. monster-service keeps serving deleted homebrew from cache, so the
 * oracle is the builder: once deleted, the edit page stops being served.
 */
export async function deleteHomebrewMonster(monsterId: number): Promise<{ id: number; deleted: true }> {
  return deleteCreation(rtSiteSession(), MONSTER_ENTITY_TYPE_ID, monsterId, await editPathFor(monsterId));
}
