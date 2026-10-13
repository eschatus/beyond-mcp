import { describe, it, expect, vi, beforeEach } from "vitest";

// A scripted stand-in for the www site session plus character-service. Dynamic: the fake DDB below
// installs `site.handle`, which routes every request and renders pages from stored state.
const { site, rtRawFetch } = vi.hoisted(() => {
  type Reply = { status: number; body?: string; location?: string; setCookie?: string };
  const site = {
    handle: undefined as undefined | ((method: string, path: string, body: FormData | URLSearchParams | undefined) => Reply),
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
      const r = site.handle?.(method, path, init.body) ?? { status: 404, body: "not found" };
      if (r.setCookie) { const [k, v] = r.setCookie.split("="); site.jar.set(k, v); }
      return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
    },
  }),
}));

import { parseForm, controlById } from "./html-form.js";
import {
  fillSpellForm, createHomebrewSpell, updateHomebrewSpell, deleteHomebrewSpell, validateSpellFields, verifyDefinition,
  subEntryIds, setSettleDelaysForTests, type HomebrewSpellFields,
} from "./ddb-homebrew-spell.js";
import { DdbWriteError } from "./ddb-write.js";

// --- fixtures shaped like the live builder (names equal ids minus "field-"; file inputs omitted) ---

type Saved = FormData | undefined;
type Pairs = Array<[string, string]>;
const OPT = {
  level: [["0", "Cantrip"], ["1", "1st"], ["3", "3rd"]] as Pairs,
  school: [["3", "Abjuration"], ["7", "Evocation"]] as Pairs,
  activation: [["1", "Action"], ["4", "Reaction"]] as Pairs,
  origin: [["1", "Self"], ["3", "Ranged"]] as Pairs,
  duration: [["1", "Instantaneous"], ["2", "Concentration"]] as Pairs,
  unit: [["2", "Minute"], ["3", "Hour"]] as Pairs,
  scale: [["1", "Character Level"], ["2", "Spell Scale"]] as Pairs,
  aoe: [["1", "Cone"], ["5", "Sphere"]] as Pairs,
  attack: [["1", "Melee"], ["2", "Ranged"]] as Pairs,
  save: [["2", "DEX"], ["3", "CON"]] as Pairs,
  tags: [["2", "Healing"], ["4", "Damage"]] as Pairs,
  classes: [["2190914", "Wizard"], ["2190915", "Sorcerer"], ["5", "Bard"], ["6", "Bard"], ["9", "Wizard - Evoker"]] as Pairs,
};
const label = (pairs: Pairs, v: string | null | undefined) => pairs.find(([x]) => x === v)?.[1] ?? null;

const sel = (k: string, pairs: Pairs, saved: Saved, multiple = false) => {
  const picked = saved ? saved.getAll(k).map(String) : [];
  return `<select id="field-${k}" name="${k}"${multiple ? " multiple" : ""}><option value="">—</option>${pairs.map(([v, l]) => `<option value="${v}"${picked.includes(v) ? ` selected="selected"` : ""}>${l}</option>`).join("")}</select>`;
};
const txt = (k: string, saved: Saved) => `<input type="text" id="field-${k}" name="${k}" value="${saved?.get(k) ?? ""}" />`;
const box = (k: string, saved: Saved) => `<input type="checkbox" id="field-${k}" name="${k}" value="y"${saved?.get(k) === "y" ? " checked" : ""} />`;
const area = (k: string, saved: Saved) => `<textarea id="field-${k}" name="${k}">${saved?.get(k) ?? ""}</textarea>`;
const hidden = (k: string, v: string) => `<input type="hidden" id="field-${k}" name="${k}" value="${v}" />`;

function builder(action: string, saved: Saved, edit: boolean): string {
  return [
    `<form enctype="multipart/form-data" method="post" action="${action}">`,
    hidden("security-token", "t"),
    txt("Name", saved).replace('id="field-Name"', 'id="field-Name"'), txt("version", saved),
    sel("spell-level", OPT.level, saved), sel("spell-school", OPT.school, saved),
    txt("spell-casting-time", saved), sel("spell-activation", OPT.activation, saved), txt("spell-casting-time-description", saved),
    box("verbal-field", saved), box("somatic-field", saved), box("material-field", saved), txt("spell-components", saved),
    sel("origin", OPT.origin, saved), txt("spell-range", saved),
    sel("spell-duration", OPT.duration, saved), txt("spell-duration-interval", saved), sel("spell-duration-unit", OPT.unit, saved),
    hidden("spell-description-type", "1"), area("spell-description-wysiwyg", saved), area("spell-description", saved),
    box("can-cast-as-ritual", saved), box("can-cast-at-higher-level", saved), sel("higher-level-scale", OPT.scale, saved),
    sel("class-mapping", OPT.classes, saved, true),
    ...(edit ? [
      sel("spell-aoe", OPT.aoe, saved), txt("spell-aoe-size", saved), box("as-part-of-weapon-attack", saved), sel("attack-type", OPT.attack, saved),
      sel("spell-save-type", OPT.save, saved), area("on-miss", saved), area("spell-save-success", saved), area("spell-save-fail", saved),
      sel("spell-tags-public", OPT.tags, saved, true),
    ] : []),
    `</form>`,
  ].join("\n");
}

const MOD_TYPES: Pairs = [["2", "Damage"], ["3", "Resistance"]];
const SUB_TYPES: Pairs = [["51", "Fire"], ["134", "Fire"], ["60", "Cold"]]; // flat list, duplicate label across types
const SUB_TYPE_CATALOGUE = `[[{"id":51,"name":"Fire","type":2},{"id":60,"name":"Cold","type":2},{"id":134,"name":"Fire","type":3}]]`;
const DICE: Pairs = [["6", "d6"], ["8", "d8"]];
const CONDITIONS: Pairs = [["1", "Blinded"], ["3", "Charmed"]];
const COND_UNITS: Pairs = [["2", "Minute"], ["6", "Special"]];
const EFFECTS: Pairs = [["1", "Additional Targets"], ["3", "Extended Duration"]];
const radio = (e: string, v: string, saved: Saved) => `<input type="radio" id="field-condition-effect-${e}" name="condition-effect" value="${v}"${saved?.get("condition-effect") === v ? " checked" : ""} />`;

function subForm(kind: "modifier" | "condition" | "additional", action: string, saved: Saved): string {
  const body = {
    modifier: [
      sel("spell-modifier-type", MOD_TYPES, saved), sel("spell-modifier-sub-type", SUB_TYPES, saved), txt("dice-count", saved), sel("dice-value", DICE, saved),
      txt("fixed-value", saved), box("primary-stat", saved), txt("duration", saved), sel("duration-unit", OPT.unit, saved), area("restriction", saved),
    ],
    condition: [
      box("hide", saved), radio("apply", "1", saved), radio("remove", "2", saved), radio("suppress", "3", saved),
      sel("condition", CONDITIONS, saved), txt("condition-duration", saved), sel("duration-unit", COND_UNITS, saved), area("condition-exception", saved),
    ],
    additional: [
      txt("level", saved), sel("modifier", [], saved), sel("effect-type", EFFECTS, saved), txt("dice-count", saved), sel("dice-value", DICE, saved),
      txt("dice-fixed", saved), area("dice-details", saved),
    ],
  }[kind];
  return `<form method="post" action="${action}">${hidden("security-token", "t")}${body.join("")}</form>`;
}

// --- a stateful fake of the spell builder routes: POSTs store bodies, pages render them back ---

const ID = 900;
type Kind = "modifier" | "condition" | "additional";
function fakeDdb(opts: { corrupt?: (fd: FormData) => void; defOverride?: (def: any, call: number) => any } = {}) {
  const st = {
    saved: undefined as FormData | undefined,
    slug: "zz-spell",
    subs: { modifier: new Map<number, FormData>(), condition: new Map<number, FormData>(), additional: new Map<number, FormData>() },
    nextSub: 5000,
    deletes: [] as string[],
    defCalls: 0,
    deleted: false,
  };
  const editPath = () => `/homebrew/creations/spells/${ID}-${st.slug}/edit`;
  const slugOf = (fd: FormData) => String(fd.get("Name") ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const storeBuilder = (body: unknown, creating: boolean) => {
    const fd = body as FormData;
    // An edit save posts every control, so what the page last held is replaced wholesale — like the live site.
    st.saved = fd;
    opts.corrupt?.(fd);
    st.slug = slugOf(fd);
    void creating;
    return { status: 303, location: editPath() };
  };
  const links = () => (Object.keys(st.subs) as Kind[]).flatMap((k) =>
    [...st.subs[k].keys()].map((id) => `<a href="/spells/${k}/${id}/edit">e</a><a href="/spells/${k}/${id}/delete">d</a>`)).join("");

  site.handle = (method, path, body) => {
    const key = `${method} ${path}`;
    if (key === "GET /homebrew/creations/create-spell/create") return { status: 200, body: builder("/homebrew/creations/create-spell/create", undefined, false) };
    if (key === "POST /homebrew/creations/create-spell/create") return storeBuilder(body, true);
    if (key === `GET /homebrew/creations/edit?entityTypeId=1118725998&id=${ID}`) return { status: 302, location: editPath() };
    if (key === `GET ${editPath()}`) return { status: 200, body: builder(editPath(), st.saved, true) + links() };
    if (key === `POST ${editPath()}`) return storeBuilder(body, false);
    if (key === "POST /refresh-request-verification-token") return { status: 200, body: `{"result":"success"}`, setCookie: "RequestVerificationToken=rvt" };
    let m = path.match(/^\/spells\/(modifier|condition|additional)\/create\/900$/);
    if (m) {
      const k = m[1] as Kind;
      if (method === "GET") {
        const script = k === "modifier" ? `<script>var subTypes = ${SUB_TYPE_CATALOGUE};\nvar subTypesValue = ;</script>` : "";
        return { status: 200, body: subForm(k, path, undefined) + script };
      }
      st.subs[k].set(++st.nextSub, body as FormData | any);
      return { status: 302, location: `${editPath()}#${k}` };
    }
    m = path.match(/^\/spells\/(modifier|condition|additional)\/(\d+)\/(edit|delete)$/);
    if (m) {
      const k = m[1] as Kind, sub = Number(m[2]);
      if (m[3] === "delete") { st.subs[k].delete(sub); st.deletes.push(`${k}/${sub}`); return { status: 200, body: `{"RedirectUrl":"${editPath()}"}` }; }
      const saved = st.subs[k].get(sub);
      if (!saved) return { status: 404 };
      const value = k === "modifier" ? `<script>var subTypesValue = ${saved.get("spell-modifier-sub-type")};</script>` : "";
      return { status: 200, body: subForm(k, path, saved as any) + value };
    }
    if (key === `POST /homebrew/creations/delete?entityTypeId=1118725998&id=${ID}`) {
      if (st.deleted) return { status: 404 };
      st.deleted = true;
      return { status: 200, body: `{"RedirectUrl":"/my-creations"}` };
    }
    return { status: 404, body: "not found" };
  };

  // character-service game-data/spells, derived from the stored builder state
  rtRawFetch.mockImplementation(async (url: string) => {
    expect(url).toMatch(/classId=(2190914|2190915|5|6)&classLevel=20&sharingSetting=2$/); // a base class, not "Wizard - Evoker"
    const fd = st.saved!;
    let def: any = {
      id: ID, name: fd.get("Name"), version: fd.get("version") ?? "", level: Number(fd.get("spell-level")),
      school: label(OPT.school, fd.get("spell-school") as string),
      activation: { activationTime: Number(fd.get("spell-casting-time")), activationType: Number(fd.get("spell-activation")) },
      castingTimeDescription: fd.get("spell-casting-time-description") ?? "",
      components: [["verbal-field", 1], ["somatic-field", 2], ["material-field", 3]].filter(([k]) => fd.get(k as string) === "y").map(([, n]) => n),
      componentsDescription: fd.get("spell-components") ?? "",
      range: { origin: label(OPT.origin, fd.get("origin") as string), rangeValue: fd.get("spell-range") ? Number(fd.get("spell-range")) : null, aoeType: label(OPT.aoe, fd.get("spell-aoe") as string), aoeValue: fd.get("spell-aoe-size") ? Number(fd.get("spell-aoe-size")) : null },
      duration: { durationType: label(OPT.duration, fd.get("spell-duration") as string), durationInterval: Number(fd.get("spell-duration-interval") || 0), durationUnit: label(OPT.unit, fd.get("spell-duration-unit") as string) },
      ritual: fd.get("can-cast-as-ritual") === "y", canCastAtHigherLevel: fd.get("can-cast-at-higher-level") === "y",
      asPartOfWeaponAttack: fd.get("as-part-of-weapon-attack") === "y",
      saveDcAbilityId: fd.get("spell-save-type") ? Number(fd.get("spell-save-type")) : null,
      tags: fd.getAll("spell-tags-public").map((v) => label(OPT.tags, String(v))),
      modifiers: [...st.subs.modifier.keys()], conditions: [...st.subs.condition.keys()],
    };
    if (opts.defOverride) def = opts.defOverride(def, st.defCalls);
    st.defCalls++;
    return new Response(JSON.stringify({ data: [{ definition: { id: 1 } }, ...(def ? [{ definition: def }] : [])] }), { status: 200 });
  });
  return st;
}

const BASE: HomebrewSpellFields = {
  name: "Zz Spell", level: "3rd", school: "Evocation", castingTime: { amount: 1, activation: "Action" },
  range: { origin: "Ranged", feet: 120 }, duration: { type: "Instantaneous" }, description: "<p>Boom.</p>", classes: ["Wizard", "Sorcerer"],
};

beforeEach(() => {
  site.handle = undefined; site.calls.length = 0; site.jar.clear();
  rtRawFetch.mockReset();
  setSettleDelaysForTests([0, 0]);
});

describe("fillSpellForm", () => {
  const create = () => parseForm(builder("/homebrew/creations/create-spell/create", undefined, false), /create$/);
  const edit = () => parseForm(builder("/x/edit", undefined, true), /edit$/);

  it("resolves select labels to option ids and applies group defaults explicitly", () => {
    const f = create();
    const asked = fillSpellForm(f, {
      ...BASE, components: { verbal: true, material: true, materialText: "a pinch of ash" },
      castingTime: { amount: 1, activation: "Reaction", note: "when hit" }, duration: { type: "Concentration", interval: 10, unit: "Minute" },
      higherLevelScale: "Spell Scale", ritual: true,
    });
    expect(asked.get("field-spell-level")).toEqual(["3"]);
    expect(asked.get("field-spell-school")).toEqual(["7"]);
    expect(asked.get("field-spell-activation")).toEqual(["4"]);
    expect(asked.get("field-spell-duration-unit")).toEqual(["2"]);
    expect(asked.get("field-class-mapping")).toEqual(["2190914", "2190915"]);
    expect(asked.get("field-verbal-field")).toEqual(["y"]);
    expect(asked.get("field-somatic-field")).toEqual([]);       // omitted flag → explicitly false
    expect(asked.get("field-can-cast-at-higher-level")).toEqual(["y"]);
    expect([...asked.keys()].some((k) => k.includes("description-wysiwyg"))).toBe(false);
    expect(controlById(f, "field-spell-description").values).toEqual(["<p>Boom.</p>"]);
    expect(controlById(f, "field-spell-description-wysiwyg").values).toEqual(["<p>Boom.</p>"]);
  });

  it("rejects an ambiguous class label and takes an explicit option id instead", () => {
    expect(() => fillSpellForm(create(), { classes: ["Bard"] })).toThrow(/"Bard" is ambiguous.*pass \{ value \}/);
    const asked = fillSpellForm(create(), { classes: [{ value: "6" }, "Wizard - Evoker"] });
    expect(asked.get("field-class-mapping")).toEqual(["6", "9"]);
  });

  it("clears blank selects and edit-only groups on null", () => {
    const f = edit();
    fillSpellForm(f, { areaOfEffect: { type: "Cone", size: 15 }, attack: { type: "Melee" }, save: { ability: "DEX", onFail: "half" } });
    const asked = fillSpellForm(f, { areaOfEffect: null, attack: null, save: null, higherLevelScale: null });
    expect(asked.get("field-spell-aoe")).toEqual([""]);
    expect(asked.get("field-spell-aoe-size")).toEqual([""]);
    expect(asked.get("field-as-part-of-weapon-attack")).toEqual([]);
    expect(asked.get("field-attack-type")).toEqual([""]);
    expect(asked.get("field-spell-save-fail")).toEqual([""]);
    expect(asked.get("field-higher-level-scale")).toEqual([""]);
  });

  it("refuses a label that is not an option", () => {
    expect(() => fillSpellForm(create(), { school: "Pyromancy" })).toThrow(/"Pyromancy" is not an option of #field-spell-school/);
  });
});

describe("validateSpellFields", () => {
  it("fails up front on what the server accepts weakly", () => {
    expect(() => validateSpellFields({ ...BASE, classes: [] }, "create")).toThrow(/at least one class/);
    expect(() => validateSpellFields({ ...BASE, name: undefined }, "create")).toThrow(/"name" is required/);
    expect(() => validateSpellFields({ level: "10th" }, "update")).toThrow(/not a builder label/);
    expect(() => validateSpellFields({ duration: { type: "Time", interval: 1 } }, "update")).toThrow(/go together/);
    expect(() => validateSpellFields({ components: { materialText: "x" } }, "update")).toThrow(/material is not true/);
    expect(() => validateSpellFields({ classes: [] }, "update")).toThrow(/cannot be emptied/);
    expect(() => validateSpellFields({}, "update")).toThrow(/nothing to update/);
    expect(() => validateSpellFields({ higherLevels: [{ level: 0, effect: "Special" }] }, "update")).toThrow(/level must be 1-9/);
  });
});

describe("verifyDefinition", () => {
  it("catches a caller label that game-data reads back differently", () => {
    const asked = new Map([["field-spell-activation", ["1"]]]);
    const def = { name: "Zz Spell", level: 3, school: "Evocation", activation: { activationTime: 1, activationType: 1 }, castingTimeDescription: "", range: { origin: "Ranged", rangeValue: 120 }, duration: { durationType: "Instantaneous", durationInterval: 0, durationUnit: null } };
    expect(verifyDefinition(def, BASE, asked)).toEqual([]);
    expect(verifyDefinition({ ...def, school: "Abjuration" }, BASE, asked)).toEqual([`school: asked "Evocation", DDB reads back "Abjuration"`]);
  });
});

describe("createHomebrewSpell", () => {
  it("creates, applies the edit-only fields in a follow-up save, and verifies against the edit form and game-data", async () => {
    const st = fakeDdb();
    const r = await createHomebrewSpell({
      ...BASE, ritual: true, higherLevelScale: "Character Level", components: { verbal: true, somatic: true },
      areaOfEffect: { type: "Sphere", size: 20 }, attack: { type: "Ranged" }, save: { ability: "DEX", onFail: "full damage", onSuccess: "half" }, tags: ["Damage"],
    });
    expect(r).toMatchObject({ id: ID, editUrl: `https://www.dndbeyond.com/homebrew/creations/spells/${ID}-zz-spell/edit` });
    expect(r.raw.name).toBe("Zz Spell");
    const posts = site.calls.filter((c) => c.method === "POST" && /spells\/900|create-spell/.test(c.path));
    expect(posts.map((c) => c.path)).toEqual(["/homebrew/creations/create-spell/create", `/homebrew/creations/spells/${ID}-zz-spell/edit`]);
    const createPost = posts[0].body as FormData;
    expect(createPost.has("spell-aoe")).toBe(false);
    expect(createPost.getAll("class-mapping")).toEqual(["2190914", "2190915"]);
    expect(createPost.get("spell-description")).toBe("<p>Boom.</p>");
    expect(st.saved!.get("spell-aoe")).toBe("5");           // follow-up save carried the edit-only fields…
    expect(st.saved!.get("Name")).toBe("Zz Spell");          // …and kept what create had saved
    expect(st.saved!.get("spell-save-type")).toBe("2");
  });

  it("names the created spell when the edit form reads back differently", async () => {
    fakeDdb({ corrupt: (fd) => fd.set("spell-school", "3") });
    const err = await createHomebrewSpell(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/spell 900 was created/);
    expect(err.message).toMatch(/field-spell-school: asked \["7"\], DDB has \["3"\]/);
  });

  it("names the created spell when game-data disagrees with the caller's labels", async () => {
    fakeDdb({ defOverride: (def) => ({ ...def, school: "Abjuration" }) });
    const err = await createHomebrewSpell(BASE).catch((e) => e);
    expect(err.message).toMatch(/spell 900 was created/);
    expect(err.message).toMatch(/school: asked "Evocation", DDB reads back "Abjuration"/);
  });

  it("rides out a stale first game-data read and a spell not listed yet (replica lag)", async () => {
    fakeDdb({ defOverride: (def, call) => (call === 0 ? null : call === 1 ? { ...def, name: "old name" } : def) });
    await expect(createHomebrewSpell(BASE)).resolves.toMatchObject({ id: ID });
    expect(rtRawFetch).toHaveBeenCalledTimes(3);
  });

  it("treats a redirect to /error and a rejected form as failures", async () => {
    fakeDdb();
    const handle = site.handle!;
    site.handle = (m, p, b) => (m === "POST" && p.includes("create-spell") ? { status: 303, location: "/error" } : handle(m, p, b));
    await expect(createHomebrewSpell(BASE)).rejects.toThrow(/DDB server error/);
    site.handle = (m, p, b) => (m === "POST" && p.includes("create-spell")
      ? { status: 200, body: `<div class="ddb-homebrew-create-form-fields-item"><div class="ddb-homebrew-create-form-fields-item-label">Spell Name</div><div><input id="field-Name" name="Name" /><span class="field-errors">This field is required.</span></div></div>` }
      : handle(m, p, b));
    await expect(createHomebrewSpell(BASE)).rejects.toThrow(/Spell Name: This field is required/);
  });

  it("adds modifiers (subtype resolved within its type, set raw), conditions and higher-level entries, and verifies each entry's own form", async () => {
    const st = fakeDdb();
    await createHomebrewSpell({
      ...BASE,
      modifiers: [{ type: "Resistance", subType: "Fire", dice: { count: 8, die: 6 }, restriction: "while concentrating" }],
      conditions: [{ effect: "apply", condition: "Charmed", duration: { interval: 1, unit: "Minute" }, exception: "elves" }],
      higherLevels: [{ level: 4, effect: "Additional Targets", fixedValue: 1 }],
    });
    const mod = [...st.subs.modifier.values()][0];
    expect(mod.get("spell-modifier-type")).toBe("3");
    expect(mod.get("spell-modifier-sub-type")).toBe("134");    // "Fire" under Resistance, not under Damage (51)
    expect(mod.get("dice-value")).toBe("6");
    const cond = [...st.subs.condition.values()][0];
    expect(cond.get("condition-effect")).toBe("1");
    expect(cond.get("condition")).toBe("3");
    expect(cond.get("duration-unit")).toBe("2");
    expect([...st.subs.additional.values()][0].get("effect-type")).toBe("1");
  });

  it("fails naming the spell when a sub-entry did not land as asked", async () => {
    const st = fakeDdb();
    const handle = site.handle!;
    // the server silently drops the subtype
    site.handle = (m, p, b) => {
      if (m === "POST" && p === "/spells/modifier/create/900") { (b as FormData).set("spell-modifier-sub-type", ""); }
      return handle(m, p, b);
    };
    const err = await createHomebrewSpell({ ...BASE, modifiers: [{ type: "Damage", subType: "Fire" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/spell 900 was created/);
    expect(err.message).toMatch(/modifiers: asked/);
    expect(st.subs.modifier.size).toBe(1);
  });

  it("errors on an ambiguous or foreign subtype before posting the sub-entry, naming the spell", async () => {
    fakeDdb();
    const err = await createHomebrewSpell({ ...BASE, modifiers: [{ type: "Damage", subType: "Sneeze" }] }).catch((e) => e);
    expect(err.message).toMatch(/spell 900 was created/);
    expect(err.message).toMatch(/modifiers\[0\]: .*"Sneeze" is not a subtype of modifier type 2. Valid: Fire, Cold/);
    expect(site.calls.some((c) => c.method === "POST" && c.path === "/spells/modifier/create/900")).toBe(false);
  });
});

describe("updateHomebrewSpell", () => {
  it("resolves the slugged edit page, changes only the given fields, and follows a rename", async () => {
    const st = fakeDdb();
    await createHomebrewSpell({ ...BASE, tags: ["Healing"] });
    const r = await updateHomebrewSpell(ID, { name: "Renamed Spell", level: "1st", tags: [] });
    expect(r.editUrl).toBe(`https://www.dndbeyond.com/homebrew/creations/spells/${ID}-renamed-spell/edit`);
    expect(st.saved!.get("Name")).toBe("Renamed Spell");
    expect(st.saved!.get("spell-level")).toBe("1");
    expect(st.saved!.get("spell-school")).toBe("7");           // untouched
    expect(st.saved!.getAll("class-mapping")).toEqual(["2190914", "2190915"]);
    expect(st.saved!.getAll("spell-tags-public")).toEqual([]);
  });

  it("REPLACES each provided sub-entry kind — higher-level entries, then modifiers, then conditions — and leaves unmentioned kinds alone", async () => {
    const st = fakeDdb();
    await createHomebrewSpell({
      ...BASE,
      modifiers: [{ type: "Damage", subType: "Fire" }, { type: "Damage", subType: "Cold" }],
      conditions: [{ effect: "apply", condition: "Blinded" }],
      higherLevels: [{ level: 4, effect: "Extended Duration" }],
    });
    site.calls.length = 0; st.deletes.length = 0;
    const [firstMod, secondMod] = [...st.subs.modifier.keys()];
    const condId = [...st.subs.condition.keys()][0];
    const addId = [...st.subs.additional.keys()][0];
    await updateHomebrewSpell(ID, {
      higherLevels: [], modifiers: [{ type: "Resistance", subType: "Fire" }], conditions: [{ effect: "suppress", condition: "Charmed", hide: true }],
    });
    expect(st.deletes).toEqual([`additional/${addId}`, `modifier/${firstMod}`, `modifier/${secondMod}`, `condition/${condId}`]);
    expect(st.subs.additional.size).toBe(0);
    expect([...st.subs.modifier.values()].map((m) => m.get("spell-modifier-sub-type"))).toEqual(["134"]);
    expect([...st.subs.condition.values()].map((c) => c.get("condition-effect"))).toEqual(["3"]);
    // no scalar field was given, so the builder form itself was never re-posted
    expect(site.calls.some((c) => c.method === "POST" && /\/spells\/900-/.test(c.path))).toBe(false);

    await updateHomebrewSpell(ID, { modifiers: [] });
    expect(st.subs.modifier.size).toBe(0);
    expect(st.subs.condition.size).toBe(1);
  });

  it("fails loudly when the id does not resolve to one of the account's spells", async () => {
    site.handle = () => ({ status: 302, location: "/error" });
    await expect(updateHomebrewSpell(ID, { name: "Nope Spell" })).rejects.toThrow(/no edit page for creation 900/);
  });
});

describe("deleteHomebrewSpell", () => {
  it("confirms by a repeat delete answering 404", async () => {
    const st = fakeDdb();
    await createHomebrewSpell(BASE);
    await expect(deleteHomebrewSpell(ID)).resolves.toEqual({ id: ID, deleted: true });
    expect(st.deleted).toBe(true);
    expect(site.calls.filter((c) => c.path.startsWith("/homebrew/creations/delete"))).toHaveLength(2);
  });

  it("fails loudly if a repeat delete still finds the creation", async () => {
    fakeDdb();
    const handle = site.handle!;
    site.handle = (m, p, b) => (p.startsWith("/homebrew/creations/delete") ? { status: 200, body: `{"RedirectUrl":"/my-creations"}` } : handle(m, p, b));
    await createHomebrewSpell(BASE);
    await expect(deleteHomebrewSpell(ID)).rejects.toThrow(/repeat delete answered 200/);
  });
});

describe("subEntryIds", () => {
  it("reads each kind's delete links off the edit page once per id", () => {
    const html = `<a href="/spells/modifier/11/delete"></a><a href="/spells/modifier/11/delete"></a><a href="/spells/condition/12/delete"></a><a href="/spells/modifier/11/edit"></a>`;
    expect(subEntryIds(html, "modifiers")).toEqual([11]);
    expect(subEntryIds(html, "conditions")).toEqual([12]);
    expect(subEntryIds(html, "higherLevels")).toEqual([]);
  });
});
