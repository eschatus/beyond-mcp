import { describe, it, expect } from "vitest";
import { decodeEntities } from "./html.js";

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    expect(decodeEntities("Wizards 3&amp;4")).toBe("Wizards 3&4");
    expect(decodeEntities("&lt;b&gt; &quot;x&quot; &rsquo;y&rsquo;")).toBe("<b> \"x\" 'y'");
    expect(decodeEntities("a&mdash;b&ndash;c")).toBe("a—b–c");
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeEntities("nbsp:&#160;.")).toBe("nbsp: .");
    expect(decodeEntities("&#x2014;")).toBe("—");
    expect(decodeEntities("&#128512;")).toBe("😀");   // astral plane, above 0xFFFF
  });

  // Regression: String.fromCodePoint throws RangeError above 0x10FFFF, so one malformed
  // entity in one homebrew statblock used to fail the entire ddb_get_monster call.
  it("leaves an out-of-range numeric entity as literal text instead of throwing", () => {
    expect(() => decodeEntities("junk:&#9999999;")).not.toThrow();
    expect(decodeEntities("junk:&#9999999;")).toBe("junk:&#9999999;");
    expect(decodeEntities("junk:&#xFFFFFFF;")).toBe("junk:&#xFFFFFFF;");
    // and a good entity alongside a bad one still decodes
    expect(decodeEntities("&#160;&#9999999;&amp;")).toBe(" &#9999999;&");
  });

  it("is the same decoder for names as for statblocks (names used to decode worse)", () => {
    expect(decodeEntities("Wizards&nbsp;3")).toBe("Wizards 3");
  });
});
