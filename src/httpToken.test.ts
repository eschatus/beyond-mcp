import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAuthToken } from "./httpToken.js";

describe("resolveAuthToken", () => {
  let dir: string;
  let envPath: string;
  const saved = process.env.DDB_MCP_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "beyond-mcp-token-"));
    envPath = join(dir, ".env");
    delete process.env.DDB_MCP_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.DDB_MCP_TOKEN;
    else process.env.DDB_MCP_TOKEN = saved;
  });

  it("prefers the process env and touches no file", () => {
    process.env.DDB_MCP_TOKEN = "from-env";
    expect(resolveAuthToken(envPath)).toEqual({ token: "from-env", generated: false });
    expect(() => readFileSync(envPath, "utf-8")).toThrow();
  });

  // The lockout regression: launched from a cwd where dotenv found no .env, the env var is
  // unset while the server's own .env already holds a token. Returning a fresh token here
  // enforced a secret that existed nowhere, 401-ing every client that used the real one.
  it("returns the token already in .env when the env var is unset", () => {
    writeFileSync(envPath, "DDB_COBALT=abc\nDDB_MCP_TOKEN=already-issued\n", "utf-8");
    expect(resolveAuthToken(envPath)).toEqual({ token: "already-issued", generated: false });
    // and leaves the file untouched
    expect(readFileSync(envPath, "utf-8")).toBe("DDB_COBALT=abc\nDDB_MCP_TOKEN=already-issued\n");
  });

  it("strips quotes the way dotenv does, so both resolution paths agree", () => {
    writeFileSync(envPath, 'DDB_MCP_TOKEN="quoted-token"\n', "utf-8");
    expect(resolveAuthToken(envPath).token).toBe("quoted-token");
  });

  it("generates and persists a token when .env has none, appending to what's there", () => {
    writeFileSync(envPath, "DDB_COBALT=abc", "utf-8");   // no trailing newline
    const { token, generated } = resolveAuthToken(envPath);
    expect(generated).toBe(true);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(envPath, "utf-8")).toBe(`DDB_COBALT=abc\nDDB_MCP_TOKEN=${token}\n`);
  });

  it("generates when .env does not exist at all, and the next call reuses it", () => {
    const first = resolveAuthToken(envPath);
    expect(first.generated).toBe(true);
    const second = resolveAuthToken(envPath);
    expect(second).toEqual({ token: first.token, generated: false });
  });

  // A bare placeholder line (as .env.example ships) must not be mistaken for a token — and
  // once we append a real one below it, the next launch must find THAT, not regenerate forever.
  it("falls through a blank DDB_MCP_TOKEN= placeholder, then reuses what it wrote", () => {
    writeFileSync(envPath, "DDB_MCP_TOKEN=\n", "utf-8");
    const { token, generated } = resolveAuthToken(envPath);
    expect(generated).toBe(true);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveAuthToken(envPath)).toEqual({ token, generated: false });
  });
});
