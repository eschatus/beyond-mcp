import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.js";
import { HOMEBREW_WRITE_TYPES } from "./tools/meta.js";

const orig = process.env.DDB_WRITES;
afterEach(() => { if (orig === undefined) delete process.env.DDB_WRITES; else process.env.DDB_WRITES = orig; });

async function toolNames(): Promise<string[]> {
  const server = buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe("buildServer homebrew registration", () => {
  it("read-only install: the homebrew listing only, no homebrew writes", async () => {
    delete process.env.DDB_WRITES;
    const names = await toolNames();
    expect(names).toContain("ddb_list_homebrew");
    expect(names.filter((n) => /_homebrew_/.test(n) && n !== "ddb_list_homebrew")).toEqual([]);
  });

  it("DDB_WRITES=enabled: create/update/delete for every type ddb_ping advertises", async () => {
    process.env.DDB_WRITES = "enabled";
    const names = await toolNames();
    for (const type of HOMEBREW_WRITE_TYPES) {
      const t = type.replace("-", "_");
      for (const op of ["create", "update", "delete"]) expect(names).toContain(`ddb_${op}_homebrew_${t}`);
    }
  });
});
