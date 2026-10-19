import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";

// Cookie resolution reads env + <DDB_DATA_DIR>/ddb-cobalt.json and caches in module state,
// so each test re-imports ddb-rt fresh. rtSiteSession() resolves the cookie synchronously
// and seeds its jar with it — the cheapest no-network probe of getCobalt().
const cobaltFile = () => path.join(process.env.DDB_DATA_DIR!, "ddb-cobalt.json");
const load = async () => { vi.resetModules(); return import("./ddb-rt.js"); };

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.DDB_COBALT;
  delete process.env.DDB_COBALT;
  mkdirSync(process.env.DDB_DATA_DIR!, { recursive: true });
  if (existsSync(cobaltFile())) rmSync(cobaltFile());
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.DDB_COBALT; else process.env.DDB_COBALT = savedEnv;
  if (existsSync(cobaltFile())) rmSync(cobaltFile());
});

describe("CobaltSession resolution", () => {
  it("reads the cookie from ddb-cobalt.json", async () => {
    writeFileSync(cobaltFile(), JSON.stringify({ cookie: "from-file", harvestedAt: 1 }));
    const rt = await load();
    expect(rt.rtSiteSession().cookie("CobaltSession")).toBe("from-file");
  });

  it("accepts a file written with a UTF-8 BOM (PowerShell 5.1 Out-File)", async () => {
    writeFileSync(cobaltFile(), "\uFEFF" + JSON.stringify({ cookie: "bom-file" }), "utf-8");
    const rt = await load();
    expect(rt.rtSiteSession().cookie("CobaltSession")).toBe("bom-file");
  });

  it("prefers DDB_COBALT over the file", async () => {
    writeFileSync(cobaltFile(), JSON.stringify({ cookie: "from-file" }));
    process.env.DDB_COBALT = "from-env";
    const rt = await load();
    expect(rt.rtSiteSession().cookie("CobaltSession")).toBe("from-env");
  });

  it("reports absent, with harvester-neutral instructions, when nothing is supplied", async () => {
    const rt = await load();
    let err: unknown;
    try { rt.rtSiteSession(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(rt.CobaltUnavailableError);
    expect((err as Error).message).toMatch(/no D&D Beyond session cookie is available/);
    expect((err as Error).message).toContain("DDB_COBALT");
    expect((err as Error).message).toContain(cobaltFile());
    expect((err as Error).message).not.toMatch(/\bgem\b/);
  });

  it("fails loud on invalid JSON instead of reporting the cookie absent", async () => {
    writeFileSync(cobaltFile(), "{ cookie: not-json");
    const rt = await load();
    let err: unknown;
    try { rt.rtSiteSession(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(rt.CobaltUnavailableError);
    expect((err as Error).message).toMatch(/exists but is unusable: not valid JSON/);
    expect((err as Error).message).not.toMatch(/is available/);
  });

  it("fails loud when the file has no usable cookie field", async () => {
    writeFileSync(cobaltFile(), JSON.stringify({ CobaltSession: "wrong-key" }));
    const rt = await load();
    expect(() => rt.rtSiteSession()).toThrow(/no non-empty string "cookie" field/);
  });

  it("a malformed file doesn't matter when DDB_COBALT is set", async () => {
    writeFileSync(cobaltFile(), "garbage");
    process.env.DDB_COBALT = "from-env";
    const rt = await load();
    expect(rt.rtSiteSession().cookie("CobaltSession")).toBe("from-env");
  });
});
