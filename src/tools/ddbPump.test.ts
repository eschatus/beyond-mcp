import { describe, it, expect } from "vitest";
import { matchByName } from "./ddbPump.js";
import type { RtCampaignCharacter } from "../bridge/ddb-rt.js";

const char = (id: number, characterName: string): RtCampaignCharacter =>
  ({ id, characterName, characterAvatarUrl: null });

describe("matchByName", () => {
  const roster = [char(111, "Broo Zbaaner"), char(222, "Kaila"), char(333, "Kairon")];

  it("matches an exact name, case- and whitespace-insensitively", () => {
    expect(matchByName(roster, "  broo zbaaner ").hit?.id).toBe(111);
  });

  it("matches a unique partial name in either direction", () => {
    expect(matchByName(roster, "Zbaaner").hit?.id).toBe(111);
    expect(matchByName(roster, "Kaila the Bold").hit?.id).toBe(222);
  });

  it("prefers an exact match over a longer name that contains it", () => {
    const withPrefix = [char(1, "Kai"), char(2, "Kaila")];
    expect(matchByName(withPrefix, "Kai").hit?.id).toBe(1);
  });

  // Was: find() silently returned whichever came first.
  it("reports ambiguity instead of guessing", () => {
    const { hit, candidates } = matchByName(roster, "Kai");
    expect(hit).toBeUndefined();
    expect(candidates.map((c) => c.id)).toEqual([222, 333]);
  });

  // Regression: `"broo".includes("")` is true, so a nameless roster entry absorbed every
  // request — the pump armed on the wrong entityId and reported success.
  it("ignores roster entries with blank names", () => {
    const withBlank = [char(999, ""), char(998, "   "), char(111, "Broo Zbaaner")];
    expect(matchByName(withBlank, "Broo Zbaaner").hit?.id).toBe(111);
  });

  it("never matches on an empty request", () => {
    expect(matchByName(roster, "   ").hit).toBeUndefined();
    expect(matchByName(roster, "   ").candidates).toEqual([]);
  });

  it("returns no hit when nothing matches", () => {
    const { hit, candidates } = matchByName(roster, "Nobody");
    expect(hit).toBeUndefined();
    expect(candidates).toEqual([]);
  });
});
