import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session: one handler answers every request and all are recorded.
const { site } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string; setCookie?: string };
  type Body = FormData | URLSearchParams | undefined;
  const site = {
    handler: (() => ({ status: 404 })) as (method: string, path: string, body: Body) => Reply,
    calls: [] as Array<{ method: string; path: string; body?: FormData | URLSearchParams }>,
    jar: new Map<string, string>(),
  };
  return { site };
});

vi.mock("./ddb-rt.js", () => ({
  rtSiteSession: () => ({
    cookie: (n: string) => site.jar.get(n),
    async fetch(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}) {
      const method = init.method ?? "GET";
      site.calls.push({ method, path, body: init.body });
      const r = site.handler(method, path, init.body);
      if (r.setCookie) { const [k, v] = r.setCookie.split("="); site.jar.set(k, v); }
      return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
    },
  }),
}));

import { parseForm, controlById } from "./html-form.js";
import {
  createHomebrewSubclass, updateHomebrewSubclass, deleteHomebrewSubclass, fillSubclassForm, fillFeatureForm, fillOptionForm, featureOptionIds,
  validateFeature, featureRows, featureChildren, subclassSlug, setSettleDelaysForTests,
  type HomebrewSubclassFeature,
} from "./ddb-homebrew-subclass.js";
import { DdbWriteError } from "./ddb-write.js";

// --- a stateful fake of the subclass builder, shaped like the live pages (trimmed) ---
// Subclass create/update answer 200 + the page; feature create answers 302; the page re-renders what
// was last saved, so a rename moves the slug and the old slug stops working for deletes.

const PARENT = "2190886-wizard";
const SUB_ID = 500;
const TYPE_LABELS: Record<string, string> = { "1": "Granted", "2": "Additional", "3": "Replacement" };
const MOD_TYPES: Record<string, string> = { "1": "Bonus", "5": "Resistance" };
const MOD_SUBS: Record<string, string> = { "134": "Fire", "1": "Armor Class" };
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const opts = (pairs: Array<[string, string]>, picked: string[], blank = true) =>
  (blank ? `<option value="">—</option>` : "") + pairs.map(([v, l]) => `<option value="${v}"${picked.includes(v) ? " selected" : ""}>${l}</option>`).join("");
const sel = (id: string, name: string, pairs: Array<[string, string]>, saved: FormData | undefined, multiple = false) =>
  `<select id="field-${id}" name="${name}"${multiple ? " multiple" : ""}>${opts(pairs, saved ? saved.getAll(name).map(String) : [])}</select>`;
const txt = (id: string, name: string, saved: FormData | undefined) => `<input type="text" id="field-${id}" name="${name}" value="${saved?.get(name) ?? ""}" />`;
const area = (id: string, name: string, saved: FormData | undefined) => `<textarea id="field-${id}" name="${name}">${(String(saved?.get(name) ?? "")).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>`;
const trio = (key: string, saved: FormData | undefined) =>
  `<input type="hidden" id="field-${key}-type" name="${key}-type" value="1" />${area(`${key}-wysiwyg`, `${key}-wysiwyg`, saved)}${area(key, key, saved)}`;
const box = (id: string, name: string, saved: FormData | undefined) => `<input type="checkbox" id="field-${id}" name="${name}" value="y"${saved?.get(name) === "y" ? " checked" : ""} />`;

const subclassForm = (action: string, saved?: FormData) => [
  `<form id="class-form" enctype="multipart/form-data" method="post" action="${action}">`,
  `<input type="hidden" id="field-security-token" name="security-token" value="t" />`,
  txt("name", "name", saved), txt("version", "version", saved),
  trio("subclass-short-description", saved), trio("subclass-description", saved),
  sel("spell-casting-ability", "spell-casting-ability", [["1", "STR"], ["4", "INT"], ["6", "CHA"]], saved),
  sel("can-cast-spells", "can-cast-spells", [["t", "Yes"], ["f", "No"]], saved),
  sel("additional-spell-list", "fba02f0ffdb1deda2f5b", [["2190876", "Bard"], ["2190877", "Cleric"], ["2190886", "Wizard"]], saved, true),
  sel("spell-prepare-type", "spell-prepare-type", [["2", "Half Level"], ["1", "Level"]], saved),
  sel("knows-all-spells", "knows-all-spells", [["t", "Yes"], ["f", "No"]], saved),
  sel("spell-learning-style", "spell-learning-style", [["2", "Learned"], ["1", "Prepared"]], saved),
  sel("spell-mapping", "spell-mapping", [["2619222", "Alarm"], ["2618844", "Acid Splash"]], saved, true),
  `<input type="file" id="field-avatar" name="f98c" /></form>`,
].join("\n");

interface Feat { id: number; saved: FormData; mods: string[]; scales: string[][] }

function fakeDdb(o: { staleEdits?: number; corrupt?: (fd: FormData) => void; createBody?: "no-id" | "errors"; failFeaturePost?: boolean } = {}) {
  const st = {
    saved: undefined as FormData | undefined,
    prev: undefined as FormData | undefined,
    stale: o.staleEdits ?? 0,
    features: [] as Feat[],
    nextFid: 9000,
    subclassPosts: 0,
    deleted: [] as number[],
    gone: false,
    deletes: 0,
  };
  const slug = () => `${SUB_ID}-${slugify(String(st.saved?.get("name") ?? "new"))}`;
  const editPath = `/classes/${PARENT}/subclass/${SUB_ID}/edit`;
  const table = () => st.features.length === 0 ? "" : `<table class="listing listing-rpgclass-feature"><tbody>${st.features.map((f) =>
    `<tr><td> ${f.saved.get("required-level")} </td><td> ${f.saved.get("display-order-field") ?? ""} </td><td> ${f.saved.get("name")} </td><td> ${TYPE_LABELS[String(f.saved.get("feature-type"))]} </td>` +
    `<td><a href="/classes/${slug()}/class-feature/${f.id}/edit">Edit</a> | <a href="/classes/${slug()}/class-feature/${f.id}/delete" class="modal-link">Delete</a></td></tr>`).join("")}</tbody></table>`;
  const subclassPage = (saved: FormData | undefined) =>
    `<html>${subclassForm(editPath, saved)}<a class="button" href="/classes/${slug()}/class-feature/create">Add a Class Feature</a>${table()}</html>`;
  const featForm = (action: string, saved?: FormData) => [
    `<form enctype="multipart/form-data" method="post" action="${action}">`,
    txt("name", "name", saved), area("snippet", "snippet", saved),
    trio("class-feature-description", saved), trio("multiclass-class-feature-description", saved),
    sel("required-level", "required-level", Array.from({ length: 20 }, (_, i) => [String(i + 1), String(i + 1)] as [string, string]), saved),
    txt("display-order-field", "display-order-field", saved),
    box("has-options", "has-options", saved), box("display-required-level", "display-required-level", saved),
    box("hide-in-builder", "hide-in-builder", saved), box("hide-in-sheet", "hide-in-sheet", saved),
    sel("feature-type", "feature-type", [["1", "Granted"], ["2", "Additional"], ["3", "Replacement"]], saved),
    `</form>`,
  ].join("\n");
  const featPage = (f: Feat) => `<html>${featForm(`/classes/${slug()}/class-feature/${f.id}/edit`, f.saved)}
    <table class="listing listing-rpgentity-modifier"><tbody>${f.mods.map((m) => `<tr><td> ${m} </td><td></td><td></td><td></td><td></td><td></td><td><a href="/modifier/1/delete">Delete</a></td></tr>`).join("")}</tbody></table>
    <table class="listing listing-rpgentity-level-scale"><tbody>${f.scales.map((r) => `<tr>${r.map((c) => `<td><div>${c}</div></td>`).join("")}<td><a>Edit</a></td></tr>`).join("")}</tbody></table></html>`;
  const modForm = (fid: number) => `<html><script>var subTypes = [[{"id":134,"name":"Fire","type":5},{"id":1,"name":"Armor Class","type":1}]];</script>
    <form method="post" action="/modifier/create/${fid}-12168134/0">
    <select id="field-spell-modifier-type" name="spell-modifier-type">${opts(Object.entries(MOD_TYPES), [])}</select>
    <select id="field-spell-modifier-sub-type" name="spell-modifier-sub-type"><option value="">—</option></select>
    <input type="text" id="field-fixed-value" name="fixed-value" value="" />
    <input type="checkbox" id="field-available-to-multiclass" name="available-to-multiclass" value="y" checked />
    </form></html>`;
  const scaleForm = (fid: number) => `<form method="post" action="/entity/levelscale/create/${fid}-12168134">
    <select id="field-level" name="level">${opts(Array.from({ length: 20 }, (_, i) => [String(i + 1), String(i + 1)] as [string, string]), [])}</select>
    <input type="text" id="field-dice-count" name="dice-count" value="" />
    <select id="field-dice-value" name="dice-value">${opts([["6", "d6"], ["8", "d8"]], [])}</select>
    <input type="text" id="field-fixed-value" name="fixed-value" value="" />
    <input type="text" id="field-description" name="description" value="" /></form>`;
  const save = (fd: FormData) => { st.prev = st.saved; st.saved = fd; st.stale = o.staleEdits ?? 0; o.corrupt?.(fd); };

  site.handler = (method, path, body) => {
    const fd = body as FormData;
    const feat = (fid: string) => st.features.find((f) => f.id === Number(fid));
    if (method === "GET" && path === "/homebrew/creations/create-subclass") {
      return { status: 200, body: `<form method="post" action="/homebrew/creations/create-subclass"><select id="field-class-type" name="class-type">${opts([["2190886", "Wizard"], ["2190877", "Cleric"]], [])}</select></form>` };
    }
    if (method === "POST" && path === "/homebrew/creations/create-subclass") {
      return (body as URLSearchParams).get("class-type") === "2190886" ? { status: 302, location: `/classes/${PARENT}/subclass/create` } : { status: 200, body: "rejected" };
    }
    if (method === "GET" && path === `/classes/${PARENT}/subclass/create`) return { status: 200, body: subclassForm(`/classes/${PARENT}/subclass/create`) };
    if (method === "POST" && path === `/classes/${PARENT}/subclass/create`) {
      st.subclassPosts++;
      if (o.createBody === "no-id") return { status: 200, body: "<html>Saved, probably</html>" };
      if (o.createBody === "errors") {
        return { status: 200, body: `<div class="ddb-homebrew-create-form-fields-item"><div class="ddb-homebrew-create-form-fields-item-label">Name</div><div><input id="field-name" name="name" /><span class="field-errors">Too long.</span></div></div>` };
      }
      save(fd);
      return { status: 200, body: subclassPage(st.saved) };
    }
    if (method === "GET" && path.startsWith("/homebrew/creations/edit?")) {
      return path.endsWith(`id=${SUB_ID}`) && !st.gone ? { status: 302, location: editPath } : { status: 404 };
    }
    if (method === "GET" && path === editPath) {
      if (st.gone) return { status: 404 };
      if (st.stale > 0) { st.stale--; return { status: 200, body: subclassPage(st.prev) }; }
      return { status: 200, body: subclassPage(st.saved) };
    }
    if (method === "POST" && path === editPath) { st.subclassPosts++; save(fd); return { status: 200, body: subclassPage(st.saved) }; }
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/classes\/([^/]+)\/class-feature\/create$/))) {
      if (m[1] !== slug()) return { status: 404 };
      if (method === "GET") return { status: 200, body: featForm(path) };
      if (o.failFeaturePost) return { status: 302, location: "/error" };
      const f: Feat = { id: st.nextFid++, saved: fd, mods: [], scales: [] };
      st.features.push(f);
      return { status: 302, location: `/classes/${slug()}/class-feature/${f.id}/edit` };
    }
    if ((m = path.match(/^\/classes\/([^/]+)\/class-feature\/(\d+)\/edit$/)) && method === "GET") {
      const f = feat(m[2]);
      return f ? { status: 200, body: featPage(f) } : { status: 404 };
    }
    if ((m = path.match(/^\/modifier\/create\/(\d+)-12168134\/0$/))) {
      if (method === "GET") return { status: 200, body: modForm(Number(m[1])) };
      const f = feat(m[1])!;
      f.mods.push(`${MOD_TYPES[String(fd.get("spell-modifier-type"))]} - ${MOD_SUBS[String(fd.get("spell-modifier-sub-type"))]}`);
      return { status: 302, location: "/x#modifiers" };
    }
    if ((m = path.match(/^\/entity\/levelscale\/create\/(\d+)-12168134$/))) {
      if (method === "GET") return { status: 200, body: scaleForm(Number(m[1])) };
      const f = feat(m[1])!;
      f.scales.push([String(fd.get("level")), fd.get("dice-value") ? `${fd.get("dice-count")}d${fd.get("dice-value")}` : "", String(fd.get("fixed-value")), String(fd.get("description"))]);
      return { status: 302, location: "/x#scales" };
    }
    if (method === "POST" && path === "/refresh-request-verification-token") return { status: 200, body: "{}", setCookie: "RequestVerificationToken=rvt" };
    if ((m = path.match(/^\/classes\/([^/]+)\/class-feature\/(\d+)\/delete$/)) && method === "POST") {
      if (m[1] !== slug() || !feat(m[2])) return { status: 404 };   // only the CURRENT slug works
      st.features = st.features.filter((f) => f.id !== Number(m![2]));
      st.deleted.push(Number(m[2]));
      return { status: 200, body: `{"RedirectUrl":"${editPath}"}` };
    }
    if (method === "POST" && path === `/homebrew/creations/delete?entityTypeId=789467139&id=${SUB_ID}`) {
      if (st.gone) return { status: 404 };
      st.gone = true; st.deletes++;
      return { status: 200, body: `{"RedirectUrl":"/my-creations"}` };
    }
    return { status: 404 };
  };
  return st;
}

const BASE = { className: "Wizard", name: "Order of Tests", shortDescription: "<p>Short</p>", description: "<p>Long description</p>" };
const FEAT_A: HomebrewSubclassFeature = {
  name: "Test Ward", description: "<p>You ward things.</p>", level: 3, displayOrder: 1, type: "Granted", snippet: "wards",
  modifiers: [{ type: "Resistance", subType: "Fire" }],
  levelScales: [{ level: 5, dice: { count: 2, die: 6 }, description: "scale" }],
};
const FEAT_B: HomebrewSubclassFeature = { name: "Test Surge", description: "<p>Surge of power.</p>", level: 6, type: "Additional" };

beforeEach(() => {
  site.calls.length = 0; site.jar.clear();
  setSettleDelaysForTests([0, 0, 0]);
});

describe("pure helpers", () => {
  it("fillSubclassForm addresses controls by id (hashed multi-select name), labels or option ids, and reports only non-description controls", () => {
    const form = parseForm(subclassForm("/x/subclass/create"), /subclass\/create$/);
    const asked = fillSubclassForm(form, {
      name: "N", shortDescription: "<p>s</p>", description: "<p>d</p>",
      spellcasting: { ability: "INT", canCastSpells: true, additionalSpellLists: ["Cleric", { value: "2190886" }], knowsAllSpells: false, prepareType: "Level", learningStyle: "Prepared", additionalSpells: ["Alarm"] },
    });
    expect(controlById(form, "field-subclass-description-wysiwyg").values).toEqual(["<p>d</p>"]);
    expect(controlById(form, "field-subclass-description").values).toEqual(["<p>d</p>"]);
    expect(asked.get("field-additional-spell-list")).toEqual(["2190877", "2190886"]);
    expect(asked.get("field-can-cast-spells")).toEqual(["t"]);
    expect(asked.get("field-knows-all-spells")).toEqual(["f"]);
    expect(asked.get("field-spell-casting-ability")).toEqual(["4"]);
    expect([...asked.keys()].some((k) => k.includes("description"))).toBe(false);
  });

  it("validateFeature rejects what the builder would reject, before anything is posted", () => {
    expect(() => validateFeature({ ...FEAT_B, description: "<p>ab</p>" })).toThrow(/at least 4 characters/);
    expect(() => validateFeature({ ...FEAT_B, level: 21 })).toThrow(/level must be an integer 1-20/);
    expect(() => validateFeature({ ...FEAT_B, name: " " })).toThrow(/name must be/);
    expect(() => validateFeature(FEAT_B)).not.toThrow();
  });

  it("fillFeatureForm sets the feature type and trio, leaving unset flags at the form's default", () => {
    const form = parseForm(`<form action="/classes/1-x/class-feature/create">${[
      txt("name", "name", undefined), area("snippet", "snippet", undefined), trio("class-feature-description", undefined),
      sel("required-level", "required-level", [["3", "3"]], undefined), sel("feature-type", "feature-type", [["1", "Granted"], ["2", "Additional"]], undefined),
      box("hide-in-sheet", "hide-in-sheet", undefined)].join("")}</form>`, /create$/);
    const asked = fillFeatureForm(form, { name: "F", description: "<p>body text</p>", level: 3, type: "Additional" });
    expect(asked.get("field-feature-type")).toEqual(["2"]);
    expect(asked.get("field-required-level")).toEqual(["3"]);
    expect(asked.has("field-hide-in-sheet")).toBe(false);
  });

  it("fillOptionForm sets the option trio, required level, dependent option (by label) and granted flag", () => {
    const form = parseForm(`<form action="/classes/1-x/class-feature/9/option/create">${[
      txt("name", "name", undefined), area("snippet", "snippet", undefined), trio("class-feature-option-description", undefined),
      trio("multiclass-class-feature-option-description", undefined), box("is-granted", "is-granted", undefined),
      sel("required-level", "required-level", [["3", "3"], ["6", "6"]], undefined),
      sel("dependent-class-feature-option", "dependent-class-feature-option", [["77", "Lineage - First House"]], undefined),
      txt("prerequisite-text", "prerequisite-text", undefined)].join("")}</form>`, /create$/);
    const asked = fillOptionForm(form, { name: "First House", description: "<p>body text</p>", requiredLevel: 6, dependsOn: "Lineage - First House", isGranted: true, prerequisiteText: "Swords" });
    expect(asked.get("field-required-level")).toEqual(["6"]);
    expect(asked.get("field-dependent-class-feature-option")).toEqual(["77"]);
    expect(asked.get("field-is-granted")).toEqual(["y"]);
    expect(controlById(form, "field-class-feature-option-description").values).toEqual(["<p>body text</p>"]);
    expect(asked.has("field-snippet")).toBe(false);
    expect(() => fillOptionForm(form, { name: "x", description: "<p>body text</p>", dependsOn: "Nope - Nothing" })).toThrow();
    // an explicit id (an update runs while the old options still carry the same label) beats the label
    const byId = fillOptionForm(form, { name: "x", description: "<p>body text</p>", dependsOn: "Lineage - First House" }, { value: "77" });
    expect(byId.get("field-dependent-class-feature-option")).toEqual(["77"]);
  });

  it("validateFeature checks options; featureOptionIds reads them off a feature page", () => {
    expect(() => validateFeature({ ...FEAT_B, options: [{ name: "A", description: "<p>a</p>" }] })).toThrow(/option "A": description needs/);
    expect(() => validateFeature({ ...FEAT_B, options: [{ name: "A", description: "<p>body</p>", requiredLevel: 0 }] })).toThrow(/requiredLevel/);
    expect(() => validateFeature({ ...FEAT_B, options: [{ name: "A", description: "<p>body</p>" }, { name: "A", description: "<p>body</p>" }] })).toThrow(/duplicate/);
    expect(() => validateFeature({ ...FEAT_B, hasOptions: false, options: [{ name: "A", description: "<p>body</p>" }] })).toThrow(/hasOptions is false/);
    expect(() => validateFeature({ ...FEAT_B, options: [{ name: "A", description: "<p>body</p>", requiredLevel: 3 }] })).not.toThrow();
    expect(featureOptionIds(`<a href="/classes/1-x/class-feature/9/option/5/edit">e</a><a href="/classes/1-x/class-feature/9/option/5/edit">e</a><a href="/classes/1-x/class-feature/9/option/6/edit">e</a>`)).toEqual([5, 6]);
  });

  it("reads the slug, feature table and child tables off pages", () => {
    const html = `<a href="/classes/500-my-sub/class-feature/create">Add</a><table class="listing listing-rpgclass-feature"><tbody>
      <tr><td> 3 </td><td> 1 </td><td> Ward </td><td> Granted </td><td><a href="/classes/500-my-sub/class-feature/77/edit">Edit</a><a href="/classes/500-my-sub/class-feature/77/delete">Delete</a></td></tr></tbody></table>`;
    expect(subclassSlug(html)).toBe("500-my-sub");
    expect(featureRows(html)).toEqual([{ id: 77, level: 3, order: "1", name: "Ward", type: "Granted", deleteHref: "/classes/500-my-sub/class-feature/77/delete" }]);
    expect(featureChildren(`<table class="listing-rpgentity-modifier"><tbody><tr><td> Resistance - Fire </td><td></td></tr></tbody></table>`)).toEqual({ modifiers: ["Resistance - Fire"], levelScales: [] });
    expect(() => subclassSlug("<html></html>")).toThrow(/not a saved subclass page/);
  });
});

describe("createHomebrewSubclass", () => {
  it("routes by class label, creates once, reads the id from the 200 body, then verifies", async () => {
    const st = fakeDdb();
    const r = await createHomebrewSubclass({ ...BASE, spellcasting: { ability: "INT", additionalSpellLists: ["Cleric"] } });
    expect(r).toMatchObject({ id: SUB_ID, name: "Order of Tests", parentClassId: 2190886, editUrl: `https://www.dndbeyond.com/classes/${PARENT}/subclass/${SUB_ID}/edit`, features: [] });
    expect(st.subclassPosts).toBe(1);
    const router = site.calls.find((c) => c.method === "POST" && c.path === "/homebrew/creations/create-subclass")!;
    expect(String(router.body)).toContain("class-type=2190886");
    expect(st.saved!.get("fba02f0ffdb1deda2f5b")).toBe("2190877");
    expect(st.saved!.get("spell-casting-ability")).toBe("4");
  });

  it("adds features (with a modifier and a level scale) to the new subclass's CURRENT slug and verifies them", async () => {
    const st = fakeDdb();
    const r = await createHomebrewSubclass({ ...BASE, features: [FEAT_A, FEAT_B] });
    expect(r.features.map((f) => [f.name, f.level, f.type])).toEqual([["Test Ward", 3, "Granted"], ["Test Surge", 6, "Additional"]]);
    const ward = st.features[0];
    expect(ward.mods).toEqual(["Resistance - Fire"]);
    expect(ward.scales).toEqual([["5", "2d6", "", "scale"]]);
    expect(ward.saved.get("feature-type")).toBe("1");
    expect(ward.saved.get("required-level")).toBe("3");
    const modPost = site.calls.find((c) => c.method === "POST" && c.path.startsWith("/modifier/create/"))!.body as URLSearchParams;
    expect(modPost.get("spell-modifier-sub-type")).toBe("134");
    expect(modPost.get("available-to-multiclass")).toBeNull();   // explicit false, not the form's pre-checked default
  });

  it("never retries when the 200 carries no new id, and says a subclass MAY exist", async () => {
    const st = fakeDdb({ createBody: "no-id" });
    const err = await createHomebrewSubclass(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/MAY have been created/);
    expect(err.message).toMatch(/\/my-creations/);
    expect(st.subclassPosts).toBe(1);
  });

  it("reports builder field errors from a rejected 200 without claiming anything was created", async () => {
    const st = fakeDdb({ createBody: "errors" });
    const err = await createHomebrewSubclass(BASE).catch((e) => e);
    expect(err.message).toMatch(/Name: Too long/);
    expect(err.message).not.toMatch(/MAY have been created/);
    expect(st.subclassPosts).toBe(1);
  });

  it("validates features up front: nothing is posted for a bad feature", async () => {
    fakeDdb();
    await expect(createHomebrewSubclass({ ...BASE, features: [{ ...FEAT_B, description: "x" }] })).rejects.toThrow(/at least 4 characters/);
    expect(site.calls).toHaveLength(0);
  });

  it("names the created subclass when a later step fails", async () => {
    fakeDdb({ failFeaturePost: true });
    const err = await createHomebrewSubclass({ ...BASE, features: [FEAT_B] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/subclass 500 was created/);
    expect(err.message).toMatch(/DDB server error/);
  });

  it("names the subclass when the read-back differs persistently", async () => {
    fakeDdb({ corrupt: (fd) => fd.set("version", "zzz") });
    const err = await createHomebrewSubclass({ ...BASE, version: "v1" }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/subclass 500 was created/);
    expect(err.message).toMatch(/field-version: asked \["v1"\], DDB has \["zzz"\]/);
  });

  it("rides out a stale read-back (replica lag) instead of failing", async () => {
    fakeDdb({ staleEdits: 2 });
    await expect(createHomebrewSubclass(BASE)).resolves.toMatchObject({ id: SUB_ID, name: "Order of Tests" });
  });
});

describe("updateHomebrewSubclass", () => {
  it("resolves the parent class from the id, changes only the given fields", async () => {
    const st = fakeDdb();
    await createHomebrewSubclass({ ...BASE, version: "v1" });
    site.calls.length = 0;
    const r = await updateHomebrewSubclass(SUB_ID, { description: "<p>New long</p>", spellcasting: { canCastSpells: true } });
    expect(r).toMatchObject({ id: SUB_ID, parentClassId: 2190886 });
    expect(site.calls[0]).toMatchObject({ method: "GET", path: `/homebrew/creations/edit?entityTypeId=789467139&id=${SUB_ID}` });
    expect(st.saved!.get("subclass-description-wysiwyg")).toBe("<p>New long</p>");
    expect(st.saved!.get("name")).toBe("Order of Tests");
    expect(st.saved!.get("version")).toBe("v1");
    expect(st.saved!.get("can-cast-spells")).toBe("t");
  });

  it("refuses an id that is not one of the account's subclasses", async () => {
    fakeDdb();
    await expect(updateHomebrewSubclass(123, { name: "x" })).rejects.toThrow(/no edit page for creation 123/);
  });

  it("replaces features wholesale after a rename, deleting old ones under the NEW slug; a type change is a recreate", async () => {
    const st = fakeDdb();
    await createHomebrewSubclass({ ...BASE, features: [FEAT_A, FEAT_B] });
    const oldIds = st.features.map((f) => f.id);
    const r = await updateHomebrewSubclass(SUB_ID, { name: "Order of Renames", features: [{ ...FEAT_B, type: "Replacement", name: "Test Surge" }] });
    expect(r.name).toBe("Order of Renames");
    expect(st.deleted.sort()).toEqual(oldIds.sort());
    expect(st.features).toHaveLength(1);
    expect(st.features[0].saved.get("feature-type")).toBe("3");
    expect(r.features.map((f) => [f.id, f.name, f.type])).toEqual([[st.features[0].id, "Test Surge", "Replacement"]]);
    const delete1 = site.calls.find((c) => c.method === "POST" && c.path.endsWith(`/class-feature/${oldIds[0]}/delete`))!;
    expect(delete1.path).toContain("order-of-renames");
    expect(String(delete1.body)).toBe("request-verification-token=rvt");
  });

  it("leaves features untouched when none are given, and clears them with []", async () => {
    const st = fakeDdb();
    await createHomebrewSubclass({ ...BASE, features: [FEAT_B] });
    await updateHomebrewSubclass(SUB_ID, { version: "v2" });
    expect(st.features).toHaveLength(1);
    await updateHomebrewSubclass(SUB_ID, { features: [] });
    expect(st.features).toHaveLength(0);
  });

  it("names the subclass and the feature ids when a feature step fails part-way", async () => {
    const st = fakeDdb();
    await createHomebrewSubclass(BASE);
    st.features.push({ id: 1, saved: new FormData(), mods: [], scales: [] });
    st.features[0].saved.set("name", "Old"); st.features[0].saved.set("required-level", "1"); st.features[0].saved.set("feature-type", "1");
    const bad = fakeDdb({ failFeaturePost: true });
    bad.saved = st.saved; bad.features = st.features;
    const err = await updateHomebrewSubclass(SUB_ID, { features: [FEAT_B] }).catch((e) => e);
    expect(err.message).toMatch(/subclass 500 update stopped part-way/);
    expect(err.message).toMatch(/old features: \[1\]/);
  });
});

describe("deleteHomebrewSubclass", () => {
  it("deletes via the generic route and confirms by a repeat delete answering 404", async () => {
    const st = fakeDdb();
    await createHomebrewSubclass(BASE);
    await expect(deleteHomebrewSubclass(SUB_ID)).resolves.toEqual({ id: SUB_ID, deleted: true });
    expect(st.deletes).toBe(1);
    expect(site.calls.filter((c) => c.path.startsWith("/homebrew/creations/delete"))).toHaveLength(2);
  });

  it("fails loudly if the repeat delete still finds the creation", async () => {
    const st = fakeDdb();
    await createHomebrewSubclass(BASE);
    const inner = site.handler;
    site.handler = (m, p, b) => (m === "POST" && p.startsWith("/homebrew/creations/delete") ? { status: 200, body: `{"RedirectUrl":"/my-creations"}` } : inner(m, p, b));
    await expect(deleteHomebrewSubclass(SUB_ID)).rejects.toThrow(/repeat delete answered 200/);
    expect(st.gone).toBe(false);
  });
});
