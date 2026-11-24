// Offline smoke test for CI (and the clank's brief §3): spawn the built stdio server,
// check the version contract and that a default install registers no write tools.
// Makes no D&D Beyond call: initialize and tools/list never touch the network.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
const ver = readFileSync("src/version.ts", "utf8").match(/VERSION = "(.+)"/)?.[1];
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
if (pkg !== ver) fail(`package.json ${pkg} vs src/version.ts ${ver}`);

const env = { ...process.env };
delete env.DDB_WRITES;
delete env.DDB_COBALT;
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env });
const client = new Client({ name: "ci-smoke", version: "0" });
await client.connect(transport);
const info = client.getServerVersion();
const { tools } = await client.listTools();
await client.close();

if (info?.version !== pkg) fail(`serverInfo.version ${info?.version} != ${pkg}`);
const names = tools.map((t) => t.name);
const writes = names.filter((n) =>
  ["ddb_set_hp", "ddb_apply_condition", "ddb_remove_condition"].includes(n) ||
  (/_homebrew_/.test(n) && n !== "ddb_list_homebrew"));
if (writes.length) fail(`write tools registered without DDB_WRITES: ${writes.join(", ")}`);
if (!names.includes("ddb_ping")) fail("ddb_ping missing from tools/list");
console.log(`OK ${pkg}: serverInfo matches, ${names.length} tools, no write tools`);
