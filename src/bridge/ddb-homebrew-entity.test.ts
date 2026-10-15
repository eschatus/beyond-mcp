import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session: routes by "METHOD path".
const { site } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string };
  const site = {
    routes: new Map<string, Reply | ((body: FormData | URLSearchParams | undefined) => Reply)>(),
    calls: [] as Array<{ method: string; path: string; body?: FormData | URLSearchParams }>,
  };
  return { site };
});

vi.mock("./ddb-rt.js", () => ({
  rtRawFetch: vi.fn(),
  rtSiteSession: () => mockSession,
}));
const mockSession = {
  cookie: () => "tok",
  async fetch(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}) {
    const method = init.method ?? "GET";
    site.calls.push({ method, path, body: init.body });
    const route = site.routes.get(`${method} ${path}`);
    if (!route) return new Response("not found", { status: 404 });
    const r = typeof route === "function" ? route(init.body) : route;
    return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
  },
};

import { parseForm, controlById } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  ENTITY_OWNER_TYPE_IDS, validateLimitedUse, validateEntitySpell, fillLimitedUseForm, fillUsesScaleForm, fillEntitySpellForm,
  resolveSpellOption, listLimitedUses, listEntitySpells, listUsesScales, entityDeleteLinks,
  parseLimitedUseEdit, parseUsesScaleEdit, parseEntitySpellEdit, entityFormMismatches,
  addLimitedUse, addEntitySpell, verifyLimitedUse, verifyEntitySpell, setSettleDelaysForTests,
  type HomebrewLimitedUse,
} from "./ddb-homebrew-entity.js";
import * as FX from "./ddb-homebrew-entity.fixtures.js";

const LU_RE = /limited-use\/create/;
const SPELL_RE = /spell\/create/;
const luForm = (ownerTypeId = ENTITY_OWNER_TYPE_IDS.feat) => parseForm(FX.luCreate.replace(/create\/\d+-\d+/, `create/9-${ownerTypeId}`), LU_RE);
const val = (f: ReturnType<typeof luForm>, id: string) => controlById(f, id).values;
const throwsEntity = (fn: () => unknown, re: RegExp) => {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(DdbWriteError);
  expect((err as Error).message).toMatch(re);
};

describe("limited-use form fill (live control ids and option values)", () => {
  it("fills Feint: General, Reaction, Long Rest, description trio", () => {
    const f = luForm();
    const { asked } = fillLimitedUseForm(f, {
      name: "Feint", actionType: "General", snippet: "Fall prone.", description: "<p>As a Reaction…</p>", activation: "Reaction", reset: "Long Rest",
    });
    expect(val(f, "field-action-type")).toEqual(["3"]);            // General = 3, Weapon = 1, Spell = 2
    expect(val(f, "field-activation")).toEqual(["4"]);
    expect(val(f, "field-reset-type")).toEqual(["2"]);
    expect(val(f, "field-description-field-type")).toEqual(["1"]);
    expect(val(f, "field-description-field-wysiwyg")).toEqual(["<p>As a Reaction…</p>"]);
    expect(val(f, "field-description-field")).toEqual(["<p>As a Reaction…</p>"]);
    expect(asked.get("field-name-field")).toEqual(["Feint"]);
    expect(asked.has("field-damage-type")).toBe(false);
  });

  it("fills a ranged weapon action with damage, and applies the page script's Display-As-Attack default", () => {
    const f = luForm(ENTITY_OWNER_TYPE_IDS.classFeature);
    fillLimitedUseForm(f, {
      name: "Blur", actionType: "Weapon", attackRange: "Ranged", range: 30, longRange: 120, attackSubtype: "Natural",
      damage: { dice: { count: 2, die: 8 }, fixedValue: 3, type: "Radiant" }, onMiss: "none", level: 5,
    });
    expect(val(f, "field-attack-range")).toEqual(["2"]);
    expect(val(f, "field-dice-count")).toEqual(["2"]);
    expect(val(f, "field-die-type")).toEqual(["8"]);
    expect(val(f, "field-damage-type")).toEqual(["12"]);
    expect(val(f, "field-level")).toEqual(["5"]);
    expect(val(f, "field-display-as-attack")).toEqual(["t"]);
  });

  it("fills a spell action with save, AoE and a timed activation", () => {
    const f = luForm();
    fillLimitedUseForm(f, {
      name: "Cone", actionType: "Spell", abilityScore: "CON", spellRange: "Self", save: { ability: "CON", dc: 13, onSuccess: "half", onFail: "full" },
      areaOfEffect: { type: "Cone", size: 15, special: true }, activation: "Minute", activationTime: 10, reset: "Dawn",
    });
    expect(val(f, "field-spell-range-type")).toEqual(["1"]);
    expect(val(f, "field-ability-score-save-type")).toEqual(["3"]);
    expect(val(f, "field-area-of-effect-type")).toEqual(["1"]);
    expect(val(f, "field-aoe-special-description")).toEqual(["y"]);
    expect(val(f, "field-activation")).toEqual(["6"]);
    expect(val(f, "field-activation-time")).toEqual(["10"]);
    expect(val(f, "field-reset-type")).toEqual(["3"]);
  });

  it("takes { value } for an option and rejects an unknown label with the valid ones", () => {
    const f = luForm();
    fillLimitedUseForm(f, { name: "x", actionType: "General", activation: { value: "3" } });
    expect(val(f, "field-activation")).toEqual(["3"]);
    expect(() => fillLimitedUseForm(luForm(), { name: "x", actionType: "General", reset: "Weekly" })).toThrow(/not an option of #field-reset-type.*Short Rest/);
  });

  it("refuses bad requests before anything is posted", () => {
    const base: HomebrewLimitedUse = { name: "A", actionType: "General" };
    throwsEntity(() => validateLimitedUse({ ...base, name: " " }), /needs a name/);
    throwsEntity(() => validateLimitedUse({ ...base, actionType: "Weapon" }), /needs attackRange/);
    throwsEntity(() => validateLimitedUse({ ...base, actionType: "Weapon", attackRange: "Melee", range: 5, spellRange: "Self" }), /spellRange only applies to Spell/);
    throwsEntity(() => validateLimitedUse({ ...base, actionType: "Spell", spellRange: "Ranged" }), /Ranged spell action needs range/);
    throwsEntity(() => validateLimitedUse({ ...base, attackSubtype: "Natural" }), /attackSubtype only applies to Weapon/);
    throwsEntity(() => validateLimitedUse({ ...base, activation: "Reaction", activationTime: 5 }), /activationTime only applies/);
    throwsEntity(() => validateLimitedUse({ ...base, damage: { dice: { count: 0, die: 6 } } }), /dice.count/);
    throwsEntity(() => validateLimitedUse({ ...base, level: 21 }), /level must be an integer 1-20/);
    throwsEntity(() => validateLimitedUse({ ...base, uses: { proficiencyBonus: true } }), /uses need a reset/);
    throwsEntity(() => validateLimitedUse({ ...base, reset: "Long Rest", uses: { count: 0 } }), /grants 0 uses/);
    throwsEntity(() => validateLimitedUse({ ...base, reset: "Long Rest", uses: [{ count: 1 }, { count: 2 }] }), /two uses rows for the base/);
    throwsEntity(() => validateLimitedUse({ ...base, reset: "Long Rest", uses: [{ count: 1, level: 5 }, { count: 2, level: 5 }] }), /two uses rows for level 5/);
    throwsEntity(() => validateLimitedUse({ ...base, reset: "Long Rest", uses: { count: 1, abilityOperator: "multiply" } }), /abilityOperator needs abilityModifier/);
  });

  it("needs an Ability Score Type for an attack or save on feats/traits but not class features (live)", () => {
    const attack: HomebrewLimitedUse = { name: "A", actionType: "Weapon", attackRange: "Melee" };
    throwsEntity(() => fillLimitedUseForm(luForm(ENTITY_OWNER_TYPE_IDS.feat), attack), /needs abilityScore/);
    throwsEntity(() => fillLimitedUseForm(luForm(ENTITY_OWNER_TYPE_IDS.racialTrait), { name: "A", actionType: "General", save: { ability: "DEX" } }), /needs abilityScore/);
    expect(() => fillLimitedUseForm(luForm(ENTITY_OWNER_TYPE_IDS.classFeature), attack)).not.toThrow();
    expect(() => fillLimitedUseForm(luForm(ENTITY_OWNER_TYPE_IDS.feat), { ...attack, abilityScore: "STR" })).not.toThrow();
  });
});

describe("uses (level-scale) form fill", () => {
  const scaleForm = () => parseForm(FX.scaleCreate, /level-scale\/create/);

  it("proficiency bonus alone: count 0, PB checked, operators default to add", () => {
    const f = scaleForm();
    const asked = fillUsesScaleForm(f, { proficiencyBonus: true });
    expect(val(f, "field-number-of-uses")).toEqual(["0"]);
    expect(val(f, "field-use-proficiency-bonus")).toEqual(["y"]);
    expect(val(f, "field-operator")).toEqual(["1"]);
    expect(asked.get("field-use-proficiency-bonus")).toEqual(["y"]);
  });

  it("2 x CON-style: multiply operators use option values 2, level is set", () => {
    const f = scaleForm();
    fillUsesScaleForm(f, { count: 2, abilityModifier: "CON", abilityOperator: "multiply", proficiencyBonus: true, proficiencyBonusOperator: "multiply", level: 15 });
    expect(val(f, "field-number-of-uses")).toEqual(["2"]);
    expect(val(f, "field-stat-modifier")).toEqual(["3"]);
    expect(val(f, "field-operator")).toEqual(["2"]);
    expect(val(f, "field-proficiency-bonus-operator")).toEqual(["2"]);
    expect(val(f, "field-level")).toEqual(["15"]);
  });

  it("refuses a row that grants nothing", () => {
    throwsEntity(() => fillUsesScaleForm(scaleForm(), { count: 0 }), /grants 0 uses/);
  });
});

describe("entity spell form fill", () => {
  const featForm = () => parseForm(FX.spellCreateFeat, SPELL_RE);
  const cfForm = () => parseForm(FX.spellCreateCf, SPELL_RE);

  it("resolves a full label, a unique plain name and a case-insensitive name to spell ids", () => {
    const f = featForm();
    const { spells, asked } = fillEntitySpellForm(f, { spells: ["Alarm - [Level 1]", "acid splash", "Aid"], castingAbility: "INT" });
    expect(spells.map((s) => s.label)).toEqual(["Alarm - [Level 1]", "Acid Splash - [Cantrip]", "Aid - [Level 2]"]);
    expect(val(f, "field-spell").sort()).toEqual(["2618844", "2618845", "2619222"]);
    expect(val(f, "field-ability-score")).toEqual(["4"]);
    expect(asked.get("field-spell")).toEqual(["2619222", "2618844", "2618845"]);
  });

  it("keeps Legacy twins apart: the plain name picks the current spell, '(Legacy)' the old one", () => {
    const c = controlById(featForm(), "field-spell");
    const current = resolveSpellOption(c, "Alarm");
    const legacy = resolveSpellOption(c, "Alarm (Legacy)");
    expect(c.options.find((o) => o.value === current)!.label).toBe("Alarm - [Level 1]");
    expect(c.options.find((o) => o.value === legacy)!.label).toBe("Alarm (Legacy) - [Level 1]");
  });

  it("throws on an ambiguous plain name (listing ids), takes { value }, and explains a miss", () => {
    const c = controlById(featForm(), "field-spell");
    c.options.push({ value: "999", label: "Alarm - [Level 3]" }); // a homebrew spell sharing the name
    throwsEntity(() => resolveSpellOption(c, "Alarm"), /ambiguous.*2619222.*999/);
    expect(resolveSpellOption(c, { value: "999" })).toBe("999");
    expect(resolveSpellOption(c, "Alarm - [Level 3]")).toBe("999");
    throwsEntity(() => resolveSpellOption(c, { value: "123" }), /no spell with value "123"/);
    throwsEntity(() => resolveSpellOption(c, "Alar"), /not a spell on this form. Similar: Alarm/);
  });

  it("fills filters: levels (0 = Cantrip), class by { value} (labels repeat), school, ritual", () => {
    const f = featForm();
    fillEntitySpellForm(f, { levels: [0, 1], classes: [{ value: "2190886" }], schools: ["Evocation"], attackType: "Ranged", ritual: "Can Cast As Ritual", onlyRituals: false });
    expect(val(f, "field-spell-levels")).toEqual(["0", "1"]);
    expect(val(f, "field-spell-class")).toEqual(["2190886"]);
    expect(val(f, "field-spell-school")).toEqual(["7"]);
    expect(val(f, "field-attack-type")).toEqual(["2"]);
    expect(val(f, "field-ritual-cast-type")).toEqual(["1"]);
    expect(() => fillEntitySpellForm(featForm(), { classes: ["Wizard"] })).toThrow(/ambiguous on #field-spell-class/); // html-form's own error
  });

  it("fills uses, reset and cast-at-level", () => {
    const f = featForm();
    fillEntitySpellForm(f, { spells: ["Aid"], uses: { proficiencyBonus: true }, reset: "Long Rest", castAtLevel: 3, atWill: false });
    expect(val(f, "field-use-proficiency-bonus")).toEqual(["y"]);
    expect(val(f, "field-number-of-uses")).toEqual(["0"]);
    expect(val(f, "field-reset-type")).toEqual(["2"]);
    expect(val(f, "field-cast-at-level")).toEqual(["3"]);
    expect(val(f, "field-is-infinite")).toEqual([]);
  });

  it("class-feature/trait extras: always prepared Yes → t; a feat form lacks them and says so", () => {
    const f = cfForm();
    fillEntitySpellForm(f, { spells: ["Alarm"], alwaysPrepared: true, countsAsKnown: false, availableAtLevel: 3, restriction: "only at night", minCharges: 1, maxCharges: 2, saveDc: 14 });
    expect(val(f, "field-always-prepared")).toEqual(["t"]);
    expect(val(f, "field-counts-as-known-spell")).toEqual(["f"]);
    expect(val(f, "field-available-at-character-level")).toEqual(["3"]);
    expect(val(f, "field-restriction")).toEqual(["only at night"]);
    throwsEntity(() => fillEntitySpellForm(featForm(), { spells: ["Alarm"], alwaysPrepared: true }), /no control for alwaysPrepared \(#field-always-prepared\)/);
    throwsEntity(() => fillEntitySpellForm(featForm(), { spells: ["Alarm"], restriction: "x" }), /no control for restriction/);
  });

  it("refuses an empty grant and bad numbers before posting", () => {
    throwsEntity(() => validateEntitySpell({}), /needs spells and\/or a filter/);
    throwsEntity(() => validateEntitySpell({ spells: ["Alarm"], castAtLevel: 10 }), /castAtLevel/);
    throwsEntity(() => validateEntitySpell({ levels: [10] }), /0-9/);
    throwsEntity(() => fillEntitySpellForm(featForm(), { spells: ["Alarm", "Alarm - [Level 1]"] }), /listed twice/);
  });
});

describe("owner-page readers", () => {
  it("lists limited-use actions with ids, displayed fields and verbatim hrefs", () => {
    const rows = listLimitedUses(FX.luListing);
    expect(rows.map((r) => [r.id, r.name, r.activation, r.dice, r.reset])).toEqual([
      [12937736, "zz Feint", "Reaction", "", "Long Rest"],
      [12937737, "zz Dash Strike", "Bonus Action", "2d8", "Short Rest"],
      [12937738, "zz Cone", "10 Minutes", "3d6", "Dawn"],
    ]);
    expect(rows[0].editHref).toBe("/entity/limited-use/12937736/edit");
    expect(rows[0].deleteHref).toBe("/entity/limited-use/12937736/delete");
  });

  it("lists spell grants keyed by column header (incl. filter-only rows)", () => {
    const rows = listEntitySpells(FX.spellListingCf);
    expect(rows.map((r) => [r.id, r.spellsText])).toEqual([[10624761, "Acid Splash, Alarm"], [10624762, "Aid"], [10624763, ""]]);
    expect(rows[0].cells["Restriction"]).toBe("only at night");
    expect(rows[2].cells).toMatchObject({ Levels: "Cantrip, 1", Classes: "Wizard", School: "Evocation", "Attack Type": "Ranged" });
    expect(rows[1].deleteHref).toBe("/entity/spell/10624762/delete");
    expect(Object.keys(rows[0].cells)).not.toContain("Edit");
  });

  it("lists uses rows as the action page prints them", () => {
    const rows = listUsesScales(FX.scaleListing);
    expect(rows.map((r) => [r.id, r.level, r.uses])).toEqual([
      [6564889, "Base", "WIS Modifier"], [6564890, "7", "1"], [6564891, "11", "2"], [6564892, "15", "( 2 + CON Modifier ) x Proficiency Bonus"],
    ]);
  });

  it("extracts delete hrefs verbatim, deduplicated, per kind", () => {
    const page = `${FX.luListing}${FX.spellListingCf}<a href="/modifier/5/delete">x</a>`;
    expect(entityDeleteLinks(page, "limitedUse")).toEqual(["/entity/limited-use/12937736/delete", "/entity/limited-use/12937737/delete", "/entity/limited-use/12937738/delete"]);
    expect(entityDeleteLinks(page, "spell")).toEqual(["/entity/spell/10624761/delete", "/entity/spell/10624762/delete", "/entity/spell/10624763/delete"]);
    expect(entityDeleteLinks("<p>none</p>", "spell")).toEqual([]);
  });

  it("returns [] for a page with no listing (an owner with nothing yet)", () => {
    expect(listLimitedUses("<html></html>")).toEqual([]);
    expect(listEntitySpells("<html></html>")).toEqual([]);
    expect(listUsesScales("<html></html>")).toEqual([]);
  });
});

describe("sub-entry edit-form readers", () => {
  it("reads a limited-use action edit form back in the caller's vocabulary", () => {
    const r = parseLimitedUseEdit(FX.luEditWeapon);
    expect(r.id).toBe(12937737);
    expect(r.value).toMatchObject({
      name: "zz Dash Strike", actionType: "Weapon", attackRange: "Ranged", range: 30, longRange: 120, abilityScore: "DEX", proficient: true,
      activation: "Bonus Action", reset: "Short Rest", level: 3, onMiss: "no effect", damage: { dice: { count: 2, die: 8 }, type: "Radiant" },
    });
    expect(r.value.save).toBeUndefined();
    expect(r.value.areaOfEffect).toBeUndefined();
  });

  it("reads a uses row", () => {
    const r = parseUsesScaleEdit(FX.scaleEdit);
    expect(r.id).toBe(6564892);
    expect(r.value).toEqual({ count: 2, abilityModifier: "CON", abilityOperator: "add", proficiencyBonus: true, proficiencyBonusOperator: "multiply", level: 15 });
  });

  it("reads a spell grant (class-feature edit form)", () => {
    const r = parseEntitySpellEdit(FX.spellEditCf);
    expect(r.id).toBe(10624761);
    expect(r.spells.map((s) => s.label)).toEqual(["Acid Splash - [Cantrip]", "Alarm - [Level 1]"]);
    expect(r.value).toMatchObject({ castingAbility: "INT", alwaysPrepared: true, countsAsKnown: false, availableAtLevel: 3, restriction: "only at night", consumesWarlockSlot: false });
    const filters = parseEntitySpellEdit(FX.spellEditFilters);
    expect(filters.spells).toEqual([]);
    expect(filters.value).toMatchObject({ levels: [0, 1], schools: ["Evocation"], attackType: "Ranged", ritual: "Can Cast As Ritual" });
    expect(filters.value.classes).toEqual([{ value: "2190886" }]);
  });

  it("entityFormMismatches compares whitespace-insensitively and names the control", () => {
    const f = parseLimitedUseEdit(FX.luEditWeapon).form;
    expect(entityFormMismatches(new Map([["field-name-field", ["zz Dash Strike"]], ["field-description-field-wysiwyg", ["<p>Zip.</p>"]]]), f)).toEqual([]);
    expect(entityFormMismatches(new Map([["field-name-field", ["other"]]]), f)).toEqual([`field-name-field: asked ["other"], DDB has ["zz Dash Strike"]`]);
  });
});

// --- I/O against a scripted site ---

type Body = FormData | URLSearchParams | undefined;
const bodyOf = (b: Body) => b as URLSearchParams;
const OWNER = 77, T = ENTITY_OWNER_TYPE_IDS.racialTrait, OWNER_PATH = "/entity/species-trait/77/edit";

beforeEach(() => {
  site.routes.clear(); site.calls.length = 0;
  setSettleDelaysForTests([0, 0]);
});

describe("addLimitedUse / verifyLimitedUse", () => {
  // The scripted action page: edit form echoing what was posted, plus the uses listing.
  function scriptAction(id: number) {
    const state = { posted: new URLSearchParams(), scales: [] as URLSearchParams[] };
    site.routes.set(`GET /entity/limited-use/create/${OWNER}-${T}`, { status: 200, body: FX.luCreate.replace(/create\/\d+-\d+/, `create/${OWNER}-${T}`) });
    site.routes.set(`POST /entity/limited-use/create/${OWNER}-${T}`, (b) => { state.posted = bodyOf(b); return { status: 302, location: `/entity/limited-use/${id}/edit` }; });
    site.routes.set(`GET /entity/limited-use/${id}/level-scale/create`, { status: 200, body: FX.scaleCreate.replace(/create\/\d+/, "create/x").replace(/action="[^"]*"/, `action="/entity/limited-use/${id}/level-scale/create"`) });
    site.routes.set(`POST /entity/limited-use/${id}/level-scale/create`, (b) => { state.scales.push(bodyOf(b)); return { status: 302, location: `/entity/limited-use/${id}/edit` }; });
    return state;
  }

  it("creates the action, then one uses row per entry, and reports the id from the redirect", async () => {
    const st = scriptAction(123);
    const r = await addLimitedUse(mockSession as never, OWNER, T, {
      name: "Feint", actionType: "General", activation: "Reaction", reset: "Long Rest", uses: [{ proficiencyBonus: true }, { count: 2, level: 11 }],
    });
    expect(r.id).toBe(123);
    expect(r.editPath).toBe("/entity/limited-use/123/edit");
    expect(st.posted.get("name-field")).toBe("Feint");
    expect(st.posted.get("action-type")).toBe("3");
    expect(st.scales).toHaveLength(2);
    expect(st.scales[0].get("use-proficiency-bonus")).toBe("y");
    expect(st.scales[1].get("level")).toBe("11");
    expect(site.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /entity/limited-use/create/${OWNER}-${T}`, `POST /entity/limited-use/create/${OWNER}-${T}`,
      "GET /entity/limited-use/123/level-scale/create", "POST /entity/limited-use/123/level-scale/create",
      "GET /entity/limited-use/123/level-scale/create", "POST /entity/limited-use/123/level-scale/create",
    ]);
  });

  it("names the created action when a later step fails", async () => {
    scriptAction(123);
    site.routes.set("POST /entity/limited-use/123/level-scale/create", { status: 200, body: "<html>rejected</html>" });
    await expect(addLimitedUse(mockSession as never, OWNER, T, { name: "A", actionType: "General", reset: "Dawn", uses: { count: 1 } }))
      .rejects.toThrow(/limited-use action 123 \("A"\) was created, then:/);
  });

  it("surfaces a field error from the create POST (no redirect)", async () => {
    scriptAction(123);
    const errorForm = `<div class="ddb-homebrew-create-form-fields-item"><div class="ddb-homebrew-create-form-fields-item-label">Action Type</div><select id="field-action-type" name="action-type"></select><span class="field-errors">An Action Type must be selected.</span></div>`;
    site.routes.set(`POST /entity/limited-use/create/${OWNER}-${T}`, { status: 200, body: errorForm });
    await expect(addLimitedUse(mockSession as never, OWNER, T, { name: "A", actionType: "General" })).rejects.toThrow(/Action Type: An Action Type must be selected/);
  });

  it("does not post anything for an invalid request", async () => {
    await expect(addLimitedUse(mockSession as never, OWNER, T, { name: "A", actionType: "General", uses: { count: 1 } })).rejects.toThrow(/uses need a reset/);
    expect(site.calls).toHaveLength(0);
  });

  it("rejects an unexpected create redirect", async () => {
    scriptAction(123);
    site.routes.set(`POST /entity/limited-use/create/${OWNER}-${T}`, { status: 302, location: "/error" });
    await expect(addLimitedUse(mockSession as never, OWNER, T, { name: "A", actionType: "General" })).rejects.toThrow(/server error/);
    site.routes.set(`POST /entity/limited-use/create/${OWNER}-${T}`, { status: 302, location: "/somewhere" });
    await expect(addLimitedUse(mockSession as never, OWNER, T, { name: "A", actionType: "General" })).rejects.toThrow(/unexpected redirect \/somewhere/);
  });

  it("verifies against the action's edit form and its uses rows; reports a differing read-back", async () => {
    // The fixture action is "zz Dash Strike" with four uses rows (see the readers above).
    site.routes.set("GET /entity/limited-use/12937737/edit", { status: 200, body: FX.luEditWeapon + FX.scaleListing });
    const rows = listUsesScales(FX.scaleListing);
    // One scale page per row; the fixture only captured the last one, so serve it for all and expect a set mismatch.
    for (const r of rows) site.routes.set(`GET ${r.editHref}`, { status: 200, body: FX.scaleEdit });
    const added = { id: 12937737, editPath: "/entity/limited-use/12937737/edit", asked: new Map([["field-name-field", ["zz Dash Strike"]], ["field-reset-type", ["1"]]]), uses: [] };
    await expect(verifyLimitedUse(mockSession as never, added)).rejects.toThrow(/uses rows: asked 0, action lists 4/);
    const wrong = { ...added, asked: new Map([["field-reset-type", ["2"]]]), uses: [] };
    await expect(verifyLimitedUse(mockSession as never, wrong)).rejects.toThrow(/field-reset-type: asked \["2"\], DDB has \["1"\]/);
  });
});

describe("addEntitySpell / verifyEntitySpell", () => {
  const createBody = FX.spellCreateCf.replace(/create\/\d+-\d+/, `create/${OWNER}-${T}`) + `<a class="button button-cancel" href="${OWNER_PATH}#spells">Cancel</a>`;
  const ownerPage = (ids: number[]) => `<table class="listing listing-rpgentity-spell-mapping"><thead><tr><th>Spells</th><th>Edit</th></tr></thead><tbody>${ids.map((id) => `<tr><td>S${id}</td><td><a href="/entity/spell/${id}/edit">Edit</a> | <a href="/entity/spell/${id}/delete">Delete</a></td></tr>`).join("")}</tbody></table>`;

  function script(afterIds: number[][]) {
    let posted: URLSearchParams | undefined;
    let reads = 0;
    site.routes.set(`GET /entity/spell/create/${OWNER}-${T}`, { status: 200, body: createBody });
    site.routes.set(`GET ${OWNER_PATH}`, () => ({ status: 200, body: ownerPage(posted ? afterIds[Math.min(reads++, afterIds.length - 1)] : [10]) }));
    site.routes.set(`POST /entity/spell/create/${OWNER}-${T}`, (b) => { posted = bodyOf(b); return { status: 302, location: `${OWNER_PATH}#spells` }; });
    return () => posted;
  }

  it("posts one row for several spells and finds the new id by diffing the owner's listing", async () => {
    const posted = script([[10, 11]]);
    const r = await addEntitySpell(mockSession as never, OWNER, T, { spells: ["Alarm", "Acid Splash"], alwaysPrepared: true });
    expect(r.id).toBe(11);
    expect(r.editPath).toBe("/entity/spell/11/edit");
    expect(r.spells.map((s) => s.label)).toEqual(["Alarm - [Level 1]", "Acid Splash - [Cantrip]"]);
    expect(posted()!.getAll("spell")).toEqual(["2619222", "2618844"]);
    expect(posted()!.get("always-prepared")).toBe("t");
  });

  it("waits out a lagging listing, then fails loudly if no row ever appears", async () => {
    script([[10], [10], [10, 12]]);
    expect((await addEntitySpell(mockSession as never, OWNER, T, { spells: ["Aid"] })).id).toBe(12);
    site.routes.clear();
    script([[10]]);
    await expect(addEntitySpell(mockSession as never, OWNER, T, { spells: ["Aid"] })).rejects.toThrow(/0 new spell rows on the owner page \(expected 1\)/);
  });

  it("fails loudly when several rows appear (ambiguous id)", async () => {
    script([[10, 11, 12]]);
    await expect(addEntitySpell(mockSession as never, OWNER, T, { spells: ["Aid"] })).rejects.toThrow(/2 new spell rows/);
  });

  it("posts nothing for an empty grant", async () => {
    await expect(addEntitySpell(mockSession as never, OWNER, T, {})).rejects.toThrow(/needs spells and\/or a filter/);
    expect(site.calls).toHaveLength(0);
  });

  it("verifies the new row's edit form", async () => {
    site.routes.set("GET /entity/spell/10624761/edit", { status: 200, body: FX.spellEditCf });
    const ok = { id: 10624761, editPath: "/entity/spell/10624761/edit", asked: new Map([["field-always-prepared", ["t"]], ["field-ability-score", ["4"]]]), spells: [] };
    expect((await verifyEntitySpell(mockSession as never, ok)).value.alwaysPrepared).toBe(true);
    await expect(verifyEntitySpell(mockSession as never, { ...ok, asked: new Map([["field-always-prepared", ["f"]]]) })).rejects.toThrow(/field-always-prepared: asked \["f"\], DDB has \["t"\]/);
  });
});

describe("zod schemas (tools/homebrewEntitySchemas)", () => {
  it("parse caller input the bridge accepts, and reject what DDB cannot take", async () => {
    const { limitedUseSchema, entitySpellSchema } = await import("../tools/homebrewEntitySchemas.js");
    const lu = limitedUseSchema.parse({ name: "Feint", actionType: "General", activation: "Reaction", reset: "Long Rest", uses: { proficiencyBonus: true } });
    expect(() => validateLimitedUse(lu)).not.toThrow();
    expect(limitedUseSchema.parse({ name: "x", actionType: "Spell", spellRange: { value: "3" }, uses: [{ count: 1, level: 7 }] }).uses).toEqual([{ count: 1, level: 7 }]);
    expect(() => limitedUseSchema.parse({ name: "x", actionType: "Bonus" })).toThrow();
    expect(() => limitedUseSchema.parse({ name: "x", actionType: "General", damage: { dice: { count: 1, die: 7 } } })).toThrow();
    const sp = entitySpellSchema.parse({ spells: ["Alarm", { value: "2618844" }], alwaysPrepared: true, uses: { proficiencyBonus: true }, reset: "Long Rest" });
    expect(() => validateEntitySpell(sp)).not.toThrow();
    expect(() => entitySpellSchema.parse({ spells: ["Alarm"], castAtLevel: 12 })).toThrow();
  });
});
