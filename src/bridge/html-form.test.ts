import { describe, it, expect } from "vitest";
import { parseForm, setControl, clearControl, encodeForm, formErrors, controlById } from "./html-form.js";

// Trimmed from a live capture of /homebrew/creations/create-monster/create (2026-10-12): hashed
// per-render names on ability inputs, entity-escaped placeholder templates in textareas, and a CR
// select whose option VALUES collide with other options' LABELS.
const PAGE = `
<form class="_search" data-testid="navigation-search-form"><input name="q" /></form>
<form id="monster-form" enctype="multipart/form-data" method="post" action="/homebrew/creations/create-monster/create">
  <input id="field-security-token" name="security-token" type="hidden" value="tok1" />
  <input id="field-authenticity-token" name="authenticity-token" type="hidden" value="tok2" />
  <div class="ddb-homebrew-create-form-fields-item">
    <div class="ddb-homebrew-create-form-fields-item-label tip req">Monster Name</div>
    <div class="ddb-homebrew-create-form-fields-item-input">
      <input type="text" name="Name" id="field-Name" value="" />
      <span class="field-errors">This field is required.</span>
    </div>
  </div>
  <select id="field-stat-block-type" name="stat-block-type"><option value="">—</option><option value="0" selected="selected">5e</option><option value="1">5.5e</option></select>
  <select id="field-challenge-rating" name="challenge-rating"><option value="">—</option><option value="1">0</option><option value="5">1</option><option value="9">5</option></select>
  <select id="field-monster-tags-public" name="monster-tags-public" multiple="multiple"><option value="30">devil</option><option value="58">Devil</option></select>
  <textarea name="actions-description-wysiwyg" id="field-actions-description-wysiwyg">&lt;p&gt;&lt;strong&gt;Action Name.&lt;/strong&gt; Enter your monster&#x27;s action &amp; more.&lt;/p&gt;</textarea>
  <input type="checkbox" name="is-legendary" id="field-is-legendary" value="y" />
  <input type="text" name="fdb5c7a032c23a7a838c75d97c320e99b" id="field-strength" value="" />
  <input type="file" name="f927defcccf4c9e7440cff7eb7ef347dd" id="field-avatar" />
  <span class="field-errors" id="field-error-field-body" style="display: none;"></span>
  <button id="save-changes" class="button" type="submit">Create Monster</button>
</form>`;

const form = () => parseForm(PAGE, /create-monster\/create$/);

describe("parseForm", () => {
  it("picks the form by action and reads every control as a browser would submit it", () => {
    const f = form();
    expect(f.enctype).toBe("multipart/form-data");
    expect(controlById(f, "field-security-token").values).toEqual(["tok1"]);
    expect(controlById(f, "field-stat-block-type").values).toEqual(["0"]);         // marked selected
    expect(controlById(f, "field-challenge-rating").values).toEqual([""]);         // first option
    expect(controlById(f, "field-monster-tags-public").values).toEqual([]);        // multi, none
    expect(controlById(f, "field-is-legendary").values).toEqual([]);               // unchecked
    expect(controlById(f, "field-strength").name).toBe("fdb5c7a032c23a7a838c75d97c320e99b");
    expect(f.controls.some((c) => c.name === "q")).toBe(false);                    // other form ignored
  });

  it("decodes textarea content (named, decimal and hex entities)", () => {
    expect(controlById(form(), "field-actions-description-wysiwyg").values[0])
      .toBe("<p><strong>Action Name.</strong> Enter your monster's action & more.</p>");
  });

  it("throws when no form matches", () => {
    expect(() => parseForm(PAGE, /nope$/)).toThrow(/no <form>/);
  });
});

describe("setControl", () => {
  it("matches select options by LABEL, never by colliding value", () => {
    const f = form();
    setControl(f, "field-challenge-rating", "5");
    expect(controlById(f, "field-challenge-rating").values).toEqual(["9"]);
    setControl(f, "field-challenge-rating", "1");
    expect(controlById(f, "field-challenge-rating").values).toEqual(["5"]);
  });

  it("prefers an exact-case label over a case-variant duplicate", () => {
    const f = form();
    setControl(f, "field-monster-tags-public", ["Devil"]);
    expect(controlById(f, "field-monster-tags-public").values).toEqual(["58"]);
    expect(() => setControl(f, "field-monster-tags-public", ["DEVIL"])).toThrow(/ambiguous.*30.*58/);
  });

  it("refuses true duplicate labels unless the caller names the option value", () => {
    const f = parseForm(`<form action="/x/create"><select id="field-tool" name="tool" multiple>
      <option value="3952">Thieves' Tools</option><option value="4218">Thieves' Tools</option><option value="1">Lute</option></select></form>`, /create$/);
    expect(() => setControl(f, "field-tool", ["Thieves' Tools"])).toThrow(/ambiguous.*3952.*4218.*{ value }/);
    setControl(f, "field-tool", [{ value: "4218" }, "Lute"]);
    expect(controlById(f, "field-tool").values).toEqual(["4218", "1"]);
    expect(() => setControl(f, "field-tool", [{ value: "9" }])).toThrow(/no option with value "9"/);
  });

  it("rejects unknown labels with the valid list, and type mismatches", () => {
    const f = form();
    expect(() => setControl(f, "field-stat-block-type", "6e")).toThrow(/Options: 5e, 5\.5e/);
    expect(() => setControl(f, "field-stat-block-type", ["5e", "5.5e"])).toThrow(/single value/);
    expect(() => setControl(f, "field-is-legendary", "y")).toThrow(/boolean/);
    expect(() => setControl(f, "field-nope", "x")).toThrow(/no control #field-nope/);
  });

  it("addresses hashed-name inputs by their stable id; checkboxes take booleans", () => {
    const f = form();
    setControl(f, "field-strength", 18);
    setControl(f, "field-is-legendary", true);
    expect(controlById(f, "field-strength").values).toEqual(["18"]);
    expect(controlById(f, "field-is-legendary").values).toEqual(["y"]);
  });
});

describe("clearControl", () => {
  it("returns selects to blank, multis to none, boxes unchecked, text empty", () => {
    const f = form();
    setControl(f, "field-challenge-rating", "5");
    setControl(f, "field-monster-tags-public", ["Devil"]);
    setControl(f, "field-is-legendary", true);
    setControl(f, "field-strength", 9);
    for (const id of ["field-challenge-rating", "field-monster-tags-public", "field-is-legendary", "field-strength"]) clearControl(f, id);
    expect(controlById(f, "field-challenge-rating").values).toEqual([""]);
    expect(controlById(f, "field-monster-tags-public").values).toEqual([]);
    expect(controlById(f, "field-is-legendary").values).toEqual([]);
    expect(controlById(f, "field-strength").values).toEqual([""]);
  });
});

describe("encodeForm", () => {
  it("multipart: every control under its live name, an empty file part, no button", async () => {
    const f = form();
    setControl(f, "field-Name", "Imp");
    setControl(f, "field-strength", 6);
    const fd = encodeForm(f) as FormData;
    expect(fd.get("Name")).toBe("Imp");
    expect(fd.get("fdb5c7a032c23a7a838c75d97c320e99b")).toBe("6");
    expect(fd.get("authenticity-token")).toBe("tok2");
    expect(fd.has("is-legendary")).toBe(false);
    const file = fd.get("f927defcccf4c9e7440cff7eb7ef347dd") as File;
    expect(file.size).toBe(0);
    expect(file.name).toBe("");
  });

  it("urlencoded for plain forms", () => {
    const sub = parseForm(`<form method="post" action="/monster/senses/create/1">
      <input type="hidden" name="security-token" value="t" />
      <select id="field-sense" name="sense"><option value="">—</option><option value="2">Darkvision</option></select>
      <input type="text" id="field-sense-note" name="sense-note" value="" /></form>`, /create\//);
    setControl(sub, "field-sense", "Darkvision");
    setControl(sub, "field-sense-note", "60 ft.");
    expect(String(encodeForm(sub))).toBe("security-token=t&sense=2&sense-note=60+ft.");
  });
});

describe("formErrors", () => {
  it("maps each visible error to its control id and field label", () => {
    expect(formErrors(PAGE)).toEqual([{ id: "field-Name", label: "Monster Name", message: "This field is required." }]);
  });
});
