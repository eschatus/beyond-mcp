// Shared-secret bearer token for the HTTP entry point, resolved from (in order) the
// process env, an existing DDB_MCP_TOKEN in the server's own .env, and only then a
// freshly generated one — which is written back so the next launch finds it.
//
// Reading the file is NOT redundant with dotenv. dotenv loads `cwd/.env`, but this
// server's .env sits beside the module, and MCP clients launch it by absolute path from
// an arbitrary cwd. In that case the env var is unset, so skipping the file read and
// minting a fresh token locked every client out: the token actually enforced existed
// nowhere — not in .env, not in the logs — while the startup line claimed it was saved.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const TOKEN_LINE = /^DDB_MCP_TOKEN=(.*)$/;

export interface ResolvedToken {
  token: string;
  /** True only when a new token was minted and written to .env — the first-run banner. */
  generated: boolean;
}

export function resolveAuthToken(envPath: string): ResolvedToken {
  const fromEnv = process.env.DDB_MCP_TOKEN;
  if (fromEnv) return { token: fromEnv, generated: false };

  let envContent = "";
  try { envContent = readFileSync(envPath, "utf-8"); } catch { /* no .env yet — first run */ }
  // Scan every line for the first NON-EMPTY value: a bare `DDB_MCP_TOKEN=` placeholder must
  // fall through to generation, and still be found on the next launch once we append below.
  // Surrounding quotes are stripped the way dotenv does, so both paths yield the same token.
  const existing = envContent
    .split(/\r?\n/)
    .map((line) => TOKEN_LINE.exec(line)?.[1].trim().replace(/^(['"])(.*)\1$/, "$2"))
    .find((value) => value);
  if (existing) return { token: existing, generated: false };

  const token = randomUUID();
  const prefix = envContent && !envContent.endsWith("\n") ? `${envContent}\n` : envContent;
  writeFileSync(envPath, `${prefix}DDB_MCP_TOKEN=${token}\n`, "utf-8");
  return { token, generated: true };
}
