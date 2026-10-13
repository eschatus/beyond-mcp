import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session: routes by "METHOD path" and records every request.
const { site } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string; setCookie?: string };
  const site = {
    routes: new Map<string, Reply | ((body: FormData | URLSearchParams | undefined) => Reply)>(),
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
  fillItemForm, createHomebrewMagicItem, updateHomebrewMagicItem, deleteHomebrewMagicItem,
  resolveItemSpell, listingRows, setSettleDelaysForTests,
} from "./ddb-homebrew-item.js";
import { DdbWriteError } from "./ddb-write.js";

// --- fixtures shaped like the live builder (trimmed from the saved probe pages) ---

const ID = 55;
const EDIT = `/homebrew/creations/magic-items/${ID}-zz-item/edit`;
const CREATE = "/homebrew/creations/create-magic-item/create";

type Saved = FormData | undefined;
const options = (name: string, pairs: Array<[string, string]>, saved: Saved, blank = true) => {
  const picked = saved ? saved.getAll(name).map(String) : [];
  return (blank ? `<option value="">—</option>` : "") + pairs.map(([v, l]) => `<option value="${v}"${picked.includes(v) ? " selected" : ""}>${l}</option>`).join("");
};
const sel = (k: string, pairs: Array<[string, string]>, saved: Saved, multiple = false) =>
  `<select id="field-${k}" name="${k}"${multiple ? " multiple" : ""}>${options(k, pairs, saved)}</select>`;
const txt = (k: string, saved: Saved) => `<input type="text" id="field-${k}" name="${k}" value="${saved?.get(k) ?? ""}" />`;
const box = (k: string, saved: Saved) => `<input type="checkbox" id="field-${k}" name="${k}" value="y"${saved?.get(k) === "y" ? " checked" : ""} />`;
const area = (k: string, saved: Saved) => `<textarea id="field-${k}" name="${k}">${saved?.get(k) ?? ""}</textarea>`;

function itemForm(action: string, saved: Saved, edit: boolean): string {
  return `<form enctype="multipart/form-data" method="post" action="${action}">
    <input id="field-security-token" name="security-token" type="hidden" value="t" />
    ${txt("name", saved)}${txt("version", saved)}
    ${sel("rarity", [["1", "Common"], ["3", "Rare"], ["4", "Very Rare"]], saved)}
    <select id="field-item-base-type" name="item-base-type"><option value="">Item</option>${options("item-base-type", [["701257905", "Armor"], ["1782728300", "Weapon"]], saved, false)}</select>
    ${sel("type", [["10", "Wondrous Item"], ["8", "Wand"]], saved)}
    ${sel("base-armor", [["16", "Chain Mail"]], saved)}
    ${sel("dexterity-modifier", [["1", "Full Modifier"], ["2", "Max 2"]], saved)}
    ${txt("strength-requirement", saved)}
    ${sel("stealth-check", [["1", "None"], ["2", "Disadvantage"]], saved)}
    ${sel("base-weapon", [["4", "Longsword"], ["205", "Longsword, Silver"], ["300", "Dagger"], ["301", "Dagger"]], saved)}
    ${box("requires-attunement", saved)}${txt("attunement-description", saved)}
    <input type="hidden" id="field-item-description-type" name="item-description-type" value="1" />
    ${area("item-description-wysiwyg", saved)}${area("item-description", saved)}
    ${edit ? `${box("has-charges", saved)}${txt("number-of-charges", saved)}
      ${sel("charge-reset-condition", [["2", "Long Rest"], ["3", "Dawn"]], saved)}${area("charge-reset-description", saved)}
      ${area("notes", saved)}
      <input type="text" id="field-weight" name="weight" value="${saved?.get("weight") ? Number(saved.get("weight")).toFixed(2) : ""}" />
      ${sel("magic-item-tags-public", [["11", "Buff"], ["2", "Healing"]], saved, true)}` : ""}
  </form>`;
}

interface Row { id: number; cells: string[] }
const table = (cls: string, rows: Row[], href: (id: number) => string) =>
  `<table class="listing ${cls}"><tbody>${rows.map((r) => `<tr>${r.cells.map((c) => `<td> ${c} </td>`).join("")}<td><a href="${href(r.id)}/edit">Edit</a><a href="${href(r.id)}/delete">Delete</a></td></tr>`).join("")}</tbody></table>`;

const SUBTYPES = `<script>var subTypes = [[{"id":1,"name":"Armor Class","type":1},{"id":2,"name":"Fire","type":2}]];</script>`;

/** A stateful fake of the builder: POSTs store, the edit page renders what was stored, sub-forms add rows. */
function fakeDdb(opts: { corrupt?: (fd: FormData) => void; staleRenders?: number } = {}) {
  const st = { saved: undefined as Saved, mods: [] as Row[], conds: [] as Row[], spells: [] as Row[], next: 100, stale: 0, deletedCreation: false };
  const store = (body: unknown) => { st.saved = body as FormData; opts.corrupt?.(st.saved); };
  const subForm = (action: string, inner: string) => ({ status: 200, body: `<form method="post" action="${action}"><input name="security-token" type="hidden" value="t" />${inner}</form>${SUBTYPES}` });
  const arm = () => { st.stale = opts.staleRenders ?? 0; };

  site.routes.set(`GET ${CREATE}`, { status: 200, body: itemForm(CREATE, undefined, false) });
  site.routes.set(`POST ${CREATE}`, (b) => { store(b); return { status: 303, location: EDIT }; });
  site.routes.set(`GET /homebrew/creations/edit?entityTypeId=112130694&id=${ID}`, { status: 302, location: EDIT });
  site.routes.set(`GET ${EDIT}`, () => {
    const hide = st.stale > 0; if (hide) st.stale--;
    return { status: 200, body: itemForm(EDIT, st.saved, true)
      + table("listing-rpgentity-modifier", hide ? [] : st.mods, (i) => `/modifier/${i}`)
      + table("listing-rpgmagic-item-condition-mapping", hide ? [] : st.conds, (i) => `/magic-items/condition/${i}`)
      + table("listing-rpgitem-spell-mapping", hide ? [] : st.spells, (i) => `/magic-items/spell/${i}`) };
  });
  site.routes.set(`POST ${EDIT}`, (b) => { store(b); return { status: 303, location: EDIT }; });

  const modPath = `/modifier/create/${ID}-112130694/0`;
  site.routes.set(`GET ${modPath}`, subForm(modPath, `<select id="field-spell-modifier-type" name="t"><option value="">—</option><option value="1">Bonus</option><option value="2">Damage</option></select>
    <select id="field-spell-modifier-sub-type" name="st"></select><input id="field-fixed-value" name="fv" value="" /><input id="field-restriction" name="rs" value="" />
    <input type="checkbox" id="field-requires-attunement" name="ra" value="y" checked />`));
  site.routes.set(`POST ${modPath}`, (b) => {
    const p = b as URLSearchParams;
    st.mods.push({ id: st.next++, cells: [`${p.get("t") === "1" ? "Bonus" : "Damage"} - ${p.get("st") === "1" ? "Armor Class" : "Fire"}`, "", "", p.get("fv") ?? "", p.get("rs") ?? "", ""] });
    arm(); return { status: 302, location: `${EDIT}#modifiers` };
  });

  const condPath = `/magic-items/condition/create/${ID}`;
  site.routes.set(`GET ${condPath}`, subForm(condPath, `<select id="field-item-condition" name="f6c7hash"><option value="">—</option><option value="2">Charmed</option><option value="9">Poisoned</option></select>
    <input id="field-condition-duration" name="cd" value="" /><select id="field-duration-unit" name="du"><option value="">—</option><option value="3">Hour</option></select><input id="field-condition-exception" name="ce" value="" />`));
  site.routes.set(`POST ${condPath}`, (b) => {
    const p = b as URLSearchParams;
    st.conds.push({ id: st.next++, cells: [p.get("f6c7hash") === "2" ? "Charmed" : "Poisoned", p.get("cd") ? `${p.get("cd")} Hour` : "", p.get("ce") ?? ""] });
    arm(); return { status: 302, location: `${EDIT}#conditions` };
  });

  const spellPath = `/magic-items/spell/create/${ID}`;
  site.routes.set(`GET ${spellPath}`, subForm(spellPath, `<select id="field-item-spell" name="sp"><option value="">—</option>
    <option value="1">Fireball - [Level 3]</option><option value="2">Magic Missile - [Level 1]</option><option value="3">Magic Missile (Legacy) - [Level 1]</option></select>
    <input id="field-min-charges" name="mn" value="" /><input id="field-max-charges" name="mx" value="" /><input id="field-save-dc" name="dc" value="" />
    <input id="field-restriction" name="rs" value="" />`));
  site.routes.set(`POST ${spellPath}`, (b) => {
    const p = b as URLSearchParams;
    st.spells.push({ id: st.next++, cells: [{ "1": "Fireball", "2": "Magic Missile", "3": "Magic Missile" }[p.get("sp") ?? ""] ?? "?", p.get("mn") ?? "", p.get("mx") ?? "", "", p.get("dc") ?? "", p.get("rs") ?? ""] });
    arm(); return { status: 302, location: `${EDIT}#spells` };
  });

  site.routes.set("POST /refresh-request-verification-token", { status: 200, body: `{"result":"success"}`, setCookie: "RequestVerificationToken=rvt" });
  const del = (list: () => Row[], prefix: string) => (b: unknown) => { void b; return { status: 200, body: `{"RedirectUrl":"${EDIT}"}` }; void list; void prefix; };
  void del;
  // sub-entry deletes remove the row from state
  for (const [prefix, key] of [["/modifier/", "mods"], ["/magic-items/condition/", "conds"], ["/magic-items/spell/", "spells"]] as const) {
    for (let i = 100; i < 120; i++) {
      site.routes.set(`POST ${prefix}${i}/delete`, () => { st[key] = st[key].filter((r) => r.id !== i); return { status: 200, body: `{"RedirectUrl":"${EDIT}"}` }; });
    }
  }
  return st;
}

const BASE = { name: "zz item", rarity: "Rare", itemType: "Wondrous Item", description: "<p>Hi</p>" };

beforeEach(() => {
  site.routes.clear(); site.calls.length = 0; site.jar.clear();
  setSettleDelaysForTests([0, 0]);
});

describe("fillItemForm", () => {
  const form = (edit = false) => parseForm(itemForm(CREATE, undefined, edit), /create$/);

  it("resolves labels to option values, sends the description to both textareas, and reports what it set", () => {
    const f = form();
    const { asked } = fillItemForm(f, { ...BASE, requiresAttunement: true, attunementDescription: "by a wizard" });
    expect(asked.get("field-rarity")).toEqual(["3"]);
    expect(asked.get("field-type")).toEqual(["10"]);
    expect(asked.get("field-requires-attunement")).toEqual(["y"]);
    expect(controlById(f, "field-item-description-wysiwyg").values).toEqual(["<p>Hi</p>"]);
    expect(controlById(f, "field-item-description").values).toEqual(["<p>Hi</p>"]);
    expect([...asked.keys()].some((k) => k.includes("description-wysiwyg"))).toBe(false);
  });

  it("selects Armor/Weapon by label and Item as the blank-valued option", () => {
    const f = form();
    fillItemForm(f, { baseType: "Armor", baseArmor: "Chain Mail", dexterityModifier: "Max 2", strengthRequirement: 13 });
    expect(controlById(f, "field-item-base-type").values).toEqual(["701257905"]);
    expect(controlById(f, "field-base-armor").values).toEqual(["16"]);
    fillItemForm(f, { baseType: "Item", itemType: "Wand" });
    expect(controlById(f, "field-item-base-type").values).toEqual([""]);
  });

  it("surfaces the duplicate-label ambiguity of base-weapon and accepts an option id", () => {
    expect(() => fillItemForm(form(), { baseType: "Weapon", baseWeapon: "Dagger" })).toThrow(/ambiguous.*300.*301/);
    const f = form();
    fillItemForm(f, { baseType: "Weapon", baseWeapon: { value: "301" } });
    expect(controlById(f, "field-base-weapon").values).toEqual(["301"]);
  });

  it("rejects fields the server would silently null for the base type", () => {
    expect(() => fillItemForm(form(), { baseType: "Weapon", baseWeapon: "Longsword", baseArmor: "Chain Mail" })).toThrow(/"baseArmor" doesn't apply to a Weapon/);
    expect(() => fillItemForm(form(), { baseType: "Armor", itemType: "Wand" })).toThrow(/"itemType" doesn't apply to a Armor/);
    expect(() => fillItemForm(form(), { ...BASE, baseWeapon: "Longsword" })).toThrow(/"baseWeapon" doesn't apply to a Item/);
    expect(() => fillItemForm(form(), { baseType: "Armor", baseWeapon: "Longsword" })).toThrow(/baseWeapon/);
  });

  it("requires itemType for a plain Item and attunement for an attunement description", () => {
    expect(() => fillItemForm(form(), { name: "x", rarity: "Rare" })).toThrow(/itemType is required/);
    expect(() => fillItemForm(form(), { ...BASE, attunementDescription: "by a wizard" })).toThrow(/requiresAttunement: true/);
  });

  it("refuses edit-only fields on the create form", () => {
    expect(() => fillItemForm(form(false), { itemType: "Wand", notes: "n" })).toThrow(/no control #field-notes/);
  });
});

describe("resolveItemSpell", () => {
  const opts = [
    { value: "1", label: "Fireball - [Level 3]" }, { value: "2", label: "Magic Missile - [Level 1]" },
    { value: "3", label: "Magic Missile (Legacy) - [Level 1]" }, { value: "4", label: "Jim's Magic Missile - [Level 1]" },
    { value: "5", label: "Shield - [Level 1]" }, { value: "6", label: "Shield - [Level 1]" },
  ];
  it("takes a full label, including a Legacy one", () => {
    expect(resolveItemSpell(opts, "Magic Missile (Legacy) - [Level 1]").value).toBe("3");
  });
  it("takes a plain name only when exactly one non-Legacy option matches", () => {
    expect(resolveItemSpell(opts, "Magic Missile").value).toBe("2");
    expect(() => resolveItemSpell(opts, "Magic Missle")).toThrow(/not an option/);
  });
  it("lists candidates on an ambiguous name and takes { value }", () => {
    expect(() => resolveItemSpell(opts, "Shield")).toThrow(/matches 2 options.*value 5.*value 6/);
    expect(resolveItemSpell(opts, { value: "6" }).value).toBe("6");
    expect(() => resolveItemSpell(opts, { value: "99" })).toThrow(/no option with value "99"/);
  });
});

describe("listingRows", () => {
  it("reads rows keyed by their delete links, ignoring other tables and edit links", () => {
    const html = table("listing-rpgitem-spell-mapping", [{ id: 9, cells: ["Fireball", "1", "3", "", "15", "note"] }], (i) => `/magic-items/spell/${i}`);
    expect(listingRows(html, "spells")).toEqual([{ subId: 9, deletePath: "/magic-items/spell/9/delete", cells: ["Fireball", "1", "3", "", "15", "note", "EditDelete"] }]);
    expect(listingRows(html, "conditions")).toEqual([]);
  });
});

describe("createHomebrewMagicItem", () => {
  it("creates the base item, then applies edit-only fields in a follow-up save and verifies", async () => {
    const st = fakeDdb();
    const r = await createHomebrewMagicItem({ ...BASE, charges: { count: 7, resetCondition: "Dawn", resetDescription: "regains 1d6" }, notes: "n", weight: 2.5, tags: ["Buff"] });
    expect(r).toMatchObject({ id: ID, editUrl: `https://www.dndbeyond.com${EDIT}`, name: "zz item", rarity: "Rare", itemType: "Wondrous Item" });
    const createPost = site.calls.find((c) => c.method === "POST" && c.path === CREATE)!.body as FormData;
    expect(createPost.get("rarity")).toBe("3");
    expect(createPost.has("has-charges")).toBe(false);
    expect(st.saved!.get("name")).toBe("zz item");          // follow-up kept the created fields
    expect(st.saved!.get("number-of-charges")).toBe("7");
    expect(st.saved!.get("charge-reset-condition")).toBe("3");
    expect(st.saved!.getAll("magic-item-tags-public")).toEqual(["11"]);
    expect(site.calls.filter((c) => c.method === "POST" && c.path === EDIT)).toHaveLength(1);
  });

  it("skips the follow-up save when there are no edit-only fields", async () => {
    fakeDdb();
    await createHomebrewMagicItem(BASE);
    expect(site.calls.filter((c) => c.method === "POST" && c.path === EDIT)).toHaveLength(0);
  });

  it("adds modifiers, conditions and spells through their sub-forms and verifies the listing tables", async () => {
    fakeDdb();
    const r = await createHomebrewMagicItem({
      ...BASE,
      modifiers: [{ type: "Bonus", subType: "Armor Class", fixedValue: 1, restriction: "worn" }],
      conditions: [{ condition: "Charmed", duration: { interval: 1, unit: "Hour" }, exception: "elves" }],
      spells: [{ spell: "Fireball", minCharges: 1, maxCharges: 3, saveDc: 15 }],
    });
    expect(r).toMatchObject({ modifiers: 1, conditions: 1, spells: 1 });
    const mod = String(site.calls.find((c) => c.method === "POST" && c.path.startsWith("/modifier/create"))!.body);
    expect(mod).not.toContain("ra=");     // requires-attunement was explicitly unchecked (the form pre-checks it)
    expect(String(site.calls.find((c) => c.method === "POST" && c.path.startsWith("/magic-items/condition/"))!.body)).toContain("f6c7hash=2"); // hashed name addressed by id
  });

  it("names the created item when the read-back differs persistently", async () => {
    fakeDdb({ corrupt: (fd) => fd.set("rarity", "4") });
    const err = await createHomebrewMagicItem(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/magic item 55 was created/);
    expect(err.message).toMatch(/field-rarity: asked \["3"\], DDB has \["4"\]/);
  });

  it("names the created item when a sub-entry label is wrong after the base create", async () => {
    fakeDdb();
    const err = await createHomebrewMagicItem({ ...BASE, conditions: [{ condition: "Nope" }] }).catch((e) => e);
    expect(err.message).toMatch(/magic item 55 was created.*"Nope" is not an option/);
  });

  it("rides out a stale listing read (replica lag) instead of failing", async () => {
    fakeDdb({ staleRenders: 1 });
    await expect(createHomebrewMagicItem({ ...BASE, spells: [{ spell: "Fireball" }] })).resolves.toMatchObject({ id: ID, spells: 1 });
  });

  it("fails when a sub-entry never appears in the listing", async () => {
    fakeDdb({ staleRenders: 99 });
    await expect(createHomebrewMagicItem({ ...BASE, spells: [{ spell: "Fireball" }] })).rejects.toThrow(/magic item 55.*spells: asked Fireball - \[Level 3\]; DDB lists none/);
  });

  it("compares weight numerically (the server stores 2.5 as 2.50)", async () => {
    fakeDdb();
    await expect(createHomebrewMagicItem({ ...BASE, weight: 2.5 })).resolves.toMatchObject({ id: ID });
    fakeDdb({ corrupt: (fd) => fd.set("weight", "9") });
    await expect(createHomebrewMagicItem({ ...BASE, weight: 2.5 })).rejects.toThrow(/field-weight: asked 2.5, DDB has "9.00"/);
  });

  it("treats a redirect to /error as a failure and creates nothing else", async () => {
    fakeDdb();
    site.routes.set(`POST ${CREATE}`, { status: 303, location: "/error" });
    await expect(createHomebrewMagicItem(BASE)).rejects.toThrow(/DDB server error/);
  });
});

describe("updateHomebrewMagicItem", () => {
  it("resolves the edit page from the id and changes only the given fields", async () => {
    const st = fakeDdb();
    await createHomebrewMagicItem({ ...BASE, version: "v1" });
    const r = await updateHomebrewMagicItem(ID, { rarity: "Very Rare" });
    expect(r.rarity).toBe("Very Rare");
    expect(st.saved!.get("rarity")).toBe("4");
    expect(st.saved!.get("name")).toBe("zz item");
    expect(st.saved!.get("version")).toBe("v1");
  });

  it("rejects a misfit against the item's CURRENT base type", async () => {
    fakeDdb();
    await createHomebrewMagicItem({ name: "zz item", rarity: "Rare", baseType: "Weapon", baseWeapon: "Longsword", description: "<p>x</p>" });
    await expect(updateHomebrewMagicItem(ID, { baseArmor: "Chain Mail" })).rejects.toThrow(/"baseArmor" doesn't apply to a Weapon.*base type is Weapon/);
  });

  it("REPLACES a provided sub-entry kind via the listing's own delete hrefs and leaves other kinds alone", async () => {
    const st = fakeDdb();
    await createHomebrewMagicItem({ ...BASE, conditions: [{ condition: "Charmed" }], spells: [{ spell: "Fireball" }] });
    site.calls.length = 0;
    const r = await updateHomebrewMagicItem(ID, { conditions: [{ condition: "Poisoned", duration: { interval: 2, unit: "Hour" } }] });
    expect(r).toMatchObject({ conditions: 1, spells: 1 });
    expect(st.conds.map((c) => c.cells[0])).toEqual(["Poisoned"]);
    expect(site.calls.filter((c) => /\/delete$/.test(c.path)).map((c) => c.path)).toEqual(["/magic-items/condition/100/delete"]);
    expect(String(site.calls.find((c) => /delete$/.test(c.path))!.body)).toBe("request-verification-token=rvt");
  });

  it("clears a kind with []", async () => {
    const st = fakeDdb();
    await createHomebrewMagicItem({ ...BASE, spells: [{ spell: "Fireball" }] });
    await expect(updateHomebrewMagicItem(ID, { spells: [] })).resolves.toMatchObject({ spells: 0 });
    expect(st.spells).toEqual([]);
  });

  it("validates new sub-entries before deleting anything", async () => {
    const st = fakeDdb();
    await createHomebrewMagicItem({ ...BASE, spells: [{ spell: "Fireball" }] });
    site.calls.length = 0;
    await expect(updateHomebrewMagicItem(ID, { spells: [{ spell: "Fireballl" }] })).rejects.toThrow(/not an option/);
    expect(site.calls.some((c) => /\/delete$/.test(c.path))).toBe(false);
    expect(st.spells).toHaveLength(1);
  });

  it("refuses an id that isn't one of the account's items", async () => {
    await expect(updateHomebrewMagicItem(999, { rarity: "Rare" })).rejects.toThrow(/no edit page for creation 999/);
  });
});

describe("deleteHomebrewMagicItem", () => {
  it("confirms by a repeat delete answering 404", async () => {
    fakeDdb();
    let n = 0;
    site.routes.set(`GET ${EDIT}`, { status: 200, body: "edit" });   // a lagging replica still serves it
    site.routes.set("POST /homebrew/creations/delete?entityTypeId=112130694&id=55", () => (++n === 1 ? { status: 200, body: `{"RedirectUrl":"/my-creations"}` } : { status: 404 }));
    await expect(deleteHomebrewMagicItem(ID)).resolves.toEqual({ id: ID, deleted: true });
    expect(n).toBe(2);
  });

  it("fails loudly if the repeat delete still finds the item", async () => {
    fakeDdb();
    site.routes.set(`GET ${EDIT}`, { status: 200, body: "edit" });
    site.routes.set("POST /homebrew/creations/delete?entityTypeId=112130694&id=55", { status: 200, body: `{"RedirectUrl":"/my-creations"}` });
    await expect(deleteHomebrewMagicItem(ID)).rejects.toThrow(/repeat delete answered 200/);
  });
});
