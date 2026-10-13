import { describe, it, expect, afterEach } from "vitest";
import { pong } from "./meta.js";
import { VERSION } from "../version.js";

const orig = process.env.DDB_WRITES;
afterEach(() => { if (orig === undefined) delete process.env.DDB_WRITES; else process.env.DDB_WRITES = orig; });

describe("ddb_ping handshake", () => {
  it("reports name, the build version, and always-on capabilities", () => {
    delete process.env.DDB_WRITES;
    const p = pong();
    expect(p).toMatchObject({ pong: true, server: "beyond-mcp", version: VERSION });
    expect(p.capabilities.rollPump).toBe(true);
    expect(p.capabilities.partySnapshot).toBe(true);
    expect(p.capabilities.writes).toBe(false);
    expect(p.capabilities.homebrewMonsters).toBe(false);
    expect(p.capabilities.homebrewList).toBe(true);
    expect(p.capabilities.homebrewTypes).toEqual([]);
  });

  it("reflects DDB_WRITES=enabled in capabilities.writes", () => {
    process.env.DDB_WRITES = "enabled";
    expect(pong().capabilities.writes).toBe(true);
    expect(pong().capabilities.homebrewMonsters).toBe(true);
    expect(pong().capabilities.homebrewTypes).toContain("subclass");
  });

  it("version tracks the package build so consumers can floor it", () => {
    expect(pong().version).toBe(VERSION);
    expect(pong().version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
