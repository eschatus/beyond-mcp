import { describe, it, expect, vi, beforeEach } from "vitest";

// A stateful stand-in for the www site: the builder renders whatever was last saved, like the live
// site, so create/update/verify are exercised end to end with no network.
const { site } = vi.hoisted(() => {
  const fresh = () => ({
    id: 77, name: "", version: "", tags: [] as string[], descs: {} as Record<string, string>, titled: {} as Record<string, string>,
    pools: {} as Record<string, { mid: number; values: string[] } | undefined>,
    feats: [] as Array<{ sid: number; name: string; feats: string[] }>,
    equipment: [] as Array<{ sid: number; name: string }>,
    chars: [] as Array<{ sid: number; type: string; name: string }>,
    next: 1000, deleted: false,
  });
  return {
    site: {
      st: fresh(), prev: fresh(), stale: 0, armStale: 0, created: 0, failChar: false,
      calls: [] as Array<{ method: string; path: string; body?: FormData | URLSearchParams }>,
      jar: new Map<string, string>(),
      reset() { this.st = fresh(); this.prev = fresh(); this.stale = 0; this.armStale = 0; this.created = 0; this.failChar = false; this.calls = []; this.jar.clear(); },
    },
  };
});

vi.mock("./ddb-rt.js", () => ({
  rtSiteSession: () => ({
    cookie: (n: string) => site.jar.get(n),
    async fetch(path: string, init: { method?: string; body?: FormData | URLSearchParams } = {}) {
      const method = init.method ?? "GET";
      site.calls.push({ method, path, body: init.body });
      return route(method, path, init.body);
    },
  }),
}));

import { createHomebrewBackground, updateHomebrewBackground, deleteHomebrewBackground, setSettleDelaysForTests, parseSections, sameHtml, validateBackgroundFields } from "./ddb-homebrew-background.js";
import { DdbWriteError } from "./ddb-write.js";

const SKILLS: Array<[string, string]> = [["3783", "Athletics"], ["3786", "Stealth"], ["3790", "Arcana"]];
const TOOLS: Array<[string, string]> = [["71", "Thieves' Tools"], ["72", "Thieves' Tools"], ["73", "Disguise Kit"]];
const LANGS: Array<[string, string]> = [["5", "Elvish"], ["6", "Dwarvish"]];
const FEATS: Array<[string, string]> = [["1789101", "Alert"], ["12", "Alert"], ["1789196", "Tough"]];
const POOL_OPTS: Record<string, Array<[string, string]>> = { "1": SKILLS, "2": TOOLS, "3": LANGS };
const POOL_KEY: Record<string, string> = { "1": "skills", "2": "tools", "3": "languages" };
const POOL_WORD: Record<string, string> = { "1": "Skill", "2": "Tool", "3": "Language" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = () => `77-${site.st.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const editPath = () => `/homebrew/creations/create-background/${slug()}/edit`;
const bgSlug = () => `/backgrounds/${slug()}`;

const DESC = ["short-description", "ability-scores-description", "feat-description", "skill-proficiencies-description", "tool-proficiencies-description", "languages-description", "equipment-description", "suggested-characteristics-description", "feature-description", "spell-list-pre-description"];
const TITLED_NAMES = ["feature-name", "variant-name"];

function mainForm(action: string, s: typeof site.st | null): string {
  const txt = (k: string, v: string) => `<input type="text" id="field-${k}" name="${k}" value="${v}" />`;
  const wys = (k: string) => {
    const v = s?.descs[k] ?? "";
    // Live: single-line descriptions come back without their <p> wrapper.
    const shown = /^(short|ability|feat|skill|tool|languages|equipment)/.test(k) ? v.replace(/^<p>([\s\S]*)<\/p>$/, "$1") : v;
    return `<input type="hidden" id="field-${k}-type" name="${k}-type" value="1" /><textarea id="field-${k}-wysiwyg" name="${k}-wysiwyg">${esc(shown)}</textarea><textarea id="field-${k}" name="${k}">${esc(shown)}</textarea>`;
  };
  return `<form id="background-form" enctype="multipart/form-data" method="post" action="${action}">
    <input id="field-security-token" name="security-token" type="hidden" value="t" />
    ${txt("name", s?.name ?? "")}${txt("version", s?.version ?? "")}
    ${DESC.map(wys).join("")}
    ${TITLED_NAMES.map((k) => txt(k, s?.titled[k] ?? "")).join("")}
    <select id="field-background-tags-public" name="background-tags-public" multiple><option value="1"${s?.tags.includes("1") ? " selected" : ""}>Combat</option><option value="2"${s?.tags.includes("2") ? " selected" : ""}>Magic</option></select>
  </form>`;
}

function sections(s: typeof site.st): string {
  const sec = (cls: string, head: string, rows: string[]) => `<div class="ddb-homebrew-create-special ddb-homebrew-create-special-${cls}"><div class="ddb-homebrew-create-header"><div class="ddb-homebrew-create-header-primary"><div class="ddb-homebrew-create-header-primary-text">${head}</div></div></div><table><tbody>${rows.join("")}</tbody></table></div>`;
  const row = (cells: string[], edit: string, del: string) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}<td><a href="${edit}">Edit</a> | <a href="${del}" class="modal-link">Delete</a></td></tr>`;
  const pool = (n: string, head: string) => {
    const p = s.pools[POOL_KEY[n]];
    const labels = p ? p.values.map((v) => POOL_OPTS[n].find(([id]) => id === v)![1]).join(", ") : "";
    return sec(POOL_KEY[n], `${head} (${p ? 1 : 0})`, p ? [row([`Proficiency - Choose a ${POOL_WORD[n]} - ${labels}`], `/modifier/${p.mid}/${n}/edit`, `/modifier/${p.mid}/delete`)] : []);
  };
  return pool("1", "Skill Proficiencies") + pool("2", "Tool Proficiencies") + pool("3", "Languages")
    + sec("equipment", `Equipment (${s.equipment.length})`, s.equipment.map((e) => row([e.name], `/entity/starting-equipment-slot/${e.sid}/edit`, `/entity/starting-equipment-slot/${e.sid}/delete`)))
    + sec("characteristics", `Suggested Characteristics (${s.chars.length})`, s.chars.map((c, i) => row([String(i + 1), c.name], `${bgSlug()}/characteristic/${c.sid}/edit`, `${bgSlug()}/characteristic/${c.sid}/delete`)))
    + sec("granted-feat", "Granted Feats", s.feats.map((g) => row([g.name], `${bgSlug()}/granted-feat/${g.sid}/edit`, `${bgSlug()}/granted-feat/${g.sid}/delete`)));
}

const page = (body: string) => new Response(`<html><body>${body}</body></html>`, { status: 200 });
const redirect = (loc: string) => new Response("", { status: 302, headers: { location: loc } });

function applyMain(b: FormData | URLSearchParams | undefined): void {
  const fd = b as FormData;
  const s = site.st;
  s.name = String(fd.get("name") ?? "");
  s.version = String(fd.get("version") ?? "");
  s.tags = fd.getAll("background-tags-public").map(String);
  for (const k of DESC) s.descs[k] = String(fd.get(`${k}-wysiwyg`) ?? "");
  for (const k of TITLED_NAMES) s.titled[k] = String(fd.get(k) ?? "");
}

const simpleForm = (action: string, inner: string) => `<form method="post" action="${action}"><input id="field-security-token" name="security-token" type="hidden" value="t" />${inner}</form>`;
const selHtml = (id: string, name: string, pairs: Array<[string, string]>, picked: string[], multiple = true) =>
  `<select id="${id}" name="${name}"${multiple ? " multiple" : ""}><option value="">—</option>${pairs.map(([v, l]) => `<option value="${v}"${picked.includes(v) ? " selected" : ""}>${l}</option>`).join("")}</select>`;
const CHAR_TYPES: Array<[string, string]> = [["1", "Personality Trait"], ["2", "Ideal"], ["3", "Bond"], ["4", "Flaw"]];

function route(method: string, path: string, body?: FormData | URLSearchParams): Response {
  const s = site.st;
  const snap = () => { site.prev = structuredClone(s); };
  if (path.startsWith("/refresh-request-verification-token")) { site.jar.set("RequestVerificationToken", "rvt"); return new Response("{}", { status: 200 }); }
  if (method === "GET" && path === "/homebrew/creations/create-background/create") return page(mainForm("/homebrew/creations/create-background/create", null));
  if (method === "POST" && path === "/homebrew/creations/create-background/create") { site.created++; snap(); applyMain(body); return redirect(editPath()); }
  if (path.startsWith("/homebrew/creations/edit?")) return s.name ? redirect(editPath()) : new Response("", { status: 404 });
  if (path === editPath()) {
    if (s.deleted) return new Response("", { status: 404 });
    if (method === "POST") { snap(); applyMain(body); return redirect(editPath()); }
    const view = site.stale > 0 ? (site.stale--, site.prev) : s;
    return page(mainForm(editPath(), view) + sections(view));
  }
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/modifier\/create\/77-1669830167\/([123])$/))) {
    if (method === "GET") return page(simpleForm(path, selHtml("field-spell-modifier-default-sub-types", "spell-modifier-default-sub-types", POOL_OPTS[m[1]], [])));
    snap(); s.pools[POOL_KEY[m[1]]] = { mid: s.next++, values: (body as URLSearchParams).getAll("spell-modifier-default-sub-types") };
    return redirect(`${editPath()}#x`);
  }
  if ((m = path.match(/^\/modifier\/(\d+)\/([123])\/edit$/))) {
    const p = s.pools[POOL_KEY[m[2]]];
    return p && p.mid === Number(m[1]) ? page(simpleForm(path, selHtml("field-spell-modifier-default-sub-types", "spell-modifier-default-sub-types", POOL_OPTS[m[2]], p.values))) : new Response("", { status: 404 });
  }
  if ((m = path.match(/^\/modifier\/(\d+)\/delete$/)) && method === "POST") {
    for (const k of Object.keys(s.pools)) if (s.pools[k]?.mid === Number(m[1])) s.pools[k] = undefined;
    return new Response(JSON.stringify({ RedirectUrl: "/x" }), { status: 200 });
  }
  if (path === `${bgSlug()}/granted-feat/create`) {
    if (method === "GET") return page(simpleForm(path, `<input type="text" id="field-name" name="name" value="" />${selHtml("field-feat", "feat", FEATS, [])}`));
    s.feats.push({ sid: s.next++, name: String((body as URLSearchParams).get("name")), feats: (body as URLSearchParams).getAll("feat") });
    return redirect(`${editPath()}#granted-feat`);
  }
  if ((m = path.match(/granted-feat\/(\d+)\/edit$/))) {
    const g = s.feats.find((x) => x.sid === Number(m![1]))!;
    return page(simpleForm(path, `<input type="text" id="field-name" name="name" value="${g.name}" />${selHtml("field-feat", "feat", FEATS, g.feats)}`));
  }
  if ((m = path.match(/granted-feat\/(\d+)\/delete$/))) { s.feats = s.feats.filter((x) => x.sid !== Number(m![1])); return new Response(JSON.stringify({ RedirectUrl: "/x" }), { status: 200 }); }
  if (path === "/entity/starting-equipment-slot/create/77-1669830167") {
    if (method === "GET") return page(simpleForm(path, `<input type="text" id="field-name" name="name" value="" />`));
    snap();
    s.equipment.push({ sid: s.next++, name: String((body as URLSearchParams).get("name")) });
    if (site.armStale) { site.stale = site.armStale; site.armStale = 0; }
    return redirect("/entity/starting-equipment-slot/1/edit");
  }
  if ((m = path.match(/starting-equipment-slot\/(\d+)\/delete$/))) { s.equipment = s.equipment.filter((x) => x.sid !== Number(m![1])); return new Response(JSON.stringify({ RedirectUrl: "/x" }), { status: 200 }); }
  if (path === `${bgSlug()}/characteristic/create`) {
    if (method === "GET") return page(simpleForm(path, `${selHtml("field-type", "type", CHAR_TYPES, [], false)}<input type="text" id="field-name" name="name" value="" />`));
    if (site.failChar) return new Response("boom", { status: 500 });
    const b = body as URLSearchParams;
    s.chars.push({ sid: s.next++, type: String(b.get("type")), name: String(b.get("name")) });
    return redirect(`${editPath()}#characteristics`);
  }
  if ((m = path.match(/characteristic\/(\d+)\/edit$/))) {
    const c = s.chars.find((x) => x.sid === Number(m![1]))!;
    return page(simpleForm(path, `${selHtml("field-type", "type", CHAR_TYPES, [c.type], false)}<input type="text" id="field-name" name="name" value="${c.name}" />`));
  }
  if ((m = path.match(/characteristic\/(\d+)\/delete$/))) { s.chars = s.chars.filter((x) => x.sid !== Number(m![1])); return new Response(JSON.stringify({ RedirectUrl: "/x" }), { status: 200 }); }
  if (path === "/homebrew/creations/delete?entityTypeId=1669830167&id=77") {
    if (s.deleted) return new Response("", { status: 404 });
    s.deleted = true;
    return new Response(JSON.stringify({ RedirectUrl: "/my-creations" }), { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

beforeEach(() => { site.reset(); setSettleDelaysForTests([0, 0, 0]); });

const BASE = { name: "Zz Wanderer", introduction: "<p>A traveller.</p>" };
const posts = (re: RegExp) => site.calls.filter((c) => c.method === "POST" && re.test(c.path));

describe("label resolution", () => {
  it("resolves skill labels to option ids and posts one pool", async () => {
    const r = await createHomebrewBackground({ ...BASE, skills: ["Athletics", "stealth"] });
    expect(r.id).toBe(77);
    expect(site.st.pools.skills?.values).toEqual(["3783", "3786"]);
    expect(posts(/modifier\/create/)).toHaveLength(1);
    expect(r.readBack.pools.skills).toEqual(["Athletics", "Stealth"]);
  });

  it("an unknown label fails naming the id of the already-created background", async () => {
    await expect(createHomebrewBackground({ ...BASE, skills: ["Basketweaving"] })).rejects.toThrow(/background 77 was created.*not an option/s);
  });

  it("an ambiguous tool label throws with the ids, and {value} picks one", async () => {
    await expect(createHomebrewBackground({ ...BASE, tools: ["Thieves' Tools"] })).rejects.toThrow(/ambiguous.*71.*72/s);
    site.reset();
    const r = await createHomebrewBackground({ ...BASE, tools: [{ value: "72" }, "Disguise Kit"] });
    expect(site.st.pools.tools?.values).toEqual(["72", "73"]);
    expect(r.readBack.counts.tools).toBe(1);
  });

  it("an ambiguous feat label throws; {value} resolves it", async () => {
    await expect(createHomebrewBackground({ ...BASE, grantedFeat: { name: "Alertness", feats: ["Alert"] } })).rejects.toThrow(/ambiguous.*1789101.*12/s);
    site.reset();
    await createHomebrewBackground({ ...BASE, grantedFeat: { name: "Alertness", feats: [{ value: "12" }] } });
    expect(site.st.feats[0].feats).toEqual(["12"]);
  });

  it("rejects empty pools and empty granted feats up front, creating nothing", async () => {
    await expect(createHomebrewBackground({ ...BASE, skills: [] })).rejects.toThrow(/empty pool/);
    await expect(createHomebrewBackground({ ...BASE, grantedFeat: { name: "Nope", feats: [] } })).rejects.toThrow(/empty granted feat/);
    expect(site.calls).toHaveLength(0);
    expect(() => validateBackgroundFields({ name: "x" })).toThrow(/2..128/);
  });
});

describe("create", () => {
  it("fills every v1 kind and verifies the edit page", async () => {
    const r = await createHomebrewBackground({
      ...BASE, version: "1.0", tags: ["Combat"], featDescription: "<p>Alert</p>", feature: { name: "Wanderer", description: "<p>You know the roads.</p>" },
      skills: ["Athletics"], tools: ["Disguise Kit"], languages: ["Elvish", "Dwarvish"],
      grantedFeat: { name: "Tough one", feats: ["Tough"] }, equipment: ["a dagger", "a map"],
      characteristics: [{ type: "Ideal", text: "freedom" }, { type: "Flaw", text: "wanderlust" }],
    });
    expect(r.readBack.counts).toEqual({ skills: 1, tools: 1, languages: 1, equipment: 2, characteristics: 2, grantedFeats: 1 });
    expect(site.st.descs["short-description"]).toBe("<p>A traveller.</p>");
    expect(site.st.titled["feature-name"]).toBe("Wanderer");
    expect(site.st.chars.map((c) => c.type)).toEqual(["2", "4"]);
    expect(r.editUrl).toBe("https://www.dndbeyond.com/homebrew/creations/create-background/77-zz-wanderer/edit");
  });
});

describe("update", () => {
  it("renames, changes only the given fields, and replaces a pool and the equipment wholesale", async () => {
    await createHomebrewBackground({ ...BASE, version: "1.0", skills: ["Athletics", "Stealth"], equipment: ["a dagger"], characteristics: [{ type: "Bond", text: "my crew" }] });
    const r = await updateHomebrewBackground(77, { name: "Zz Renamed", skills: ["Arcana"], equipment: ["rope", "lantern"] });
    expect(site.st.name).toBe("Zz Renamed");
    expect(site.st.version).toBe("1.0");                                 // untouched
    expect(sameHtml(site.st.descs["short-description"], "<p>A traveller.</p>")).toBe(true); // the form re-posts it without its <p>, as the live page shows it
    expect(site.st.pools.skills?.values).toEqual(["3790"]);
    expect(site.st.equipment.map((e) => e.name)).toEqual(["rope", "lantern"]);
    expect(site.st.chars).toHaveLength(1);                                // not provided → kept
    expect(r.editUrl).toMatch(/77-zz-renamed\/edit$/);
    // replaced rows were removed with the page's own delete hrefs
    expect(posts(/\/modifier\/\d+\/delete/)).toHaveLength(1);
    expect(posts(/starting-equipment-slot\/\d+\/delete/)).toHaveLength(1);
  });

  it("null removes a pool and the granted feat; [] clears characteristics", async () => {
    await createHomebrewBackground({ ...BASE, languages: ["Elvish"], grantedFeat: { name: "Tough one", feats: ["Tough"] }, characteristics: [{ type: "Ideal", text: "freedom" }] });
    const r = await updateHomebrewBackground(77, { languages: null, grantedFeat: null, characteristics: [] });
    expect(r.readBack.counts).toMatchObject({ languages: 0, grantedFeats: 0, characteristics: 0 });
  });

  it("resolves labels before deleting anything", async () => {
    await createHomebrewBackground({ ...BASE, tools: ["Disguise Kit"] });
    await expect(updateHomebrewBackground(77, { tools: ["Thieves' Tools"] })).rejects.toThrow(/ambiguous/);
    expect(site.st.pools.tools?.values).toEqual(["73"]);
    expect(posts(/delete/)).toHaveLength(0);
  });
});

describe("verification", () => {
  it("a persistent mismatch throws a DdbWriteError naming the id", async () => {
    // The fake silently drops the characteristic type, as the live server drops what it dislikes.
    await createHomebrewBackground(BASE);
    const orig = site.st;
    Object.defineProperty(orig, "equipment", { configurable: true, get: () => [], set: () => {} });
    const err = await updateHomebrewBackground(77, { equipment: ["a dagger"] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/background 77/);
    expect(err.message).toMatch(/equipment: asked/);
  });

  it("a failure after the base create names the created id", async () => {
    site.failChar = true;
    const err = await createHomebrewBackground({ ...BASE, characteristics: [{ type: "Ideal", text: "freedom" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(DdbWriteError);
    expect(err.message).toMatch(/background 77 was created/);
  });

  it("a stale read that settles is not an error", async () => {
    const r = await createHomebrewBackground({ ...BASE, equipment: ["a dagger"] });
    expect(r.readBack.counts.equipment).toBe(1);
    // the update's verify reads show the state from before the last write for two fetches
    site.armStale = 2;
    const u = await updateHomebrewBackground(77, { equipment: ["rope"] });
    expect(u.readBack.counts.equipment).toBe(1);
    expect(site.stale).toBe(0);
  });

  it("tolerates the stripped <p> wrapper on single-line descriptions", () => {
    expect(sameHtml("<p>Alert</p>", "Alert")).toBe(true);
    expect(sameHtml("<p>a</p><p>b</p>", "a</p><p>b")).toBe(false);
  });
});

describe("parseSections", () => {
  it("reads counts, labels and verbatim hrefs (contacts delete via a characteristic path)", () => {
    const html = `<div class="ddb-homebrew-create-special ddb-homebrew-create-special-contacts"><div class="ddb-homebrew-create-header-primary-text">Contacts (1)</div><table><tbody><tr><td>1</td><td>zz contact</td><td><a href="/backgrounds/s/contact/9/edit">Edit</a><a href="/backgrounds/s/characteristic/9/delete">Delete</a></td></tr></tbody></table></div>`;
    expect(parseSections(html).contacts).toEqual({ count: 1, rows: [{ label: "zz contact", editHref: "/backgrounds/s/contact/9/edit", deleteHref: "/backgrounds/s/characteristic/9/delete" }] });
  });
});

describe("delete", () => {
  it("deletes and confirms with a repeat delete answering 404", async () => {
    await createHomebrewBackground(BASE);
    await expect(deleteHomebrewBackground(77)).resolves.toEqual({ id: 77, deleted: true });
    expect(posts(/creations\/delete/)).toHaveLength(2);
  });

  it("refuses an id that has no edit page", async () => {
    await expect(deleteHomebrewBackground(77)).rejects.toThrow(/no edit page/);
  });
});
