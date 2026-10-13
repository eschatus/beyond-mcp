import { describe, it, expect } from "vitest";
import { embeddedSubTypes, resolveSubType, embeddedSubTypeValue, fillModifierForm } from "./ddb-homebrew-core.js";
import { parseForm, encodeForm, controlById } from "./html-form.js";

// Shape captured live from /modifier/create/… pages (2026-10-12), trimmed.
const PAGE = `<script> var data = [[{"id":1,"name":"Armor Class","type":1},{"id":51,"name":"Fire","type":2},{"id":134,"name":"Fire","type":5},
{"id":171,"name":"Darkvision","type":8},{"id":1846,"name":"Birdfolk","type":11},{"id":1847,"name":"Birdfolk","type":11},{"id":391,"name":"Aarakocra","type":11}]];
var subTypes = [[{"id":1,"name":"Armor Class","type":1},{"id":51,"name":"Fire","type":2},{"id":134,"name":"Fire","type":5},
{"id":171,"name":"Darkvision","type":8},{"id":1846,"name":"Birdfolk","type":11},{"id":1847,"name":"Birdfolk","type":11},{"id":391,"name":"Aarakocra","type":11}]];
var typesValue = 8; var subTypesValue = 171; </script>`;

describe("modifier subtypes", () => {
  const subs = embeddedSubTypes(PAGE);

  it("parses the inline catalogue", () => {
    expect(subs).toHaveLength(7);
    expect(() => embeddedSubTypes("<html></html>")).toThrow(/no inline subTypes/);
  });

  it("resolves a name within its modifier type only", () => {
    expect(resolveSubType(subs, 2, "Fire")).toBe(51);
    expect(resolveSubType(subs, 5, "fire")).toBe(134);
    expect(() => resolveSubType(subs, 8, "Aarakocra")).toThrow(/not a subtype of modifier type 8. Valid: Darkvision/);
  });

  it("refuses ambiguous names and mismatched ids", () => {
    expect(() => resolveSubType(subs, 11, "Birdfolk")).toThrow(/ambiguous.*1846, 1847/);
    expect(resolveSubType(subs, 11, 1847)).toBe(1847);
    expect(() => resolveSubType(subs, 8, 391)).toThrow(/does not belong to modifier type 8/);
  });

  it("reads an edit page's current subtype from the script", () => {
    expect(embeddedSubTypeValue(PAGE)).toBe(171);
    expect(embeddedSubTypeValue("var subTypesValue = 0;")).toBeNull();
  });
});

describe("fillModifierForm", () => {
  const formHtml = (extra: string) => `<form method="post" action="/modifier/create/9-112130694/0">
    <select id="field-spell-modifier-type" name="spell-modifier-type"><option value="">—</option><option value="1">Bonus</option><option value="2">Damage</option><option value="8">Sense</option></select>
    <select id="field-spell-modifier-sub-type" name="spell-modifier-sub-type"><option value="">—</option></select>
    <select id="field-dice-value" name="dice-value"><option value="">—</option><option value="6">d6</option></select>
    <input id="field-dice-count" name="dice-count" value="" /><input id="field-fixed-value" name="fixed-value" value="" />
    ${extra}</form>${PAGE}`;

  it("resolves the subtype within the chosen type and posts it raw", () => {
    const html = formHtml("");
    const f = parseForm(html, /modifier\/create/);
    expect(fillModifierForm(f, html, { type: "Damage", subType: "Fire", dice: { count: 1, die: 6 } })).toEqual({ typeId: 2, subTypeId: 51 });
    expect(String(encodeForm(f))).toBe("spell-modifier-type=2&spell-modifier-sub-type=51&dice-value=6&dice-count=1&fixed-value=");
  });

  it("unchecks a pre-checked owner extra unless asked, and rejects extras the form lacks", () => {
    const html = formHtml(`<input type="checkbox" id="field-requires-attunement" name="requires-attunement" value="y" checked />`);
    const f = parseForm(html, /modifier\/create/);
    fillModifierForm(f, html, { type: "Sense", subType: "Darkvision" });
    expect(controlById(f, "field-requires-attunement").values).toEqual([]);
    const g = parseForm(formHtml(""), /modifier\/create/);
    expect(() => fillModifierForm(g, formHtml(""), { type: "Sense", subType: "Darkvision", availableToMulticlass: true })).toThrow(/no availableToMulticlass/);
  });
});
