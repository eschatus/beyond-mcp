# ddb-mcp

Read-only D&D Beyond lookup MCP server: character sheets, monster statblocks, campaign
rosters, and a live game-log roll feed. Extracted from
[roll20-dm-mcp](https://github.com/eschatus/roll20-dm-mcp) per its issue #171 so DDB rides
behind its own MCP seam — the dm-whisper gem and Claude Code select it by config, next to
interchangeable VTT-primitive servers (roll20-dm-mcp today, forge-mcp/ddb-maps-mcp later).

**This server knows nothing about Roll20 or any VTT.** It never writes to D&D Beyond, and
it never opens a browser.

## Tools

| Tool | Does |
|---|---|
| `ddb_get_character` | Character sheet by numeric id — compact HP/AC/conditions snapshot; `full:true` adds the parsed stat sheet (abilities, saves, skills, initiative). |
| `ddb_get_monster` | Compendium monster by name or id — compact HP/AC/CR snapshot; `full:true` returns the whole statblock. |
| `ddb_list_campaigns` | Every campaign the account is in, with ids. |
| `ddb_list_campaign_characters` | `{id, name}` roster of a campaign. |
| `start_ddb_roll_pump` | Subscribe to a campaign's game-log WebSocket; capture fulfilled dice rolls into a bounded buffer. Skips Beyond20-bridged rolls by default (gap-fill mode). |
| `ddb_poll_rolls` | Cursor-based drain of captured rolls (raw message + one-line summary). Consumers mirror the actual dice values — never re-roll. |
| `stop_ddb_roll_pump` / `ddb_roll_pump_status` | Stop the pump / report connection health (CONNECTED vs RETRYING, failure count, last error). |

Tool names and default output shapes match what roll20-dm-mcp served, so existing callers
migrate by pointing at this server. The roll pump differs by design: it **buffers** instead
of posting to Roll20 — the gem drains it and bridges rolls via roll20-dm-mcp's
`post_roll_as_character`.

## Auth

Reads authenticate with the D&D Beyond `CobaltSession` cookie (exchanged for a short-lived
JWT; see [docs/ddb-browserless-protocol.md](docs/ddb-browserless-protocol.md)). The cookie
is **consumed, never harvested**: supply `DDB_COBALT` in the env, or point `DDB_DATA_DIR`
at the directory where the gem writes `ddb-cobalt.json`. Absent or expired cookie ⇒ every
read fails loudly with re-harvest instructions.

## Config

| Env | Meaning |
|---|---|
| `DDB_COBALT` | CobaltSession cookie value (overrides the data file). |
| `DDB_DATA_DIR` | Directory holding `ddb-cobalt.json` + caches. Point at the gem's data dir (roll20-dm-mcp's `ROLL20_DATA_DIR`) to share the harvested cookie. Default `./data`. |
| `DDB_CAMPAIGN_ID` | Default campaign for `ddb_list_campaign_characters` / `start_ddb_roll_pump`. |
| `DDB_HTTP_PORT` / `DDB_HTTP_HOST` / `DDB_MCP_TOKEN` | HTTP entry only (defaults 39210 / 127.0.0.1 / auto-generated into `.env`). |

## Running

```sh
npm install
npm run build
npm start            # stdio MCP server (Claude Code .mcp.json, gem supervised spawn)
npm run serve        # HTTP MCP server on /mcp + rolls SSE on /events (bearer-authed)
```

Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "ddb": { "command": "node", "args": ["E:/personalProjects/ddb-mcp/dist/index.js"] }
  }
}
```

## Development

```sh
npm test             # vitest run
npx vitest run src/bridge/ddb-gamelog.test.ts   # one file
npm run lint
npm run dev          # tsx watch, stdio
```

Node 20+, TypeScript (NodeNext ESM), vitest — same conventions as roll20-dm-mcp.
