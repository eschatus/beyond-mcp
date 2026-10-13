import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session: routes by "METHOD path" and records every request.
const { site, rtGetHomebrewMonster } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string; setCookie?: string };
  const site = {
    routes: new Map<string, Reply | ((body: FormData | URLSearchParams | undefined) => Reply)>(),
    calls: [] as Array<{ method: string; path: string; body?: FormData | URLSearchParams }>,
    jar: new Map<string, string>(),
  };
  return { site, rtGetHomebrewMonster: vi.fn() };
});

vi.mock("./ddb-rt.js", () => ({
  rtGetHomebrewMonster,
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
import { fillMonsterForm, createHomebrewMonster, updateHomebrewMonster, deleteHomebrewMonster, subEntryIds, verifyLabels, setSettleDelaysForTests } from "./ddb-homebrew.js";
import { DdbWriteError } from "./ddb-write.js";

// --- fixtures shaped like the live builder (ids stable, some names hashed per render) ---

// The builder renders whatever was last saved, like the live site — so the fake is stateful: a
// POST to create/edit stores its body, and the edit page renders those values back.
type Saved = FormData | undefined;
const opts = (name: string, pairs: Array<[string, string]>, saved: Saved, initial?: string) => {
  const picked = saved ? saved.getAll(name).map(String) : initial ? [initial] : [];
  return `<option value="">—</option>` + pairs.map(([v, l]) => `<option value="${v}"${picked.includes(v) ? ` selected="selected"` : ""}>${l}</option>`).join("");
};
const sel = (k: string, pairs: Array<[string, string]>, saved: Saved, multiple = false, initial?: string) =>
  `<select id="field-${k}" name="${k}"${multiple ? " multiple" : ""}>${opts(k, pairs, saved, initial)}</select>`;
const txt = (id: string, name: string, saved: Saved) => `<input type="text" id="field-${id}" name="${name}" value="${saved?.get(name) ?? ""}" />`;
const DESC_KEYS = ["special-traits", "actions", "bonus-actions", "reactions", "monster-characteristics", "legendary-actions", "mythic-actions", "lair"];
const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];

function builder(action: string, saved?: Saved): string {
  const box = (k: string) => `<input type="checkbox" id="field-${k}" name="${k}" value="y"${saved?.get(k) === "y" ? " checked" : ""} />`;
  return [
    `<form id="monster-form" enctype="multipart/form-data" method="post" action="${action}">`,
    `<input id="field-security-token" name="security-token" type="hidden" value="t" />`,
    sel("stat-block-type", [["0", "5e"], ["1", "5.5e"]], saved, false, "0"),
    txt("Name", "Name", saved), txt("version", "version", saved),
    sel("monster-type", [["9", "Fiend"], ["11", "Humanoid"]], saved),
    sel("monster-sub-type", [["10", "devil"]], saved, true),
    sel("size", [["4", "Medium"], ["5", "Large"]], saved),
    sel("alignment", [["5", "Neutral"], ["7", "Lawful Evil"]], saved),
    sel("challenge-rating", [["3", "1/4"], ["5", "1"], ["9", "5"]], saved),
    ...DESC_KEYS.map((k) => `<input type="hidden" id="field-${k}-description-type" name="${k}-description-type" value="1" />
      <textarea id="field-${k}-description-wysiwyg" name="${k}-description-wysiwyg">${saved ? "" : `&lt;p&gt;Template ${k}&lt;/p&gt;`}</textarea>
      <textarea id="field-${k}-description" name="${k}-description">${saved ? "" : `&lt;p&gt;Template ${k}&lt;/p&gt;`}</textarea>`),
    box("is-legendary"), box("is-mythic"), box("has-lair"),
    sel("lair-challenge-rating", [["10", "2300"]], saved),
    ...["armor-class", "armor-class-type", "passive-perception", "average-hit-points", "hit-points-die-count", "hit-points-modifier", "gear-description", "languages-note"].map((k) => txt(k, k, saved)),
    txt("initiative-bonus", "fa1", saved),
    sel("hit-points-die-value", [["8", "d8"], ["10", "d10"]], saved),
    ...ABILITIES.map((k, i) => txt(k, `fh${i}`, saved)),
    ...["monster-saving-throw", "damage-adjustment", "condition-immunity", "monster-environments", "monster-tags-public"].map((k) => sel(k, [["1", "One"]], saved, true)),
    sel("treasure", [["4", "Relics"]], saved, true),
    `<input type="file" id="field-avatar" name="fav" /></form>`,
  ].join("\n");
}

const EDIT = "/homebrew/creations/monsters/77-imp/edit";
const BASE = {
  name: "Imp", type: "Fiend", size: "Medium", challengeRating: "1", armorClass: 13, passivePerception: 11, averageHitPoints: 21,
  hitDice: { count: 6, die: 8 as const }, abilities: { str: 6, dex: 17, con: 13, int: 11, wis: 12, cha: 14 },
};
const RAW = {
  id: 77, name: "Imp", isHomebrew: true, url: "https://www.dndbeyond.com/monsters/77-imp", challengeRatingId: 5, sizeId: 4,
  armorClass: 13, passivePerception: 11, averageHitPoints: 21, hitPointDice: { diceCount: 6, diceValue: 8 },
  stats: [[1, 6], [2, 17], [3, 13], [4, 11], [5, 12], [6, 14]].map(([statId, value]) => ({ statId, value })),
  movements: [], senses: [], skills: [], languages: [],
};

beforeEach(() => {
  site.routes.clear(); site.calls.length = 0; site.jar.clear();
  rtGetHomebrewMonster.mockReset().mockResolvedValue(RAW);
  setSettleDelaysForTests([0, 0]);   // two quick re-reads instead of the live ~30s backoff
});

describe("fillMonsterForm", () => {
  it("blanks a fresh form's placeholder templates and reports only the non-description controls it set", () => {
    const f = parseForm(builder("/homebrew/creations/create-monster/create"), /create$/);
    const asked = fillMonsterForm(f, { ...BASE, actions: "<p>Bite.</p>" }, true);
    expect(controlById(f, "field-actions-description").values).toEqual(["<p>Bite.</p>"]);
    expect(controlById(f, "field-actions-description-wysiwyg").values).toEqual(["<p>Bite.</p>"]);
    expect(controlById(f, "field-special-traits-description").values).toEqual([""]);
    expect(controlById(f, "field-lair-description").values).toEqual([""]);
    expect(asked.get("field-challenge-rating")).toEqual(["5"]);   // label "1" → value "5"
    expect(asked.get("field-hit-points-die-value")).toEqual(["8"]);
    expect(asked.get("field-hit-points-modifier")).toEqual(["0"]); // omitted → the "0" DDB stores (live)
    expect(asked.get("field-strength")).toEqual(["6"]);
    expect([...asked.keys()].some((k) => k.includes("description"))).toBe(false);
  });

  it("leaves unsupplied descriptions alone on an edit form; null switches legendary off", () => {
    const f = parseForm(builder(EDIT), /edit$/);
    fillMonsterForm(f, { legendaryActions: null }, false);
    expect(controlById(f, "field-actions-description").values).toEqual(["<p>Template actions</p>"]);
    expect(controlById(f, "field-is-legendary").values).toEqual([]);
    expect(controlById(f, "field-legendary-actions-description").values).toEqual([""]);
  });
});

describe("verifyLabels", () => {
  it("catches a label resolved to the wrong option, independently of the form", () => {
    expect(verifyLabels(RAW, BASE)).toEqual([]);
    expect(verifyLabels({ ...RAW, challengeRatingId: 9 }, BASE)).toEqual([`challengeRating: asked "1", DDB reads back "5"`]);
  });
});

// A stateful fake of the builder routes: POSTs store the posted body, the edit page renders it.
function fakeDdb(opts: { editExtra?: string; corrupt?: (fd: FormData) => void } = {}) {
  const state: { saved?: FormData } = {};
  const store = (body: unknown) => { state.saved = body as FormData; opts.corrupt?.(state.saved); };
  site.routes.set("GET /homebrew/creations/create-monster/create", { status: 200, body: builder("/homebrew/creations/create-monster/create") });
  site.routes.set("POST /homebrew/creations/create-monster/create", (body) => { store(body); return { status: 303, location: EDIT }; });
  site.routes.set(`GET ${EDIT}`, () => ({ status: 200, body: builder(EDIT, state.saved) + (opts.editExtra ?? "") }));
  site.routes.set(`POST ${EDIT}`, (body) => { store(body); return { status: 303, location: EDIT }; });
  return state;
}

describe("createHomebrewMonster", () => {
  it("creates, then verifies against the edit form and monster-service", async () => {
    fakeDdb();
    const r = await createHomebrewMonster(BASE);
    expect(r).toMatchObject({ id: 77, editUrl: `https://www.dndbeyond.com${EDIT}` });
    const post = site.calls.find((c) => c.method === "POST")!.body as FormData;
    expect(post.get("challenge-rating")).toBe("5");
    expect(post.get("fh1")).toBe("17");                 // hashed DEX name, addressed by id
    expect(post.get("actions-description")).toBe("");  // placeholder template blanked
  });

  it("applies treasure through a follow-up edit save, never the create POST (which crashes on it)", async () => {
    const state = fakeDdb();
    await createHomebrewMonster({ ...BASE, treasure: ["Relics"] });
    const createPost = site.calls.find((c) => c.method === "POST" && c.path.includes("create-monster"))!.body as FormData;
    expect(createPost.has("treasure")).toBe(false);
    expect(state.saved!.getAll("treasure")).toEqual(["4"]);
    expect(state.saved!.get("Name")).toBe("Imp");       // the follow-up save kept the created fields
  });

  it("treats a redirect to /error as a failure", async () => {
    fakeDdb();
    site.routes.set("POST /homebrew/creations/create-monster/create", { status: 303, location: "/error" });
    await expect(createHomebrewMonster(BASE)).rejects.toThrow(/DDB server error/);
  });

  it("surfaces field errors from a rejected (200 re-rendered) form", async () => {
    fakeDdb();
    site.routes.set("POST /homebrew/creations/create-monster/create", {
      status: 200,
      body: `<div class="ddb-homebrew-create-form-fields-item"><div class="ddb-homebrew-create-form-fields-item-label">Monster Name</div><div><input id="field-Name" name="Name" /><span class="field-errors">This field is required.</span></div></div>`,
    });
    await expect(createHomebrewMonster(BASE)).rejects.toThrow(/Monster Name: This field is required/);
  });

  it("rides out a stale first read-back (replica lag) instead of failing", async () => {
    fakeDdb();
    rtGetHomebrewMonster.mockResolvedValueOnce({ ...RAW, name: "old name" }).mockResolvedValue(RAW);
    await expect(createHomebrewMonster(BASE)).resolves.toMatchObject({ id: 77 });
  });

  it("names the created monster when the read-back differs", async () => {
    fakeDdb({ corrupt: (fd) => fd.set("challenge-rating", "9") });
    const err = await createHomebrewMonster(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/monster 77 was created/);
    expect(err.message).toMatch(/field-challenge-rating: asked \["5"\], DDB has \["9"\]/);
  });

  it("adds sub-entries through their sub-forms and verifies them against monster-service", async () => {
    fakeDdb();
    site.routes.set("GET /monster/senses/create/77", {
      status: 200,
      body: `<form method="post" action="/monster/senses/create/77"><select id="field-sense" name="sense"><option value="">—</option><option value="2">Darkvision</option></select><input id="field-sense-note" name="sense-note" value="" /></form>`,
    });
    site.routes.set("POST /monster/senses/create/77", { status: 302, location: `${EDIT}#senses` });
    rtGetHomebrewMonster.mockResolvedValue({ ...RAW, senses: [{ senseId: 2, notes: "120 ft." }] });
    await createHomebrewMonster({ ...BASE, senses: [{ sense: "Darkvision", note: "120 ft." }] });
    expect(String(site.calls.find((c) => c.path === "/monster/senses/create/77" && c.method === "POST")!.body)).toBe("sense=2&sense-note=120+ft.");

    rtGetHomebrewMonster.mockResolvedValue({ ...RAW, senses: [] });
    await expect(createHomebrewMonster({ ...BASE, senses: [{ sense: "Darkvision", note: "120 ft." }] })).rejects.toThrow(/senses: asked/);
  });
});

describe("updateHomebrewMonster", () => {
  it("resolves the slugged edit page, saves, and REPLACES a provided sub-entry kind via ajax-post deletes", async () => {
    const state = fakeDdb({ editExtra: `<a href="/monster/movement/501/delete">x</a><a href="/monster/movement/502/delete">x</a><a href="/monster/skills/900/delete">x</a>` });
    site.routes.set("POST /refresh-request-verification-token", { status: 200, body: `{"result":"success"}`, setCookie: "RequestVerificationToken=rvt" });
    for (const id of [501, 502]) site.routes.set(`POST /monster/movement/${id}/delete`, { status: 200, body: `{"RedirectUrl":"${EDIT}"}` });
    rtGetHomebrewMonster.mockResolvedValue({ ...RAW, armorClass: 14 });
    await expect(updateHomebrewMonster(77, { armorClass: 14, movements: [] })).resolves.toMatchObject({ id: 77 });
    expect(state.saved!.get("armor-class")).toBe("14");
    const deletes = site.calls.filter((c) => /\/delete$/.test(c.path));
    expect(deletes.map((c) => c.path)).toEqual(["/monster/movement/501/delete", "/monster/movement/502/delete"]); // skills untouched
    expect(String(deletes[0].body)).toBe("request-verification-token=rvt");
  });

  it("changes only the given fields and verifies them", async () => {
    const state = fakeDdb();
    await createHomebrewMonster(BASE);
    rtGetHomebrewMonster.mockResolvedValue({ ...RAW, armorClass: 14 });
    await expect(updateHomebrewMonster(77, { armorClass: 14 })).resolves.toMatchObject({ id: 77 });
    expect(state.saved!.get("armor-class")).toBe("14");
    expect(state.saved!.get("Name")).toBe("Imp");
  });

  it("refuses a non-homebrew monster", async () => {
    rtGetHomebrewMonster.mockResolvedValue({ ...RAW, isHomebrew: false, name: "Goblin" });
    await expect(updateHomebrewMonster(77, { armorClass: 13 })).rejects.toThrow(/not homebrew/);
  });
});

describe("deleteHomebrewMonster", () => {
  beforeEach(() => {
    site.routes.set("POST /refresh-request-verification-token", { status: 200, body: "{}", setCookie: "RequestVerificationToken=rvt" });
    site.routes.set("POST /homebrew/creations/delete?entityTypeId=779871897&id=77", { status: 200, body: `{"RedirectUrl":"/homebrew"}` });
  });

  it("confirms by a repeat delete answering 404 — not by the (flappy) edit page", async () => {
    let deletes = 0;
    site.routes.set(`GET ${EDIT}`, { status: 200, body: "edit" });   // a lagging replica still serves it
    site.routes.set("POST /homebrew/creations/delete?entityTypeId=779871897&id=77", () =>
      (++deletes === 1 ? { status: 200, body: `{"RedirectUrl":"/my-creations"}` } : { status: 404 }));
    await expect(deleteHomebrewMonster(77)).resolves.toEqual({ id: 77, deleted: true });
    expect(deletes).toBe(2);
  });

  it("fails loudly if a repeat delete still finds the creation", async () => {
    site.routes.set(`GET ${EDIT}`, { status: 200, body: "edit" });
    await expect(deleteHomebrewMonster(77)).rejects.toThrow(/repeat delete answered 200/);
  });
});

describe("subEntryIds", () => {
  it("reads each kind's delete links off the edit page", () => {
    const html = `<a href="/monster/senses/4968889/delete"></a><a href="/entity/language/6986035/delete"></a><a href="/entity/language/6986036/edit"></a>`;
    expect(subEntryIds(html, "senses")).toEqual([4968889]);
    expect(subEntryIds(html, "languages")).toEqual([6986035]);
    expect(subEntryIds(html, "movements")).toEqual([]);
  });
});
