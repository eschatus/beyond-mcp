import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session and character-service: routes by "METHOD path".
const { site, rtRawFetch } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string; setCookie?: string };
  const site = {
    routes: new Map<string, Reply | ((body: FormData | URLSearchParams | undefined) => Reply)>(),
    calls: [] as Array<{ method: string; path: string; body?: FormData | URLSearchParams }>,
    jar: new Map<string, string>(),
  };
  return { site, rtRawFetch: vi.fn() };
});

vi.mock("./ddb-rt.js", () => ({
  rtRawFetch,
  rtSiteSession: () => ({
    cookie: (n: string) => site.jar.get(n),
    async fetch(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}) {
      const method = init.method ?? "GET";
      site.calls.push({ method, path, body: init.body });
      const route = site.routes.get(`${method} ${path}`);
      if (!route) return new Response("not found", { status: 404 });
      const r = typeof route === "function" ? route(init.body) : route;
      if (r.setCookie) { const [k, v] = r.setCookie.split("="); site.jar.set(k, v); }
      return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
    },
  }),
}));

import { parseForm, controlById } from "./html-form.js";
import {
  fillFeatForm, validateFeatFields, deleteLinks, featMismatches,
  createHomebrewFeat, updateHomebrewFeat, deleteHomebrewFeat, setSettleDelaysForTests,
} from "./ddb-homebrew-feat.js";
import { DdbWriteError } from "./ddb-write.js";

// --- fixtures shaped like the live builder ---

const ID = 55;
const EDIT = `/homebrew/creations/create-feat/${ID}-axe/edit`;
const T = 1088085227;
const ABILITY_TYPE = 1;

interface FeatState {
  name: string; version: string; snippet: string; description: string; tags: string[];
  prereqs: Array<{ pid: number; description: string; mappings: Array<{ typeLabel: string; subName: string; value: number | null; exclude: boolean }> }>;
  mods: Array<{ mid: number; label: string }>;
}

const TAGS: Array<[string, string]> = [["1", "General"], ["2", "genral"], ["3", "Utility"]];
const CATALOGUE = [{ id: 1, name: "Strength", type: ABILITY_TYPE }, { id: 88, name: "Dexterity", type: ABILITY_TYPE }, { id: 7, name: "Wizard", type: 9 }, { id: 3, name: "Strength Score", type: 9 }, { id: 4, name: "Darkvision", type: 20 }];
const catalogueScript = `<script>var subTypes = [[${CATALOGUE.map((c) => JSON.stringify(c)).join(",")}]];</script>`;

const mainForm = (action: string, s?: FeatState) => `
<form id="feat-form" method="post" action="${action}">
<input id="field-security-token" name="security-token" type="hidden" value="t" />
<input id="field-name" name="name" type="text" value="${s?.name ?? ""}" />
<input id="field-version" name="version" type="text" value="${s?.version ?? ""}" />
<input id="field-item-description-type" name="item-description-type" type="hidden" value="1" />
<textarea id="field-item-description-wysiwyg" name="item-description-wysiwyg">${s?.description ?? ""}</textarea>
<textarea id="field-item-description" name="item-description">${s?.description ?? ""}</textarea>
<textarea id="field-snippet" name="snippet">${s?.snippet ?? ""}</textarea>
<select id="field-feat-tags-public" name="feat-tags-public" multiple>${TAGS.map(([v, l]) => `<option value="${v}"${s?.tags.includes(v) ? " selected" : ""}>${l}</option>`).join("")}</select>
<input id="field-options-known" name="options-known" type="hidden" value="1" />
</form>`;

const listings = (s: FeatState) => `
<table class="listing listing-rpgentity-prerequisite"><tbody>${s.prereqs.map((p) =>
  `<tr><td><div>${p.description}</div></td><td>${p.mappings.map((m) => `${m.typeLabel} - ${m.subName} : ${m.value}`).join(", ")}</td><td><a href="/entity/prerequisite/${p.pid}/edit">Edit</a> | <a href="/entity/prerequisite/${p.pid}/delete" class="modal-link">Delete</a></td></tr>`).join("")}</tbody></table>
<table class="listing listing-rpgentity-modifier"><tbody>${s.mods.map((m) =>
  `<tr><td>${m.label}</td><td></td><td><a href="/modifier/${m.mid}/0/edit">Edit</a> | <a href="/modifier/${m.mid}/delete" class="modal-link">Delete</a></td></tr>`).join("")}</tbody></table>
<a href="/feats/${ID}-axe/feat-option/9/delete">option</a>`;

const modifierForm = `<form method="post" action="/modifier/create/${ID}-${T}/0">
<select id="field-spell-modifier-type" name="type"><option value="">-</option><option value="9">Bonus</option><option value="20">Sense</option></select>
<select id="field-spell-modifier-sub-type" name="sub-type"></select>
<input id="field-fixed-value" name="fixed-value" type="text" value="" />
<select id="field-rpg-stat" name="rpg-stat"><option value="">-</option><option value="1">STR</option></select>
</form>${catalogueScript}`;

const prereqForm = (pid: number) => `<form method="post" action="/entity/prerequisite/${pid}/edit"><input id="field-description" name="description" value="x" /></form>
<form method="post" action="/entity/prerequisite-mapping/create/${pid}">
<select id="field-prereq-type" name="prereq-type"><option value="">-</option><option value="1">Ability Score</option><option value="9">Class</option></select>
<select id="field-prereq-sub-type" name="prereq-sub-type"></select>
<input id="field-value" name="value" type="text" value="" />
<input type="checkbox" id="field-create-should-exclude" name="create-should-exclude" value="y" />
</form>${catalogueScript}`;

/** Stateful fake of the feat builder routes, edit page, and game-data/feats. */
function fakeDdb(opts: { staleJsonReads?: number; corruptJson?: (f: any) => void } = {}) {
  const st: FeatState = { name: "", version: "", snippet: "", description: "", tags: [], prereqs: [], mods: [] };
  let created = false, nextId = 100, staleLeft = opts.staleJsonReads ?? 0;
  const old = { name: "old name" };
  const save = (body: unknown) => {
    const p = body as URLSearchParams;
    st.name = p.get("name") ?? ""; st.version = p.get("version") ?? "";
    st.snippet = p.get("snippet") ?? ""; st.description = p.get("item-description-wysiwyg") ?? "";
    st.tags = p.getAll("feat-tags-public");
  };
  site.routes.set("POST /refresh-request-verification-token", { status: 200, body: "{}", setCookie: "RequestVerificationToken=rvt" });
  // The generic edit redirect resolves the current slugged edit path (only for the account's own feat).
  site.routes.set(`GET /homebrew/creations/edit?entityTypeId=${T}&id=${ID}`, { status: 302, location: EDIT });
  site.routes.set("GET /homebrew/creations/create-feat/create", { status: 200, body: mainForm("/homebrew/creations/create-feat/create") });
  site.routes.set("POST /homebrew/creations/create-feat/create", (b) => { save(b); created = true; return { status: 302, location: EDIT }; });
  site.routes.set(`GET ${EDIT}`, () => ({ status: 200, body: mainForm(EDIT, st) + listings(st) }));
  site.routes.set(`POST ${EDIT}`, (b) => { save(b); return { status: 302, location: EDIT }; });
  site.routes.set(`GET /entity/prerequisite/create/${ID}-${T}`, { status: 200, body: `<form method="post" action="/entity/prerequisite/create/${ID}-${T}"><input id="field-description" name="description" value="" /></form>` });
  site.routes.set(`POST /entity/prerequisite/create/${ID}-${T}`, (b) => {
    const pid = nextId++;
    st.prereqs.push({ pid, description: (b as URLSearchParams).get("description")!, mappings: [] });
    site.routes.set(`GET /entity/prerequisite/${pid}/edit`, () => ({ status: 200, body: prereqForm(pid) }));
    site.routes.set(`POST /entity/prerequisite-mapping/create/${pid}`, (mb) => {
      const m = mb as URLSearchParams;
      const sub = CATALOGUE.find((c) => String(c.id) === m.get("prereq-sub-type") && String(c.type) === m.get("prereq-type"));
      if (!sub) return { status: 303, location: `/entity/prerequisite/${pid}/edit` };   // blank/mismatched mapping: silently ignored
      st.prereqs.find((p) => p.pid === pid)!.mappings.push({
        typeLabel: m.get("prereq-type") === "1" ? "Ability Score" : "Class", subName: sub.name,
        value: m.get("value") ? Number(m.get("value")) : null, exclude: m.get("create-should-exclude") === "y",
      });
      return { status: 303, location: `/entity/prerequisite/${pid}/edit` };
    });
    site.routes.set(`POST /entity/prerequisite/${pid}/delete`, () => { st.prereqs = st.prereqs.filter((p) => p.pid !== pid); return { status: 200, body: `{"RedirectUrl":"${EDIT}"}` }; });
    return { status: 303, location: `/entity/prerequisite/${pid}/edit` };
  });
  site.routes.set(`GET /modifier/create/${ID}-${T}/0`, { status: 200, body: modifierForm });
  site.routes.set(`POST /modifier/create/${ID}-${T}/0`, (b) => {
    const m = b as URLSearchParams;
    const mid = nextId++;
    const sub = CATALOGUE.find((c) => String(c.id) === m.get("sub-type"))!;
    st.mods.push({ mid, label: `${m.get("type") === "9" ? "Bonus" : "Sense"} - ${sub.name}` });
    site.routes.set(`POST /modifier/${mid}/delete`, () => { st.mods = st.mods.filter((x) => x.mid !== mid); return { status: 200, body: `{"RedirectUrl":"${EDIT}"}` }; });
    return { status: 302, location: `${EDIT}#modifiers` };
  });
  rtRawFetch.mockReset().mockImplementation(async () => {
    const feat: any = !created ? undefined : {
      id: ID, isHomebrew: true, slug: `${ID}-axe`, name: staleLeft > 0 ? old.name : st.name, description: st.description, snippet: st.snippet,
      prerequisites: st.prereqs.map((p) => ({
        description: p.description,
        prerequisiteMappings: p.mappings.map((m) => ({ friendlyTypeName: m.typeLabel, friendlySubTypeName: m.subName, value: m.value, shouldExclude: m.exclude })),
      })),
    };
    if (staleLeft > 0) staleLeft--;
    if (feat) opts.corruptJson?.(feat);
    return new Response(JSON.stringify({ data: feat ? [feat, { id: 1, name: "someone else" }] : [] }), { status: 200 });
  });
  return st;
}

const BASE = { name: "Axe Master", snippet: "Chop things", description: "<p>You chop.</p>", version: "1.0", tags: ["genral"] };

beforeEach(() => {
  site.routes.clear(); site.calls.length = 0; site.jar.clear();
  setSettleDelaysForTests([0, 0]);
});

describe("fillFeatForm", () => {
  it("resolves tags by exact label (case-variant duplicates), sends the description to both textareas, and asks only non-description controls", () => {
    const form = parseForm(mainForm("/homebrew/creations/create-feat/create"), /create$/);
    const asked = fillFeatForm(form, BASE);
    expect(controlById(form, "field-feat-tags-public").values).toEqual(["2"]);   // "genral", not "General"
    expect(controlById(form, "field-item-description").values).toEqual(["<p>You chop.</p>"]);
    expect(controlById(form, "field-item-description-wysiwyg").values).toEqual(["<p>You chop.</p>"]);
    expect(asked.get("field-version")).toEqual(["1.0"]);
    expect([...asked.keys()].some((k) => k.includes("description"))).toBe(false);
  });

  it("rejects an unknown tag with the valid labels", () => {
    const form = parseForm(mainForm("/x/create"), /create$/);
    expect(() => fillFeatForm(form, { tags: ["Nope"] })).toThrow(/not an option of #field-feat-tags-public.*General/);
  });
});

describe("validateFeatFields", () => {
  it("refuses a requirement without a subtype before anything is created", async () => {
    expect(() => validateFeatFields({ prerequisites: [{ description: "x", requirements: [{ type: "Ability Score", subType: " " }] }] })).toThrow(/needs a subType/);
    await expect(createHomebrewFeat({ ...BASE, prerequisites: [{ description: "x", requirements: [{ type: "Ability Score", subType: "" }] }] })).rejects.toThrow(/silently ignored/);
    expect(site.calls).toEqual([]);
  });
});

describe("deleteLinks", () => {
  it("takes the delete hrefs verbatim, per kind", () => {
    const html = `<a href="/entity/prerequisite/7/delete">x</a><a href="/modifier/8/delete">x</a><a href="/modifier/9/0/edit">e</a><a href="/feats/55-axe/feat-option/3/delete">o</a>`;
    expect(deleteLinks(html, "prerequisites")).toEqual(["/entity/prerequisite/7/delete"]);
    expect(deleteLinks(html, "modifiers")).toEqual(["/modifier/8/delete"]);
  });
});

describe("createHomebrewFeat", () => {
  it("creates and verifies against the edit form and game-data", async () => {
    const st = fakeDdb();
    const r = await createHomebrewFeat(BASE);
    expect(r).toMatchObject({ id: ID, editUrl: `https://www.dndbeyond.com${EDIT}` });
    expect(st.name).toBe("Axe Master");
    const post = String(site.calls.find((c) => c.method === "POST" && c.path.endsWith("/create"))!.body);
    expect(post).toContain("feat-tags-public=2");
    expect(post).toContain("item-description=%3Cp%3EYou+chop.%3C%2Fp%3E");
  });

  it("adds a prerequisite plus its mapping, and a modifier with a resolved subtype", async () => {
    const st = fakeDdb();
    const r = await createHomebrewFeat({
      ...BASE,
      prerequisites: [{ description: "Strength 13 or higher", requirements: [{ type: "Ability Score", subType: "Strength", value: 13 }] }],
      modifiers: [{ type: "Bonus", subType: "Strength Score", fixedValue: 1 }],
    });
    expect(r.raw.prerequisites).toHaveLength(1);
    expect(st.prereqs[0].mappings).toEqual([{ typeLabel: "Ability Score", subName: "Strength", value: 13, exclude: false }]);
    expect(st.mods.map((m) => m.label)).toEqual(["Bonus - Strength Score"]);
    const mapping = String(site.calls.find((c) => c.path.startsWith("/entity/prerequisite-mapping/create/") && c.method === "POST")!.body);
    expect(mapping).toBe("prereq-type=1&prereq-sub-type=1&value=13");
    const mod = String(site.calls.find((c) => c.path.startsWith("/modifier/create/") && c.method === "POST")!.body);
    expect(mod).toContain("type=9");
    expect(mod).toContain("sub-type=3");
    expect(mod).toContain("fixed-value=1");
  });

  it("rejects an unknown prerequisite subtype naming the created feat", async () => {
    fakeDdb();
    const err = await createHomebrewFeat({ ...BASE, prerequisites: [{ description: "x", requirements: [{ type: "Ability Score", subType: "Luck" }] }] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(new RegExp(`feat ${ID} was created`));
    expect(err.message).toMatch(/"Luck" is not a subtype of modifier type 1. Valid: Charisma|"Luck" is not a subtype/);
  });

  it("rejects a modifier subtype of the wrong type", async () => {
    fakeDdb();
    await expect(createHomebrewFeat({ ...BASE, modifiers: [{ type: "Bonus", subType: "Darkvision" }] })).rejects.toThrow(/"Darkvision" is not a subtype of modifier type 9/);
  });

  it("names the feat when game-data persistently disagrees", async () => {
    fakeDdb({ corruptJson: (f) => { f.snippet = "something else"; } });
    const err = await createHomebrewFeat(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(new RegExp(`feat ${ID} was created`));
    expect(err.message).toMatch(/snippet: asked "Chop things", game-data has "something else"/);
  });

  it("names the feat when a requirement is silently dropped by DDB", async () => {
    fakeDdb();
    // A mapping POST that DDB ignores (303, nothing created): only the read-back can tell.
    const real = site.routes.get(`POST /entity/prerequisite/create/${ID}-${T}`) as (b: any) => any;
    site.routes.set(`POST /entity/prerequisite/create/${ID}-${T}`, (b) => {
      const r = real(b);
      site.routes.set("POST /entity/prerequisite-mapping/create/100", { status: 303, location: "/entity/prerequisite/100/edit" });
      return r;
    });
    const err = await createHomebrewFeat({ ...BASE, prerequisites: [{ description: "S13", requirements: [{ type: "Ability Score", subType: "Strength", value: 13 }] }] }).catch((e) => e);
    expect(err.message).toMatch(new RegExp(`feat ${ID} was created`));
    expect(err.message).toMatch(/prerequisites: asked/);
  });

  it("rides out a stale first read-back (replica lag) instead of failing", async () => {
    fakeDdb({ staleJsonReads: 1 });
    await expect(createHomebrewFeat(BASE)).resolves.toMatchObject({ id: ID });
  });

  it("surfaces field errors from a rejected (200 re-rendered) form", async () => {
    fakeDdb();
    site.routes.set("POST /homebrew/creations/create-feat/create", {
      status: 200,
      body: `<div class="ddb-homebrew-create-form-fields-item"><div class="ddb-homebrew-create-form-fields-item-label">Feat Name</div><div><input id="field-name" name="name" /><span class="field-errors">Too short.</span></div></div>`,
    });
    await expect(createHomebrewFeat(BASE)).rejects.toThrow(/Feat Name: Too short/);
  });
});

describe("updateHomebrewFeat", () => {
  const seed = async () => {
    const st = fakeDdb();
    await createHomebrewFeat({
      ...BASE,
      prerequisites: [{ description: "Strength 13 or higher", requirements: [{ type: "Ability Score", subType: "Strength", value: 13 }] }],
      modifiers: [{ type: "Bonus", subType: "Strength Score", fixedValue: 1 }],
    });
    site.calls.length = 0;
    return st;
  };

  it("changes only the given fields", async () => {
    const st = await seed();
    await updateHomebrewFeat(ID, { snippet: "New snippet" });
    expect(st.snippet).toBe("New snippet");
    expect(st.name).toBe("Axe Master");
    expect(st.tags).toEqual(["2"]);                      // untouched controls re-posted as the page had them
    expect(st.prereqs).toHaveLength(1);
    expect(site.calls.some((c) => /\/delete$/.test(c.path))).toBe(false);
  });

  it("renames and REPLACES prerequisites and modifiers via the page's own delete hrefs", async () => {
    const st = await seed();
    const r = await updateHomebrewFeat(ID, {
      name: "Axe Grandmaster",
      prerequisites: [{ description: "Dexterity 13", requirements: [{ type: "Ability Score", subType: "Dexterity", value: 13, exclude: false }] }],
      modifiers: [{ type: "Sense", subType: "Darkvision", fixedValue: 60 }],
    });
    expect(r.raw.name).toBe("Axe Grandmaster");
    expect(site.calls.filter((c) => /\/delete$/.test(c.path)).map((c) => c.path)).toEqual(["/entity/prerequisite/100/delete", `/modifier/101/delete`]);
    expect(st.prereqs.map((p) => p.description)).toEqual(["Dexterity 13"]);
    expect(st.mods.map((m) => m.label)).toEqual(["Sense - Darkvision"]);
  });

  it("clears a kind with []", async () => {
    const st = await seed();
    await updateHomebrewFeat(ID, { prerequisites: [], modifiers: [] });
    expect(st.prereqs).toEqual([]);
    expect(st.mods).toEqual([]);
  });

  it("refuses a feat that is not the account's", async () => {
    fakeDdb();
    await expect(updateHomebrewFeat(999, { name: "Nope Nope" })).rejects.toThrow(/no edit page for creation 999/);
  });

  it("names the feat when a part-way failure happens", async () => {
    await seed();
    site.routes.set("POST /entity/prerequisite/100/delete", { status: 500 });
    await expect(updateHomebrewFeat(ID, { prerequisites: [] })).rejects.toThrow(new RegExp(`update of feat ${ID} failed part-way`));
  });
});

describe("featMismatches", () => {
  it("compares prerequisite mappings case-insensitively and flags a missing modifier row", () => {
    const form = parseForm(mainForm(EDIT), /edit$/);
    const feat = { name: "A", prerequisites: [{ description: "S13", prerequisiteMappings: [{ friendlyTypeName: "Ability Score", friendlySubTypeName: "Strength", value: 13, shouldExclude: false }] }] };
    const want = { asked: new Map(), json: {}, prerequisites: [{ description: "S13", mappings: [{ type: "ability score", subType: "strength", value: 13, exclude: false }] }], modifiers: ["Bonus - Strength Score"] };
    const out = featMismatches(want, form, `<table class="listing-rpgentity-prerequisite"><tbody><tr><td>S13</td></tr></tbody></table>`, feat);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/edit page modifiers/);
  });
});

describe("deleteHomebrewFeat", () => {
  it("confirms by a repeat delete answering 404", async () => {
    fakeDdb();
    await createHomebrewFeat(BASE);
    let deletes = 0;
    site.routes.set(`POST /homebrew/creations/delete?entityTypeId=${T}&id=${ID}`, () => (++deletes === 1 ? { status: 200, body: `{"RedirectUrl":"/my-creations"}` } : { status: 404 }));
    await expect(deleteHomebrewFeat(ID)).resolves.toEqual({ id: ID, deleted: true });
    expect(deletes).toBe(2);
  });

  it("fails loudly if a repeat delete still finds the feat", async () => {
    fakeDdb();
    await createHomebrewFeat(BASE);
    site.routes.set(`POST /homebrew/creations/delete?entityTypeId=${T}&id=${ID}`, { status: 200, body: `{"RedirectUrl":"/my-creations"}` });
    await expect(deleteHomebrewFeat(ID)).rejects.toThrow(/repeat delete answered 200/);
  });
});
