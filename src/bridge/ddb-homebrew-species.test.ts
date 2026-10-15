import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session plus the character-service races JSON. One handler
// function routes by method + path; it is installed per test by fakeDdb().
const { site, rtRawFetch } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string; setCookie?: string };
  const site = {
    handler: null as null | ((method: string, path: string, body: FormData | URLSearchParams | undefined) => Reply | undefined),
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
      const r = site.handler?.(method, path, init.body);
      if (!r) return new Response("not found", { status: 404 });
      if (r.setCookie) { const [k, v] = r.setCookie.split("="); site.jar.set(k, v); }
      return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
    },
  }),
}));

import { parseForm, controlById } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";
import {
  createHomebrewSpecies, updateHomebrewSpecies, deleteHomebrewSpecies, fillSpeciesForm, fillTraitForm, parseSpeciesPage,
  parseModifierListing, verifyRaceJson, validateTrait, validateOption, fillTraitOptionForm, parseTraitOptionListing, setSettleDelaysForTests, type HomebrewSpeciesTrait,
} from "./ddb-homebrew-species.js";

// --- a stateful fake of the species builder: POSTs store, pages render what was stored ---

const slugOf = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const field = (id: string, v: string | undefined) => `<input type="text" id="field-${id}" name="${id}" value="${v ?? ""}" />`;
const box = (id: string, on: boolean) => `<input type="checkbox" id="field-${id}" name="${id}" value="y"${on ? " checked" : ""} />`;
const select = (id: string, pairs: Array<[string, string]>, picked: string | undefined) =>
  `<select id="field-${id}" name="${id}"><option value="">—</option>${pairs.map(([v, l]) => `<option value="${v}"${picked === v ? " selected" : ""}>${l}</option>`).join("")}</select>`;
const trio = (k: string, v: string | undefined) =>
  `<input type="hidden" id="field-${k}-type" name="${k}-type" value="1" /><textarea id="field-${k}-wysiwyg" name="${k}-wysiwyg">${v ?? ""}</textarea><textarea id="field-${k}" name="${k}">${v ?? ""}</textarea>`;

const SIZES: Array<[string, string]> = [["2", "Tiny"], ["3", "Small"], ["10", "Medium or Small"], ["4", "Medium"], ["5", "Large"]];
const GROUPS: Array<[string, string]> = [["46", "-"], ["137", "-"], ["4", "Aarakocra"], ["13", "Aasimar"]];
const SPEEDS = ["walking", "burrowing", "climbing", "flying", "swimming"];

type Body = FormData | URLSearchParams | undefined;
const get = (b: Body, k: string) => (b as FormData | URLSearchParams | undefined)?.get(k)?.toString();

interface FakeTrait { form: URLSearchParams; mods: Array<{ id: number; label: string; fixed: string }> }
interface FakeOption { form: FormData; slug: string }

function fakeDdb(opts: { corruptSize?: boolean; staleSpeciesReads?: number; raceMisses?: number } = {}) {
  const st = {
    id: 50, slug: "", species: undefined as FormData | undefined, stale: undefined as FormData | undefined, staleLeft: opts.staleSpeciesReads ?? 0,
    traits: new Map<number, FakeTrait>(), options: new Map<number, FakeOption>(), deleted: new Set<string>(),
    nextTrait: 900, nextMod: 7000, nextOption: 300, raceMisses: opts.raceMisses ?? 0,
  };
  const editPath = () => `/homebrew/creations/species/${st.id}-${st.slug}/edit`;
  const speciesForm = (saved: FormData | undefined, action: string) => [
    `<form method="post" enctype="multipart/form-data" action="${action}">`,
    `<input type="hidden" id="field-security-token" name="security-token" value="t" />`,
    field("name", saved?.get("name")?.toString()), field("version", saved?.get("version")?.toString()),
    select("size", SIZES, saved?.get("size")?.toString()),
    ...SPEEDS.map((k) => field(`speed-${k}`, saved?.get(`speed-${k}`)?.toString())),
    trio("short-description", saved?.get("short-description")?.toString()), select("race-group", GROUPS, saved?.get("race-group")?.toString()),
    trio("description", saved?.get("description")?.toString()),
    box("hide-traits-heading", saved?.get("hide-traits-heading") === "y"), field("racial-trait-introduction", saved?.get("racial-trait-introduction")?.toString()),
    box("supports-subrace", saved?.get("supports-subrace") === "y"),
    `</form>`,
  ].join("\n");
  const traitRows = () => [...st.traits].map(([id, t]) =>
    `<tr><td>${t.form.get("display-order-field") ?? ""}</td><td>${t.form.get("required-character-level") ?? ""}</td><td>${t.form.get("name")}</td><td>${["", "Granted", "Additional", "Replacement"][Number(t.form.get("feature-type"))]}</td><td><a href="/entity/species-trait/${id}/edit">Edit</a> | <a href="/entity/species-trait/${id}/delete">Delete</a></td></tr>`).join("");
  const optionRows = () => [...st.options].filter(([id]) => !st.deleted.has(`o${id}`)).map(([id, o]) =>
    `<tr><td>${o.form.get("name")}</td><td></td><td><a href="/homebrew/creations/species-options/${id}-${o.slug}/edit">Edit</a> | <a href="/species/${st.id}-x/species-options/${id}/delete">Delete</a></td></tr>`).join("");
  const speciesPage = () => {
    const shown = st.staleLeft > 0 && st.stale ? (st.staleLeft--, st.stale) : st.species;
    return speciesForm(shown, editPath()) + `<table>${traitRows()}</table><table>${optionRows()}</table>`;
  };
  const traitForm = (saved: URLSearchParams | undefined, action: string) => [
    `<form method="post" action="${action}">`, field("name", saved?.get("name")), `<textarea id="field-snippet" name="snippet">${saved?.get("snippet") ?? ""}</textarea>`,
    trio("racial-trait-mapping-description", saved?.get("racial-trait-mapping-description")),
    field("display-order-field", saved?.get("display-order-field")),
    box("hide-in-builder", saved?.get("hide-in-builder") === "y"), box("hide-in-sheet", saved?.get("hide-in-sheet") === "y"),
    box("hide-on-details-page", saved?.get("hide-on-details-page") === "y"), box("is-called-out", saved?.get("is-called-out") === "y"),
    select("feature-type", [["1", "Granted"], ["2", "Additional"], ["3", "Replacement"]], saved?.get("feature-type")),
    field("required-character-level", saved?.get("required-character-level")), `</form>`,
  ].join("\n");
  const modTypes: Array<[string, string]> = [["5", "Sense"], ["6", "Resistance"]];
  const subTypes = [{ id: 171, name: "Darkvision", type: 5 }, { id: 9, name: "Fire", type: 6 }, { id: 10, name: "Cold", type: 6 }];

  site.handler = (method, path, body) => {
    const key = `${method} ${path}`;
    if (key === "POST /refresh-request-verification-token") return { status: 200, setCookie: "RequestVerificationToken=tok" };
    if (key === "GET /homebrew/creations/create-species/create") return { status: 200, body: speciesForm(undefined, "/homebrew/creations/create-species/create") };
    if (key === "POST /homebrew/creations/create-species/create") {
      st.species = body as FormData;
      if (opts.corruptSize) st.species.set("size", "5");
      st.slug = slugOf(get(body, "name")!);
      return { status: 302, location: editPath() };
    }
    if (key === `GET /homebrew/creations/edit?entityTypeId=1743923279&id=${st.id}` && st.species) return { status: 302, location: editPath() };
    if (path === editPath() && st.species) {
      if (method === "GET") return { status: 200, body: speciesPage() };
      st.stale = st.species; st.species = body as FormData; st.slug = slugOf(get(body, "name")!);
      return { status: 302, location: editPath() };
    }
    if (path === `/entity/species-trait/create/${st.id}-1743923279`) {
      if (method === "GET") return { status: 200, body: traitForm(undefined, path) };
      // DDB's silent failure: a missing required field is a 200 with no field errors.
      if (!get(body, "name") || !get(body, "snippet") || !get(body, "racial-trait-mapping-description-wysiwyg")) return { status: 200, body: traitForm(undefined, path) };
      const id = st.nextTrait++;
      const form = body as URLSearchParams;
      if (form.get("required-character-level") === "1") form.set("required-character-level", ""); // live: the default level is stored blank
      st.traits.set(id, { form, mods: [] });
      return { status: 302, location: `/entity/species-trait/${id}/edit` };
    }
    let m = path.match(/^\/entity\/species-trait\/(\d+)\/edit$/);
    if (m && st.traits.has(Number(m[1])) && method === "GET") {
      const t = st.traits.get(Number(m[1]))!;
      const rows = t.mods.map((x) => `<tr><td>${x.label}</td><td></td><td></td><td>${x.fixed}</td><td></td><td></td><td><a href="/modifier/${x.id}/edit">Edit</a> <a href="/modifier/${x.id}/delete">Delete</a></td></tr>`).join("");
      return { status: 200, body: traitForm(t.form, path) + `<table class="listing listing-rpgentity-modifier">${rows}</table>` };
    }
    m = path.match(/^\/modifier\/create\/(\d+)-1960452172\/0$/);
    if (m && st.traits.has(Number(m[1]))) {
      if (method === "GET") {
        return { status: 200, body: `<script>var subTypes = [${JSON.stringify(subTypes)}];</script><form method="post" action="${path}">${select("spell-modifier-type", modTypes, undefined)}<select id="field-spell-modifier-sub-type" name="sub"><option value=""></option></select>${field("fixed-value", "")}</form>` };
      }
      const type = modTypes.find(([v]) => v === get(body, "spell-modifier-type"))![1];
      const sub = subTypes.find((x) => String(x.id) === get(body, "sub"))!;
      st.traits.get(Number(m[1]))!.mods.push({ id: st.nextMod++, label: `${type} - ${sub.name}`, fixed: get(body, "fixed-value") ?? "" });
      return { status: 302, location: `/entity/species-trait/${m[1]}/edit#modifiers` };
    }
    m = path.match(/^\/entity\/species-trait\/(\d+)\/delete$/);
    if (m && method === "POST") { st.traits.delete(Number(m[1])); return { status: 200, body: JSON.stringify({ RedirectUrl: "/x" }) }; }
    if (path === `${editPath().replace(/\/edit$/, "")}/create-species-options/create`) {
      const f = (action: string) => `<form method="post" enctype="multipart/form-data" action="${action}">${field("name", "")}${field("version", "")}${trio("item-description", "")}${select("race-group", GROUPS, undefined)}${box("is-variant", false)}</form>`;
      if (method === "GET") return { status: 200, body: f(path) };
      const id = st.nextOption++; const slug = slugOf(get(body, "name")!);
      st.options.set(id, { form: body as FormData, slug });
      return { status: 302, location: `/homebrew/creations/species-options/${id}-${slug}/edit` };
    }
    m = path.match(/^\/homebrew\/creations\/species-options\/(\d+)-([^/]+)\/edit$/);
    if (m && st.options.has(Number(m[1])) && !st.deleted.has(`o${m[1]}`)) {
      const o = st.options.get(Number(m[1]))!.form;
      return { status: 200, body: `<form method="post" enctype="multipart/form-data" action="${path}">${field("name", o.get("name")?.toString())}${field("version", o.get("version")?.toString())}${trio("item-description", o.get("item-description")?.toString())}${select("race-group", GROUPS, o.get("race-group")?.toString())}${box("is-variant", o.get("is-variant") === "y")}</form>` };
    }
    m = path.match(/^\/homebrew\/creations\/delete\?entityTypeId=(\d+)&id=(\d+)$/);
    if (m && method === "POST") {
      const k = `${m[1] === "1228963568" ? "o" : "s"}${m[2]}`;
      if (st.deleted.has(k)) return { status: 404 };   // the repeat-delete oracle
      st.deleted.add(k); return { status: 200, body: JSON.stringify({ RedirectUrl: "/my-creations" }) };
    }
    return undefined;
  };

  rtRawFetch.mockImplementation(async () => {
    const f = st.species;
    const listed = f && st.raceMisses-- <= 0 && f.get("supports-subrace") !== "y";
    const data = listed ? [{
      entityRaceId: st.id, fullName: f.get("name"), sizeId: Number(f.get("size")),
      weightSpeeds: { normal: { walk: Number(f.get("speed-walking") || 0), burrow: Number(f.get("speed-burrowing") || 0), climb: Number(f.get("speed-climbing") || 0), fly: Number(f.get("speed-flying") || 0), swim: Number(f.get("speed-swimming") || 0) } },
    }] : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  return st;
}

const BASE = { name: "zz Skyborn", size: "Medium", description: "<p>Winged folk.</p>", traitIntroduction: "You have the following traits." };
const DARK: HomebrewSpeciesTrait = {
  name: "Darkvision", snippet: "See in the dark.", description: "<p>60 ft.</p>", featureType: "Granted",
  modifiers: [{ type: "Sense", subType: "Darkvision", fixedValue: 60 }],
};
const WARD: HomebrewSpeciesTrait = {
  name: "Cold Ward", snippet: "Resist cold.", description: "<p>Resist.</p>", featureType: "Additional", requiredLevel: 1,
  modifiers: [{ type: "Resistance", subType: "Cold" }],
};

beforeEach(() => {
  site.handler = null; site.calls.length = 0; site.jar.clear(); rtRawFetch.mockReset();
  setSettleDelaysForTests([0, 0]);
});

describe("pure helpers", () => {
  it("fills the species form, clearing a speed with null, and reports only non-description controls", () => {
    const st = fakeDdb();
    void st;
    const form = parseForm(speciesFormHtml(), /create/);
    const asked = fillSpeciesForm(form, { ...BASE, speeds: { walk: 30, fly: null }, speciesGroup: "Aasimar", supportsOptions: true });
    expect(asked.get("field-size")).toEqual(["4"]);
    expect(asked.get("field-speed-walking")).toEqual(["30"]);
    expect(asked.get("field-speed-flying")).toEqual([""]);
    expect(asked.get("field-race-group")).toEqual(["13"]);
    expect(asked.get("field-supports-subrace")).toEqual(["y"]);
    expect(controlById(form, "field-description-wysiwyg").values).toEqual(["<p>Winged folk.</p>"]);
    expect([...asked.keys()].some((k) => k.includes("description"))).toBe(false);
    expect(() => fillSpeciesForm(parseForm(speciesFormHtml(), /create/), { speciesGroup: "-" })).toThrow(/ambiguous/);
    expect(fillSpeciesForm(parseForm(speciesFormHtml(), /create/), { speciesGroup: { value: "137" } }).get("field-race-group")).toEqual(["137"]);
  });

  it("rejects traits DDB would silently drop, before any request", () => {
    expect(() => validateTrait({ ...DARK, snippet: "" }, 0)).toThrow(/snippet/);
    expect(() => validateTrait({ ...DARK, snippet: "s" }, 0)).toThrow(/at least 2/);
    expect(() => validateTrait({ ...DARK, description: " " }, 1)).toThrow(/trait #2.*description/);
    expect(() => validateTrait({ ...DARK, name: "x" }, 0)).toThrow(/name/);
    expect(() => validateTrait({ ...DARK, requiredLevel: 21 }, 0)).toThrow(/requiredLevel/);
  });

  it("validates choices, actions and spell grants under a trait, and an option's own traits, before any request", () => {
    const opt = { name: "Heavy Plating", snippet: "Base AC 15.", description: "<p>x</p>" };
    expect(() => validateTrait({ ...DARK, traitOptions: [{ ...opt, snippet: "" }] }, 0)).toThrow(/trait option #1.*snippet/);
    expect(() => validateTrait({ ...DARK, traitOptions: [{ ...opt, requiredLevel: 0 }] }, 0)).toThrow(/requiredLevel/);
    expect(() => validateTrait({ ...DARK, traitOptions: [opt] }, 0)).not.toThrow();
    // uses without a reset are refused by the shared entity validator
    expect(() => validateTrait({ ...DARK, actions: [{ name: "Frenzy", actionType: "General", uses: { count: 1 } }] }, 0)).toThrow(/reset/);
    expect(() => validateOption({ name: "Variant A", description: "<p>x</p>", traits: [{ ...DARK, snippet: "" }] }, 0)).toThrow(/snippet/);
    expect(() => validateOption({ name: "G", description: "<p>x</p>" }, 2)).toThrow(/option #3/);
  });

  it("fills the trait-option form (class-feature-option description trio) and parses the choice listing", () => {
    const html = `<form method="post" action="/entity/species-trait/9/species-trait-option/create"><input id="field-name" name="name" type="text" value=""/>`
      + `<textarea id="field-snippet" name="snippet"></textarea>${trio("class-feature-option-description", undefined)}`
      + `${select("required-level", [["1", "1"], ["2", "2"]], undefined)}${box("is-granted", false)}</form>`;
    const asked = fillTraitOptionForm(parseForm(html, /species-trait-option\/create/), { name: "Heavy Plating", snippet: "AC 15", description: "<p>d</p>", requiredLevel: 2 });
    expect(asked.get("field-required-level")).toEqual(["2"]);
    expect(asked.get("field-is-granted")).toEqual([]);
    const rows = `<table><tr><td> Heavy Plating </td><td></td><td> No </td><td><a href="/entity/species-trait/9/species-trait-option/55/edit">Edit</a></td></tr></table>`;
    expect(parseTraitOptionListing(rows)).toEqual([{ id: 55, name: "Heavy Plating", granted: "No" }]);
  });

  it("asks level 1 back as blank (DDB stores the default as empty) and sets every checkbox explicitly", () => {
    fakeDdb();
    const form = parseForm(traitFormHtml(), /trait/);
    const asked = fillTraitForm(form, WARD);
    expect(asked.get("field-required-character-level")).toEqual([""]);
    expect(asked.get("field-hide-in-sheet")).toEqual([]);
    expect(asked.get("field-feature-type")).toEqual(["2"]);
  });

  it("parses listings and checks the races JSON independently of the form", () => {
    const page = parseSpeciesPage(`<table><tr><td>5</td><td>3</td><td>Dark &amp; Sight</td><td>Granted</td><td><a href="/entity/species-trait/9/edit">E</a></td></tr></table>
      <table><tr><td>Opt</td><td></td><td><a href="/homebrew/creations/species-options/4-opt/edit">E</a></td></tr></table>`);
    expect(page.traits).toEqual([{ id: 9, displayOrder: "5", requiredLevel: "3", name: "Dark & Sight", featureType: "Granted" }]);
    expect(page.options).toEqual([{ id: 4, name: "Opt", editPath: "/homebrew/creations/species-options/4-opt/edit" }]);
    expect(parseModifierListing(`<table class="listing listing-rpgentity-modifier"><tr><td>Sense - Darkvision</td><td></td><td></td><td>60</td><td></td><td></td><td><a href="/modifier/8/delete">x</a></td></tr></table>`))
      .toEqual([{ id: 8, label: "Sense - Darkvision", fixedValue: "60" }]);
    const entry = { entityRaceId: 1, fullName: "A", sizeId: 4, weightSpeeds: { normal: { walk: 30, fly: 0 } } };
    expect(verifyRaceJson(entry, { name: "A", size: "Medium", speeds: { walk: 30, fly: null } })).toEqual([]);
    expect(verifyRaceJson(entry, { size: "Large", speeds: { walk: 25 } })).toEqual([
      "json size: asked Large (5), DDB reads back sizeId 4", "json speed walk: asked 25, DDB reads back 30"]);
  });
});

function speciesFormHtml(): string {
  const saved = undefined;
  return `<form action="/homebrew/creations/create-species/create" enctype="multipart/form-data">${field("name", saved)}${select("size", SIZES, saved)}${SPEEDS.map((k) => field(`speed-${k}`, saved)).join("")}${trio("short-description", saved)}${select("race-group", GROUPS, saved)}${trio("description", saved)}${box("hide-traits-heading", false)}${field("racial-trait-introduction", saved)}${box("supports-subrace", false)}</form>`;
}
function traitFormHtml(): string {
  return `<form action="/entity/species-trait/create/1-1">${field("name", "")}<textarea id="field-snippet" name="snippet"></textarea>${trio("racial-trait-mapping-description", "")}${field("display-order-field", "")}${box("hide-in-builder", false)}${box("hide-in-sheet", false)}${box("hide-on-details-page", false)}${box("is-called-out", false)}${select("feature-type", [["1", "Granted"], ["2", "Additional"], ["3", "Replacement"]], undefined)}${field("required-character-level", "")}</form>`;
}

describe("createHomebrewSpecies", () => {
  it("creates the species, then verifies the edit form, the JSON and the (empty) listings", async () => {
    const st = fakeDdb();
    const r = await createHomebrewSpecies({ ...BASE, speeds: { walk: 30, fly: 40 } });
    expect(r).toMatchObject({ id: 50, traits: [], options: [], editUrl: `https://www.dndbeyond.com${`/homebrew/creations/species/50-${st.slug}/edit`}` });
    expect(r.raw?.weightSpeeds?.normal?.fly).toBe(40);
    const post = site.calls.find((c) => c.method === "POST" && c.path.includes("create-species"))!.body as FormData;
    expect(post.get("size")).toBe("4");
    expect(post.get("speed-flying")).toBe("40");
  });

  it("adds traits through the trait route (redirect required) and modifiers with resolved subtypes", async () => {
    const st = fakeDdb();
    const r = await createHomebrewSpecies({ ...BASE, traits: [DARK, WARD] });
    expect(r.traits.map((t) => [t.name, t.featureType])).toEqual([["Darkvision", "Granted"], ["Cold Ward", "Additional"]]);
    expect(st.traits.get(900)!.mods).toEqual([{ id: 7000, label: "Sense - Darkvision", fixed: "60" }]);
    expect(st.traits.get(901)!.mods[0].label).toBe("Resistance - Cold");
    const modPost = site.calls.find((c) => c.method === "POST" && c.path === "/modifier/create/900-1960452172/0")!.body as URLSearchParams;
    expect(modPost.get("sub")).toBe("171");           // "Darkvision" resolved from the inline catalogue
    expect(modPost.get("spell-modifier-type")).toBe("5");
  });

  it("treats a trait POST that answers 200 without a redirect as a failure naming the species", async () => {
    fakeDdb();
    const bad = { ...DARK, description: "<p>x</p>" };
    // The fake rejects silently when the wysiwyg copy is empty; simulate DDB refusing for another reason.
    site.handler = ((orig) => (method: string, path: string, body: Body) =>
      method === "POST" && path.startsWith("/entity/species-trait/create/") ? { status: 200, body: "<form></form>" } : orig!(method, path, body))(site.handler);
    const err = await createHomebrewSpecies({ ...BASE, traits: [bad] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/species 50 was created/);
    expect(err.message).toMatch(/silent 200/);
  });

  it("adds options, and requires supportsOptions for them", async () => {
    const st = fakeDdb();
    await expect(createHomebrewSpecies({ ...BASE, options: [{ name: "Stormborn", description: "<p>o</p>" }] })).rejects.toThrow(/supportsOptions/);
    expect(site.calls).toEqual([]);                    // rejected before any request
    const r = await createHomebrewSpecies({ ...BASE, supportsOptions: true, options: [{ name: "Stormborn", description: "<p>o</p>", speciesGroup: "Aasimar", isVariant: true }] });
    expect(r.options).toEqual([{ id: 300, name: "Stormborn" }]);
    expect(r.raw).toBeUndefined();                     // a species with options is never in the races JSON: unchecked, not a mismatch
    expect(st.options.get(300)!.form.get("race-group")).toBe("13");
    expect(st.options.get(300)!.form.get("is-variant")).toBe("y");
  });

  it("names the created species when the read-back differs", async () => {
    fakeDdb({ corruptSize: true });
    const err = await createHomebrewSpecies(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/species 50 was created/);
    expect(err.message).toMatch(/field-size: asked \["4"\], DDB has \["5"\]/);
    expect(err.message).toMatch(/json size: asked Medium \(4\)/);
  });

  it("rides out a stale edit page and a races JSON that omits the entry", async () => {
    // The first create-time read of the edit page is a stale (empty) snapshot; the first two JSON fetches omit the entry.
    const st = fakeDdb({ raceMisses: 2 });
    const orig = site.handler!;
    let first = true;
    site.handler = (method, path, body) => {
      const r = orig(method, path, body);
      if (method === "GET" && /\/species\/50-.*\/edit$/.test(path) && first && r) { first = false; return { ...r, body: r.body!.replace(/value="zz Skyborn"/, 'value="old name"') }; }
      return r;
    };
    const r = await createHomebrewSpecies({ ...BASE, speeds: { walk: 30 } });
    expect(r.raw).toBeDefined();                       // found by the in-read re-fetch
    expect(st.species!.get("name")).toBe("zz Skyborn");
  });
});

describe("updateHomebrewSpecies", () => {
  it("changes only the given fields and resolves the slug through the generic edit route", async () => {
    const st = fakeDdb();
    await createHomebrewSpecies({ ...BASE, speeds: { walk: 30, fly: 40 }, traits: [DARK] });
    site.calls.length = 0;
    const r = await updateHomebrewSpecies(50, { name: "zz Skyborn Renamed", speeds: { walk: 35, fly: null } });
    expect(site.calls[0].path).toBe("/homebrew/creations/edit?entityTypeId=1743923279&id=50");
    expect(st.species!.get("size")).toBe("4");         // untouched
    expect(st.species!.get("speed-walking")).toBe("35");
    expect(st.species!.get("speed-flying")).toBe("");
    expect(r.editUrl).toContain("zz-skyborn-renamed");
    expect(r.traits.map((t) => t.name)).toEqual(["Darkvision"]);   // traits untouched
    expect(site.calls.some((c) => c.path.includes("/delete"))).toBe(false);
  });

  it("replaces traits wholesale: adds the new set, then deletes the old ones, modifiers included", async () => {
    const st = fakeDdb();
    await createHomebrewSpecies({ ...BASE, traits: [DARK, WARD] });
    site.calls.length = 0;
    const r = await updateHomebrewSpecies(50, { traits: [{ ...WARD, name: "Hardy", featureType: "Granted", modifiers: [{ type: "Resistance", subType: "Fire" }] }] });
    expect([...st.traits.keys()]).toEqual([902]);
    expect(r.traits).toEqual([{ id: 902, name: "Hardy", featureType: "Granted" }]);
    const order = site.calls.filter((c) => c.method === "POST" && /species-trait\/(create|\d+\/delete)/.test(c.path)).map((c) => c.path);
    expect(order[0]).toMatch(/create\/50/);
    expect(order.slice(1)).toEqual(["/entity/species-trait/900/delete", "/entity/species-trait/901/delete"]);
    expect(st.traits.get(902)!.mods[0].label).toBe("Resistance - Fire");
  });

  it("replaces options (each old option deleted with the generic delete) and clears with []", async () => {
    const st = fakeDdb();
    await createHomebrewSpecies({ ...BASE, supportsOptions: true, options: [{ name: "Stormborn", description: "<p>o</p>" }] });
    const r = await updateHomebrewSpecies(50, { options: [{ name: "Ashborn", description: "<p>o</p>" }] });
    expect(r.options).toEqual([{ id: 301, name: "Ashborn" }]);
    expect(st.deleted.has("o300")).toBe(true);
    expect((await updateHomebrewSpecies(50, { options: [] })).options).toEqual([]);
  });

  it("fails loudly, naming the species, when a replaced trait is still listed", async () => {
    const st = fakeDdb();
    await createHomebrewSpecies({ ...BASE, traits: [DARK] });
    const orig = site.handler!;
    site.handler = (method, path, body) => (method === "POST" && path.endsWith("/delete") && path.includes("species-trait") ? { status: 200, body: JSON.stringify({ RedirectUrl: "/x" }) } : orig(method, path, body));
    const err = await updateHomebrewSpecies(50, { traits: [WARD] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/species 50/);
    expect(err.message).toMatch(/traits: asked ids \[901\], the owner lists \[900, 901\]/);
    void st;
  });
});

describe("deleteHomebrewSpecies", () => {
  it("deletes each option first, then the species, each confirmed by a repeat-delete 404", async () => {
    const st = fakeDdb();
    await createHomebrewSpecies({ ...BASE, supportsOptions: true, traits: [DARK], options: [{ name: "A one", description: "<p>o</p>" }, { name: "B two", description: "<p>o</p>" }] });
    site.calls.length = 0;
    const r = await deleteHomebrewSpecies(50);
    expect(r).toEqual({ id: 50, deleted: true, optionsDeleted: [300, 301] });
    const deletes = site.calls.filter((c) => c.method === "POST" && c.path.startsWith("/homebrew/creations/delete")).map((c) => c.path);
    expect(deletes).toEqual([
      "/homebrew/creations/delete?entityTypeId=1228963568&id=300", "/homebrew/creations/delete?entityTypeId=1228963568&id=300",
      "/homebrew/creations/delete?entityTypeId=1228963568&id=301", "/homebrew/creations/delete?entityTypeId=1228963568&id=301",
      "/homebrew/creations/delete?entityTypeId=1743923279&id=50", "/homebrew/creations/delete?entityTypeId=1743923279&id=50",
    ]);
    expect(st.deleted.has("s50")).toBe(true);
  });

  it("does not delete the species when an option delete fails", async () => {
    fakeDdb();
    await createHomebrewSpecies({ ...BASE, supportsOptions: true, options: [{ name: "A one", description: "<p>o</p>" }] });
    const orig = site.handler!;
    site.handler = (method, path, body) => (method === "POST" && path.includes("entityTypeId=1228963568") ? { status: 500 } : orig(method, path, body));
    const err = await deleteHomebrewSpecies(50).catch((e) => e);
    expect(err.message).toMatch(/species 50 NOT deleted.*option 300/);
    expect(site.calls.some((c) => c.path.includes("entityTypeId=1743923279&id=50") && c.method === "POST")).toBe(false);
  });
});
