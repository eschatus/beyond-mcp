// D&D Beyond homebrew BACKGROUND creation — create, update, delete — without the site's builder UX.
//
// Same approach as ddb-homebrew.ts (monsters): drive the site's server-rendered builder over plain
// HTTP, fill controls by their stable element ids, post every control. Primitive surface: no
// policy, the caller owns intent; gating is DDB_WRITES where the tools register. Routes verified
// live on 2026-10-12/13 (docs/ddb-homebrew-types.md, "background"):
//   create   GET+POST /homebrew/creations/create-background/create           multipart → 302 …/create-background/{id}-{slug}/edit
//   update   GET+POST /homebrew/creations/create-background/{id}-{slug}/edit  multipart → 302 (slug follows renames)
//   locate   GET /homebrew/creations/edit?entityTypeId=1669830167&id={id}     302 → the current edit path (a stale slug 404s)
//   pools    GET+POST /modifier/create/{id}-1669830167/{1 skills|2 tools|3 languages}   urlencoded → 302;
//            ONE row per POST, from a multi-select (field-spell-modifier-default-sub-types). The builder's own
//            text: "To specify a granted background proficiency, add the single proficiency below. To specify
//            a list of possible proficiencies to choose from, add all of those proficiencies below." So a row
//            holding ONE option is a FIXED grant (what official 2024 backgrounds hold: one proficiency modifier
//            per granted skill/tool, live-checked on character data), and a row holding several is a pool.
//            Not reachable here: the "Choose a Gaming Set" / "Choose a Language" generic subtypes official
//            backgrounds use (the pool POST answers "Nonexistent entity #408"); a pool of the concrete options
//            is the closest representation.
//   feat     /backgrounds/{id}-{slug}/granted-feat/create   (field-name, field-feat multi)
//   gear     /entity/starting-equipment-slot/create/{id}-1669830167   (field-name)
//   traits   /backgrounds/{id}-{slug}/characteristic/create   (field-type, field-name)
//   delete   sub-entries: the edit page's own delete hrefs, verbatim, as ajax-post; creation: generic delete
//
// There is NO JSON read-back for private drafts, so verification re-reads the edit page: the main
// form's controls, each section's rows and "(n)" counts, and the sub-entry edit forms where the
// listing can't show the selection (which ids a pool or granted feat holds — tool and language
// labels have true duplicates, so labels alone can't prove the right id was stored).

import { parse, type HTMLElement } from "node-html-parser";
import { rtSiteSession, type SiteSession } from "./ddb-rt.js";
import { parseForm, setControl, controlById, type ParsedForm, type ControlValue } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import { getPage, loadForm, submit, ajaxPost, verifyEditForm, deleteCreation, resolveEditPath, settle, SETTLE_DELAYS_MS, type Asked } from "./ddb-homebrew-core.js";

let settleDelays: readonly number[] = SETTLE_DELAYS_MS;
export function setSettleDelaysForTests(d: readonly number[]): void { settleDelays = d; }

export const BACKGROUND_ENTITY_TYPE_ID = 1669830167;

// --- caller-facing field model (builder LABELS, not ids) ---

/** A multi-select choice: the option's label, or { value } (the option id) when the label is duplicated. */
export type OptionPick = string | { value: string };
export type CharacteristicType = "Personality Trait" | "Ideal" | "Bond" | "Flaw";
export interface TitledText { name: string; description: string }

export interface HomebrewBackgroundFields {
  name?: string;
  version?: string;
  introduction?: string;                       // "short-description", required by the builder; HTML
  abilityScoresDescription?: string;           // HTML below
  featDescription?: string;
  skillProficienciesDescription?: string;
  toolProficienciesDescription?: string;
  languagesDescription?: string;
  equipmentDescription?: string;
  suggestedCharacteristicsDescription?: string;
  feature?: TitledText;
  variant?: TitledText;                        // optional variant-background blurb
  variantFeature?: TitledText;
  table?: TitledText;                          // the background-specific table's intro (rows are out of v1)
  spellListIntro?: { before?: string; after?: string };
  contactsDescription?: string;
  tags?: string[];
  // Sub-entries. On update a provided value REPLACES that kind wholesale; omitted = untouched.
  // null removes it. Empty pools / feat lists are rejected: the server would store an empty row.
  // Proficiency rows come in two shapes per kind. `skills` / `tools` / `languages` is ONE "choose one of
  // these" pool; `skillGrants` / `toolGrants` / `languageGrants` are FIXED grants, one row per entry (each
  // listed proficiency is granted outright). A kind's rows are replaced wholesale when either field is
  // given (pass both to keep both); null / [] removes that field's rows.
  skills?: OptionPick[] | null;
  tools?: OptionPick[] | null;
  languages?: OptionPick[] | null;
  skillGrants?: OptionPick[] | null;
  toolGrants?: OptionPick[] | null;
  languageGrants?: OptionPick[] | null;
  grantedFeat?: { name: string; feats: OptionPick[] } | null;
  equipment?: string[];                        // free-text slots; [] clears
  characteristics?: Array<{ type: CharacteristicType; text: string }>;   // [] clears
}

const DESCRIPTIONS: Array<[keyof HomebrewBackgroundFields, string]> = [
  ["introduction", "short-description"],
  ["abilityScoresDescription", "ability-scores-description"],
  ["featDescription", "feat-description"],
  ["skillProficienciesDescription", "skill-proficiencies-description"],
  ["toolProficienciesDescription", "tool-proficiencies-description"],
  ["languagesDescription", "languages-description"],
  ["equipmentDescription", "equipment-description"],
  ["suggestedCharacteristicsDescription", "suggested-characteristics-description"],
  ["contactsDescription", "contacts-description"],
];
// {name, description} pairs: [field, name control (without "field-"), description key]
const TITLED: Array<[keyof HomebrewBackgroundFields, string, string]> = [
  ["feature", "feature-name", "feature-description"],
  ["variant", "variant-name", "variant-description"],
  ["variantFeature", "variant-feature-name", "variant-feature-description"],
  ["table", "attribute-name", "attribute-description"],
];

const CHARACTERISTIC_TYPES: CharacteristicType[] = ["Personality Trait", "Ideal", "Bond", "Flaw"];

/** Each rich field is a (hidden type=1, wysiwyg, plain) trio; the server reads -wysiwyg, so all carry the HTML. */
function setDescription(form: ParsedForm, key: string, html: string, asked: Map<string, string>): void {
  setControl(form, `field-${key}-type`, "1");
  setControl(form, `field-${key}-wysiwyg`, html);
  setControl(form, `field-${key}`, html);
  asked.set(`field-${key}-wysiwyg`, html);
}

/**
 * Fill the main builder form. Pure. Returns the non-description controls set (compared exactly) and
 * the descriptions set (compared tolerantly — see sameHtml). Nothing is blanked on create: the
 * background builder ships no placeholder templates (live-verified).
 */
export function fillBackgroundForm(form: ParsedForm, f: HomebrewBackgroundFields): { asked: Asked; descriptions: Map<string, string>; touched: boolean } {
  const asked: Asked = new Map();
  const descriptions = new Map<string, string>();
  const set = (id: string, v: ControlValue | undefined) => {
    if (v === undefined) return;
    setControl(form, id, v);
    asked.set(id, [...controlById(form, id).values]);
  };
  set("field-name", f.name);
  set("field-version", f.version);
  set("field-background-tags-public", f.tags);
  for (const [k, key] of DESCRIPTIONS) {
    const html = f[k] as string | undefined;
    if (html !== undefined) setDescription(form, key, html, descriptions);
  }
  for (const [k, nameId, descKey] of TITLED) {
    const t = f[k] as TitledText | undefined;
    if (!t) continue;
    set(`field-${nameId}`, t.name);
    setDescription(form, descKey, t.description, descriptions);
  }
  if (f.spellListIntro?.before !== undefined) setDescription(form, "spell-list-pre-description", f.spellListIntro.before, descriptions);
  if (f.spellListIntro?.after !== undefined) setDescription(form, "spell-list-post-description", f.spellListIntro.after, descriptions);
  return { asked, descriptions, touched: asked.size > 0 || descriptions.size > 0 };
}

/**
 * Descriptions compare tolerantly: six single-line fields come back without their leading <p> /
 * trailing </p> (live), and the server may re-space markup. Strip those two tags and collapse whitespace.
 */
export function sameHtml(a: string, b: string): boolean {
  // The single-line fields strip a leading <p> and a trailing </p> independently, even when the value
  // holds several blocks: live, "<p>A</p><p>B</p><ul>…</ul>" is stored as "A</p><p>B</p><ul>…</ul>".
  // That renders the same, so the comparison models the rule instead of calling it a mismatch.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^<p>/i, "").replace(/<\/p>$/i, "").trim();
  return norm(a) === norm(b);
}

function verifyDescriptions(descriptions: Map<string, string>, edit: ParsedForm): string[] {
  const out: string[] = [];
  for (const [id, want] of descriptions) {
    const got = edit.controls.find((c) => c.id === id)?.values[0] ?? "";
    if (!sameHtml(want, got)) out.push(`${id}: asked ${JSON.stringify(want.slice(0, 80))}, DDB has ${JSON.stringify(got.slice(0, 80))}`);
  }
  return out;
}

// --- up-front validation (the server accepts empties and stores them) ---

export function validateBackgroundFields(f: HomebrewBackgroundFields): void {
  const bad: string[] = [];
  if (f.name !== undefined && (f.name.length < 2 || f.name.length > 128)) bad.push("name must be 2..128 characters");
  for (const k of ["skills", "tools", "languages"] as const) {
    const v = f[k];
    if (v !== undefined && v !== null && v.length === 0) bad.push(`${k}: an empty pool would be stored as an empty row — pass at least one choice, or null to remove the pool`);
  }
  if (f.grantedFeat) {
    if (f.grantedFeat.name.length < 2 || f.grantedFeat.name.length > 50) bad.push("grantedFeat.name must be 2..50 characters");
    if (f.grantedFeat.feats.length === 0) bad.push("grantedFeat.feats: an empty granted feat would be stored — pass at least one feat, or grantedFeat: null to remove it");
  }
  for (const e of f.equipment ?? []) if (e.length < 2 || e.length > 2048) bad.push(`equipment "${e.slice(0, 20)}": names are 2..2048 characters`);
  for (const c of f.characteristics ?? []) {
    if (!CHARACTERISTIC_TYPES.includes(c.type)) bad.push(`characteristic type "${c.type}": use ${CHARACTERISTIC_TYPES.join(", ")}`);
    if (c.text.length < 2 || c.text.length > 256) bad.push(`characteristic "${c.text.slice(0, 20)}": text is 2..256 characters`);
  }
  for (const [k] of TITLED) {
    const t = f[k] as TitledText | undefined;
    if (t && k === "feature" && t.name.length > 256) bad.push("feature.name max 256 characters");
    if (t && k !== "feature" && t.name.length > 128) bad.push(`${k}.name max 128 characters`);
  }
  if (bad.length) throw new DdbWriteError(`ddb-homebrew background: invalid fields — ${bad.join("; ")}`, 400, bad);
}

// --- reading the edit page's sections ---

export type SectionKey = "skills" | "tools" | "languages" | "equipment" | "attribute" | "characteristics" | "contacts" | "granted-feat";
export interface SectionRow { label: string; editHref: string | null; deleteHref: string | null }
export interface Section { count: number | null; rows: SectionRow[] }

const SECTION_KEYS: SectionKey[] = ["skills", "tools", "languages", "equipment", "attribute", "characteristics", "contacts", "granted-feat"];

/** Rows (label + the site's own edit/delete hrefs) and "(n)" header counts of each sub-entry section. */
export function parseSections(html: string): Record<SectionKey, Section> {
  const root = parse(html, { blockTextElements: { script: false, style: false, textarea: true } });
  const out = {} as Record<SectionKey, Section>;
  for (const key of SECTION_KEYS) {
    const el = root.querySelector(`.ddb-homebrew-create-special-${key}`);
    if (!el) { out[key] = { count: null, rows: [] }; continue; }
    const head = el.querySelector(".ddb-homebrew-create-header-primary-text")?.text.replace(/\s+/g, " ").trim() ?? "";
    const count = head.match(/\((\d+)\)/);
    const rows = el.querySelectorAll("tbody tr").map((tr: HTMLElement): SectionRow => {
      const tds = tr.querySelectorAll("td");
      const cells = tds.slice(0, -1).map((td) => td.text.replace(/\s+/g, " ").trim());
      // Characteristic-style tables lead with a "d1" index column; the text is the next cell.
      const label = cells.length > 1 ? cells[1] : (cells[0] ?? "");
      const href = (suffix: string) => tr.querySelectorAll("a").map((a) => a.getAttribute("href") ?? "").find((h) => h.endsWith(suffix)) ?? null;
      return { label, editHref: href("/edit"), deleteHref: href("/delete") };
    });
    out[key] = { count: count ? Number(count[1]) : null, rows };
  }
  return out;
}

const EDIT_LOCATION = /\/homebrew\/creations\/create-background\/((\d+)-[^/?#]+)\/edit/;

/** The current edit path of a background. The slug follows renames and a stale slug 404s, so ask the site. */
async function editPathFor(s: SiteSession, id: number): Promise<string> {
  const path = await resolveEditPath(s, BACKGROUND_ENTITY_TYPE_ID, id);
  const m = path.match(EDIT_LOCATION);
  if (!m || Number(m[2]) !== id) throw new DdbWriteError(`ddb-homebrew background ${id}: unexpected edit path ${path}`, 500, path);
  return `/homebrew/creations/create-background/${m[1]}/edit`;
}

const slugOf = (editPath: string) => editPath.match(/create-background\/(\d+-[^/]+)\/edit/)![1];

// --- sub-entries ---

type PoolKind = "skills" | "tools" | "languages";
const POOL_VARIANT: Record<PoolKind, number> = { skills: 1, tools: 2, languages: 3 };
const POOL_SELECT = "field-spell-modifier-default-sub-types";

/** What a fill resolved to, for verification: option ids (not labels — tool/language labels repeat). */
interface Resolved {
  pools: Partial<Record<PoolKind, string[][]>>;   // per kind: the option ids of each modifier row
  grantedFeat?: { name: string; feats: string[] } | null;
  equipment?: string[];
  characteristics?: Array<{ type: string; text: string }>;
}

function pick(form: ParsedForm, id: string, picks: OptionPick[], what: string): string[] {
  setControl(form, id, picks.map((p) => (typeof p === "string" ? p : { value: p.value })));
  const values = [...controlById(form, id).values];
  if (new Set(values).size !== values.length) throw new DdbWriteError(`ddb-homebrew background: ${what} lists the same option twice`, 400, values);
  return values;
}

const GRANTS_KEY = { skills: "skillGrants", tools: "toolGrants", languages: "languageGrants" } as const;

/**
 * The modifier rows a kind should hold: the "choose from" pool (one row), then one single-option row per
 * fixed grant. undefined = the caller touched neither field, so that kind's rows are left alone.
 */
export function proficiencyRows(f: HomebrewBackgroundFields, kind: PoolKind): OptionPick[][] | undefined {
  const pool = f[kind];
  const grants = f[GRANTS_KEY[kind]];
  if (pool === undefined && grants === undefined) return undefined;
  return [...(pool ? [pool] : []), ...(grants ?? []).map((g) => [g])];
}

const poolPath = (id: number, kind: PoolKind) => `/modifier/create/${id}-${BACKGROUND_ENTITY_TYPE_ID}/${POOL_VARIANT[kind]}`;
const grantedFeatPath = (editPath: string) => `/backgrounds/${slugOf(editPath)}/granted-feat/create`;
const characteristicPath = (editPath: string) => `/backgrounds/${slugOf(editPath)}/characteristic/create`;
const equipmentPath = (id: number) => `/entity/starting-equipment-slot/create/${id}-${BACKGROUND_ENTITY_TYPE_ID}`;

/** Resolve every label to its option id against the live sub-forms WITHOUT posting anything. */
async function resolveSubs(s: SiteSession, id: number, editPath: string, f: HomebrewBackgroundFields): Promise<Resolved> {
  const r: Resolved = { pools: {} };
  for (const kind of ["skills", "tools", "languages"] as const) {
    const rows = proficiencyRows(f, kind);
    if (!rows) continue;
    const resolved: string[][] = [];
    for (const picks of rows) {
      const form = await loadForm(s, poolPath(id, kind), /\/modifier\/create\//);
      resolved.push(pick(form, POOL_SELECT, picks, kind));
    }
    const all = resolved.flat();
    if (new Set(all).size !== all.length) throw new DdbWriteError(`ddb-homebrew background: ${kind} lists the same option twice across its pool and grants`, 400, all);
    r.pools[kind] = resolved;
  }
  if (f.grantedFeat) {
    const form = await loadForm(s, grantedFeatPath(editPath), /granted-feat\/create$/);
    r.grantedFeat = { name: f.grantedFeat.name, feats: pick(form, "field-feat", f.grantedFeat.feats, "grantedFeat.feats") };
  } else if (f.grantedFeat === null) r.grantedFeat = null;
  if (f.equipment) r.equipment = [...f.equipment];
  if (f.characteristics) {
    r.characteristics = [];
    if (f.characteristics.length) {
      const form = await loadForm(s, characteristicPath(editPath), /characteristic\/create$/);
      for (const c of f.characteristics) {
        setControl(form, "field-type", c.type);
        r.characteristics.push({ type: controlById(form, "field-type").values[0], text: c.text });
      }
    }
  }
  return r;
}

async function addSubs(s: SiteSession, id: number, editPath: string, f: HomebrewBackgroundFields): Promise<void> {
  for (const kind of ["skills", "tools", "languages"] as const) {
    for (const picks of proficiencyRows(f, kind) ?? []) {
      const form = await loadForm(s, poolPath(id, kind), /\/modifier\/create\//);
      pick(form, POOL_SELECT, picks, kind);
      await submit(s, form, `add ${kind} ${picks.length === 1 ? "grant" : "pool"} to background ${id}`);
    }
  }
  if (f.grantedFeat) {
    const form = await loadForm(s, grantedFeatPath(editPath), /granted-feat\/create$/);
    setControl(form, "field-name", f.grantedFeat.name);
    pick(form, "field-feat", f.grantedFeat.feats, "grantedFeat.feats");
    await submit(s, form, `add granted feat to background ${id}`);
  }
  for (const name of f.equipment ?? []) {
    const form = await loadForm(s, equipmentPath(id), /starting-equipment-slot\/create\//);
    setControl(form, "field-name", name);
    await submit(s, form, `add equipment to background ${id}`);
  }
  for (const c of f.characteristics ?? []) {
    const form = await loadForm(s, characteristicPath(editPath), /characteristic\/create$/);
    setControl(form, "field-type", c.type);
    setControl(form, "field-name", c.text);
    await submit(s, form, `add characteristic to background ${id}`);
  }
}

/** Remove what the edit page lists for each provided kind, using its delete hrefs verbatim. */
async function removeSubs(s: SiteSession, id: number, editHtml: string, f: HomebrewBackgroundFields): Promise<void> {
  const sections = parseSections(editHtml);
  const kinds: Array<[SectionKey, boolean]> = [
    ["skills", proficiencyRows(f, "skills") !== undefined], ["tools", proficiencyRows(f, "tools") !== undefined], ["languages", proficiencyRows(f, "languages") !== undefined],
    ["granted-feat", f.grantedFeat !== undefined], ["equipment", f.equipment !== undefined], ["characteristics", f.characteristics !== undefined],
  ];
  for (const [key, on] of kinds) {
    if (!on) continue;
    for (const row of sections[key].rows) {
      if (!row.deleteHref) throw new DdbWriteError(`ddb-homebrew background ${id}: ${key} row "${row.label}" has no delete link on the edit page`, 500, row);
      await ajaxPost(s, row.deleteHref.replace(/&amp;/g, "&"), `remove ${key} "${row.label}" from background ${id}`);
    }
  }
}

// --- read-back verification ---

export interface BackgroundReadBack {
  name: string;
  counts: { skills: number; tools: number; languages: number; equipment: number; characteristics: number; grantedFeats: number };
  pools: Record<PoolKind, string[]>;
  grantedFeats: string[];
}

const sortJson = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
const same = (a: unknown[], b: unknown[]) => JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
const poolNames = (label: string) => label.replace(/^.*? - Choose an? [A-Za-z]+ - /, "").split(",").map((x) => x.trim()).filter(Boolean);

async function readBack(s: SiteSession, editPath: string, asked: Asked, descriptions: Map<string, string>, f: HomebrewBackgroundFields, want: Resolved): Promise<{ value: BackgroundReadBack; mismatches: string[] }> {
  const html = await getPage(s, editPath);
  const edit = parseForm(html, /\/edit$/);
  const sec = parseSections(html);
  const mismatches = [...verifyEditForm(asked, edit), ...verifyDescriptions(descriptions, edit)];
  const sub = async (href: string | null, re: RegExp): Promise<ParsedForm | null> => href ? parseForm(await getPage(s, href.replace(/&amp;/g, "&")), re) : null;

  const pools = { skills: [], tools: [], languages: [] } as Record<PoolKind, string[]>;
  for (const kind of ["skills", "tools", "languages"] as const) {
    pools[kind] = sec[kind].rows.flatMap((r) => poolNames(r.label));
    const expected = want.pools[kind];
    if (!expected) continue;
    const rows = sec[kind].rows;
    if (rows.length !== expected.length || (sec[kind].count ?? rows.length) !== expected.length) {
      mismatches.push(`${kind}: asked ${expected.length} row(s), DDB lists ${rows.length} (header says ${sec[kind].count})`);
      continue;
    }
    const got: string[][] = [];
    for (const row of rows) got.push((await sub(row.editHref, /\/edit$/))?.controls.find((c) => c.id === POOL_SELECT)?.values ?? []);
    if (!same(expected.map((r) => [...r].sort()), got.map((r) => [...r].sort()))) {
      mismatches.push(`${kind}: asked option ids ${JSON.stringify(expected)}, DDB's rows hold ${JSON.stringify(got)} (${rows.map((r) => `"${r.label}"`).join(", ")})`);
    }
  }
  if (f.equipment !== undefined) {
    const got = sec.equipment.rows.map((r) => r.label);
    if (!same(want.equipment ?? [], got) || (sec.equipment.count ?? got.length) !== got.length) mismatches.push(`equipment: asked ${JSON.stringify(want.equipment)}, DDB lists ${JSON.stringify(got)} (header ${sec.equipment.count})`);
  }
  if (f.characteristics !== undefined) {
    const rows = sec.characteristics.rows;
    const got: Array<{ type: string; text: string }> = [];
    for (const r of rows) {
      const form = await sub(r.editHref, /\/edit$/);
      got.push({ type: form?.controls.find((c) => c.id === "field-type")?.values[0] ?? "?", text: form?.controls.find((c) => c.id === "field-name")?.values[0] ?? r.label });
    }
    if (!same(want.characteristics ?? [], got) || (sec.characteristics.count ?? rows.length) !== rows.length) {
      mismatches.push(`characteristics: asked ${JSON.stringify(want.characteristics)}, DDB lists ${JSON.stringify(got)} (header ${sec.characteristics.count})`);
    }
  }
  const grantedFeats = sec["granted-feat"].rows.map((r) => r.label);
  if (f.grantedFeat !== undefined) {
    const rows = sec["granted-feat"].rows;
    const expectRows = want.grantedFeat ? 1 : 0;
    if (rows.length !== expectRows) mismatches.push(`grantedFeat: asked ${expectRows} row(s), DDB lists ${rows.length}`);
    else if (want.grantedFeat) {
      const form = await sub(rows[0].editHref, /\/edit$/);
      const gotName = form?.controls.find((c) => c.id === "field-name")?.values[0] ?? "";
      const gotFeats = form?.controls.find((c) => c.id === "field-feat")?.values ?? [];
      if (gotName !== want.grantedFeat.name || !same(want.grantedFeat.feats, gotFeats)) {
        mismatches.push(`grantedFeat: asked ${JSON.stringify(want.grantedFeat)}, DDB has ${JSON.stringify({ name: gotName, feats: gotFeats })}`);
      }
    }
  }
  return {
    value: {
      name: edit.controls.find((c) => c.id === "field-name")?.values[0] ?? "",
      counts: { skills: sec.skills.rows.length, tools: sec.tools.rows.length, languages: sec.languages.rows.length, equipment: sec.equipment.rows.length, characteristics: sec.characteristics.rows.length, grantedFeats: grantedFeats.length },
      pools, grantedFeats,
    },
    mismatches,
  };
}

async function verifyOrThrow(s: SiteSession, id: number, editPath: string, asked: Asked, descriptions: Map<string, string>, f: HomebrewBackgroundFields, want: Resolved): Promise<BackgroundReadBack> {
  const { value, mismatches } = await settle(() => readBack(s, editPath, asked, descriptions, f, want), settleDelays);
  if (mismatches.length) {
    throw new DdbWriteError(`ddb-homebrew: background ${id} was written but the read-back differs — ${mismatches.join("; ")}`, 200, mismatches);
  }
  return value;
}

// --- the primitives ---

export interface HomebrewBackgroundResult { id: number; editUrl: string; readBack: BackgroundReadBack }

export async function createHomebrewBackground(f: HomebrewBackgroundFields): Promise<HomebrewBackgroundResult> {
  validateBackgroundFields(f);
  const s = rtSiteSession();
  const form = await loadForm(s, "/homebrew/creations/create-background/create", /\/create-background\/create$/);
  const { asked, descriptions } = fillBackgroundForm(form, f);
  const location = await submit(s, form, "create background");
  const m = location.match(EDIT_LOCATION);
  if (!m) throw new DdbWriteError(`ddb-homebrew create background: unexpected redirect ${location}`, 303, location);
  const id = Number(m[2]);
  const editPath = `/homebrew/creations/create-background/${m[1]}/edit`;
  // The background exists from here on; a later failure must name it so the caller can fix or delete it.
  try {
    const want = await resolveSubs(s, id, editPath, f);
    await addSubs(s, id, editPath, f);
    const readBack = await verifyOrThrow(s, id, editPath, asked, descriptions, f, want);
    return { id, editUrl: `https://www.dndbeyond.com${editPath}`, readBack };
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: background ${id} was created (${m[1]}), then: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

export async function updateHomebrewBackground(id: number, f: HomebrewBackgroundFields): Promise<HomebrewBackgroundResult> {
  validateBackgroundFields(f);
  const s = rtSiteSession();
  let editPath = await editPathFor(s, id);
  // Resolve every label first: an ambiguous or unknown choice must fail before anything is deleted.
  const want = await resolveSubs(s, id, editPath, f);
  const editHtml = await getPage(s, editPath);
  const form = parseForm(editHtml, /\/edit$/);
  const { asked, descriptions, touched } = fillBackgroundForm(form, f);
  if (touched) {
    const location = await submit(s, form, `update background ${id}`);
    const m = location.match(EDIT_LOCATION);
    if (!m) throw new DdbWriteError(`ddb-homebrew update background ${id}: unexpected redirect ${location}`, 303, location);
    editPath = `/homebrew/creations/create-background/${m[1]}/edit`;
  }
  try {
    await removeSubs(s, id, touched ? await getPage(s, editPath) : editHtml, f); // fresh page: delete hrefs embed the CURRENT slug
    await addSubs(s, id, editPath, f);
    const readBack = await verifyOrThrow(s, id, editPath, asked, descriptions, f, want);
    return { id, editUrl: `https://www.dndbeyond.com${editPath}`, readBack };
  } catch (err) {
    const e = err instanceof DdbWriteError ? err : null;
    throw new DdbWriteError(`ddb-homebrew: background ${id} update failed part-way: ${(err as Error).message}`, e?.status ?? 500, e?.detail ?? null);
  }
}

/** Delete a homebrew background (soft delete on DDB's side); confirmed by a repeat delete answering 404. */
export async function deleteHomebrewBackground(id: number): Promise<{ id: number; deleted: true }> {
  const s = rtSiteSession();
  return deleteCreation(s, BACKGROUND_ENTITY_TYPE_ID, id, await editPathFor(s, id));
}
