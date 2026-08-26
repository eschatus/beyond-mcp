import { describe, it, expect } from "vitest";
import { CONDITIONS, CONDITION_IDS, CONDITION_NAMES_LOWER } from "./ddb-monster-tables.js";

// The three condition tables that used to be written out by hand are now one table plus two
// derived views. These pin the derivation — including the exact strings the two consumer
// surfaces emit, which are contract-pinned output shapes.
describe("condition tables", () => {
  it("derives both views from CONDITIONS, with nothing lost", () => {
    expect(Object.keys(CONDITION_NAMES_LOWER)).toHaveLength(15);
    expect(Object.keys(CONDITION_IDS)).toHaveLength(15);
  });

  it("round-trips id → lowercase name → id", () => {
    for (const [id, name] of Object.entries(CONDITIONS)) {
      expect(CONDITION_NAMES_LOWER[Number(id)]).toBe(name.toLowerCase());
      expect(CONDITION_IDS[name.toLowerCase()]).toBe(Number(id));
    }
  });

  it("keeps the ids the write API expects", () => {
    expect(CONDITION_IDS.blinded).toBe(1);
    expect(CONDITION_IDS.exhaustion).toBe(4);       // the one that carries a level
    expect(CONDITION_IDS.unconscious).toBe(15);
  });

  it("keeps monster output Title Case and character output lowercase", () => {
    expect(CONDITIONS[9]).toBe("Paralyzed");
    expect(CONDITION_NAMES_LOWER[9]).toBe("paralyzed");
  });
});
