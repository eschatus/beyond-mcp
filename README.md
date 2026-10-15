# beyond-mcp

A read-first **D&D Beyond MCP server**: character sheets, monster statblocks, campaign
rosters, a precomputed party combat snapshot, a live game-log dice feed, and opt-in sheet
writes. Browserless, VTT-agnostic, MIT.

It is a **primitive**, not an assistant. It has no LLM inside it, knows nothing about
Roll20 or Foundry, and never opens a browser. Point any MCP client at it — Claude Code, an
agent framework, your own harness — and it answers D&D Beyond questions with D&D Beyond's
own numbers.

```
                            ┌─ character sheets  (character-service v5)
                            ├─ monsters          (monster-service v1)
MCP client ──▶ beyond-mcp ──┼─ party snapshot    (SCDS, batched)
 (stdio or HTTP)   │        └─ live dice rolls   (game-log WebSocket)
                   └─ auth: CobaltSession cookie ─▶ 300s JWT
```

> Formerly `ddb-mcp`; renamed before going public to avoid a collision with the unrelated
> [ddb-mcp/ddb-mcp](https://github.com/ddb-mcp/ddb-mcp). Tool names (`ddb_*`), env vars
> (`DDB_*`) and the `ddb-cobalt.json` filename were deliberately left unchanged.

## Three stances that shape everything else

**It consumes a session cookie; it never harvests one.** Cookie capture is interactive — it
needs a logged-in browser and a human when that fails — so it belongs in whatever app has a
user in front of it. This server takes the cookie from `DDB_COBALT` or a file on disk and
fails loudly when it is missing or expired. There is no Playwright dependency, no silent
fallback, and no credential-capture surface here at all — which is what made publishing it
reasonable.

**It knows nothing about any VTT.** The roll pump *buffers* raw game-log messages; posting
one into Roll20 chat or a Foundry board is the caller's job. Helpers stay neutral
(`summarizeRoll`). Consumers put an adapter in front of this server rather than asking it to
be generic — a half-generic server is a leaky shared kernel, where one VTT's idioms escape
into something labelled neutral and the next backend inherits them.

**Reads are always on; writes are opt-in and are primitives.** The three mutation tools
register **only** when the deployment sets `DDB_WRITES=enabled`, so a default install and
any prep-time use stay read-only. When enabled they effect exactly the change asked on
whatever character id they are given, with no policy about who owns the sheet — the caller
owns intent. D&D Beyond PC HP already has two writers the table can see (Beyond20 and the
player), so a write here races them, last-writer-wins. That makes them deliberate acts, not
an automation loop.

## Quick start

```sh
npm install
npm run build

export DDB_COBALT='<your CobaltSession cookie value>'
npm start            # stdio MCP server
# or
npm run serve        # HTTP MCP on :39210/mcp, rolls SSE on /events
```

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "beyond": {
      "command": "node",
      "args": ["/path/to/beyond-mcp/dist/index.js"],
      "env": { "DDB_COBALT": "...", "DDB_CAMPAIGN_ID": "1234567" }
    }
  }
}
```

Call `ddb_ping` first — it reports the version and which capabilities this instance exposes.

## Tools

### Handshake

| Tool | Returns |
|---|---|
| `ddb_ping` | `{pong, server, version, capabilities: {writes, rollPump, partySnapshot}}`. Assert `version` meets your minimum (semver) before relying on newer tools. Fields are **additive-only** — never removed or repurposed — so an older consumer's parse never breaks. |

### Reads (always registered)

| Tool | Does |
|---|---|
| `ddb_get_character` | Character sheet by numeric id. Default: compact HP / AC / temp HP / conditions. `full:true` adds the parsed stat sheet — ability scores and mods, saves, skills, initiative, speed. |
| `ddb_get_party_snapshot` | **The authoritative combat read.** One batched call to D&D Beyond's SCDS service returns the site's own *precomputed* AC, max/current/temp HP, named conditions, death saves, initiative, passives and level for a whole party. `full:true` adds resolved attacks (to-hit + damage dice), casting info, abilities, skills, senses, resistances/immunities. Pass `characterIds`, or a `campaignId` to snapshot its whole roster. |
| `ddb_get_monster` | Compendium monster by name or numeric id. Default: compact HP / AC / CR. `full:true` returns the whole statblock — ability scores, speed, traits/actions/reactions, resistances/immunities, art URL. A name lookup prefers an exact case-insensitive match over the ranked search results. |
| `ddb_list_campaigns` | Every campaign the account is in, as DM or player, with ids and player counts. |
| `ddb_list_campaign_characters` | `{id, name}` roster for a campaign. |

#### Which character read to use

Prefer `ddb_get_party_snapshot` for anything the table acts on. The raw v5 character sheet
carries neither AC nor max HP in *computed* form, so the compact `ddb_get_character` path
derives max HP from the character's **raw** CON, before racial, item and override
modifiers — which undercounts for any boosted CON (verified live against a level-14
Barbarian: 117 against SCDS's 131, a gap matching exactly `(final CON mod − raw CON mod) ×
level`), and falls back to AC 10 where the payload carries no computed armour class at all.
Tracked as [#5](https://github.com/eschatus/beyond-mcp/issues/5); the snapshot is the
documented answer. Both bugs predate this repo — inherited at extraction, and only caught
when the snapshot work forced a side-by-side comparison.

### Roll pump (always registered)

Subscribes browserless to a campaign's game-log WebSocket and captures **fulfilled** dice
rolls. Built for the orphaned-character case: a player rolls on D&D Beyond with no Beyond20
bridge, so their rolls never reach the table.

| Tool | Does |
|---|---|
| `start_ddb_roll_pump` | Arm the pump on a campaign, table-wide or for named characters. Skips rolls Beyond20 already bridged (`data.__b20Override__`) unless `includeBeyond20:true`, so what you drain is exactly the gap Beyond20 left — safe to arm without double-posting downstream. |
| `ddb_poll_rolls` | Cursor drain: each roll's `seq`, a one-line summary and the raw game-log message, plus `cursor`, `missed`, and pump health. |
| `stop_ddb_roll_pump` | Disconnect. Buffered rolls stay drainable until the next start. |
| `ddb_roll_pump_status` | `CONNECTED` vs `RETRYING (n consecutive failures)`, capture count, uptime, last error. A climbing failure count usually means an expired cookie. |

Two details that matter to consumers:

- **Rolls carry D&D Beyond's actual dice values. Mirror them; never re-roll.** Re-rolling
  turns a player's crit into some other number on the board.
- **The buffer is deliberately shallow** — 10 rolls, then oldest-evicts. These are live
  table events, and a consumer returning from a long stall must not flood chat with stale
  rolls. `ddb_poll_rolls` reports `missed` rather than silently skipping them.

### Writes (only when `DDB_WRITES=enabled`)

| Tool | Does |
|---|---|
| `ddb_set_hp` | Set current and/or temp HP by absolute value — current clamped to `[0, max]`, omitted fields left alone. For "take 5 damage", read first, subtract, then set. |
| `ddb_apply_condition` | Apply a 5e condition by name (exhaustion takes `level` 1–6). |
| `ddb_remove_condition` | Remove one by name. |

Every write route's body shape is verified live against character-service before its tool
ships — POST an empty body, and the `400` names the required fields. No wrapper is added
for an unverified route.

## Auth

One credential: the long-lived D&D Beyond **`CobaltSession`** cookie, exchanged at
`auth-service/v1/cobalt-token` for a JWT with a 300-second TTL, refreshed with a margin so
no call races its expiry. The same JWT authenticates the game-log WebSocket (as `?stt=`).

Resolution order is `DDB_COBALT`, then `<data dir>/ddb-cobalt.json`. When the cookie is
absent or gets rejected, every read fails with a `CobaltUnavailableError` naming the file it
looked in and how to refresh it. The server never retries a cookie that was just rejected,
and never falls back to a browser.

Full protocol notes — the auth chain, every endpoint, the monster-service id→name mapping,
the game-log message shape, and Beyond20's `__b20Override__` semantics — are in
[docs/ddb-browserless-protocol.md](docs/ddb-browserless-protocol.md) and
[docs/ddb-gamelog-pump.md](docs/ddb-gamelog-pump.md).

## Config

| Env | Meaning |
|---|---|
| `DDB_COBALT` | CobaltSession cookie value. Takes precedence over the data file. |
| `DDB_DATA_DIR` | Directory holding `ddb-cobalt.json` and the monster-config cache. Point it at whatever directory your harvester writes to, so one credential is shared rather than two that expire independently. Default `./data`. |
| `DDB_CAMPAIGN_ID` | Default campaign for `ddb_list_campaign_characters`, `ddb_get_party_snapshot` and `start_ddb_roll_pump`. |
| `DDB_WRITES` | `enabled` registers the write tools. Anything else, or unset, means reads only. |
| `DDB_HTTP_PORT` / `DDB_HTTP_HOST` | HTTP entry only. Default `39210` / `127.0.0.1`. |
| `DDB_MCP_TOKEN` | HTTP bearer token. Auto-generated into `.env` on first run if unset. |

See [.env.example](.env.example).

## HTTP transport

`npm run serve` runs a long-lived process that several clients can share: each `initialize`
mints its own session and `McpServer` instance, but tool state — the pump and the roll
buffer — is a module-level singleton **by design**, so one process owns the one game-log
WebSocket.

- `POST /mcp` — streamable HTTP MCP. Bearer-authed, with DNS-rebinding protection on and
  `Host`/`Origin` allowlisted to the configured host, so a malicious page cannot rebind a
  visitor's browser onto the local port.
- `GET /events` — SSE stream of captured rolls (`event: roll`), the push alternative to
  polling `ddb_poll_rolls`. Same bearer, 30-second keepalives.

The token check is constant-time. The server binds to `127.0.0.1` by default; expose it
beyond localhost only behind something you trust.

## Architecture

```
src/tools/ddb.ts        lookup tools ──▶ src/bridge/dndbeyond.ts   domain mapping (parseStats,
src/tools/ddbPump.ts    pump tools        │                         mapRawMonster, HP math)
src/tools/ddbWrite.ts   opt-in writes     │  src/bridge/ddb-scds.ts  batched party snapshot
src/tools/meta.ts       ddb_ping          ▼
     │                  src/bridge/ddb-rt.ts    auth (cobalt→JWT, ttl 300s) + raw fetches
     ▼                                    ▲     + 7-day damageAdjustments overlay cache
src/bridge/roll-buffer.ts  cursor ring    │
src/bridge/ddb-gamelog.ts  WS pump ───────┘
src/bridge/ddb-monster-tables.ts                baked id→name tables (CR, alignment, …)
```

Entry points are `index.ts` (stdio) and `index-http.ts` (HTTP); both build the same server
via `server.ts`. Raw D&D Beyond payloads stay `any` at the transport boundary — typed shapes
begin at the domain mappers in `dndbeyond.ts`.

The monster lookup tables (CR, alignment, size, movement, condition ids) are **baked in**,
because they do not change. The one that does — `damageAdjustments`, which accretes new ids
as D&D Beyond adds content — is fetched into a 7-day cache and overlaid on the baked table,
with the baked table as the offline fallback.

Reconnect backoff resets only on a **proven-healthy** connection: a frame received, or an
open socket surviving 15 seconds. Never on `open` alone — that lets a socket which opens and
immediately dies reset the backoff and hammer the server forever. The behaviour is pinned by
a test; preserve it if you touch the pump.

## Versioning is a consumer contract

`ddb_ping` and MCP `serverInfo` both announce `src/version.ts`'s `VERSION`. Consumers pin a
tag and **floor** the version against their own minimum, so a newer server is fine and only
an older one is a problem.

The handshake exists because a paired-constant version lock cannot catch the failure it is
for. `npm install` against a changed git ref does not re-resolve: the lockfile keeps the old
SHA and `node_modules` silently serves the old build, so a stale tree and a stale constant
agree and pass green. **A lock reports what was *fetched*; the handshake reports what is
*answering*.**

Releases are tagged `vX.Y.Z`, so consumers pin `github:eschatus/beyond-mcp#v0.4.1` rather
than a bare SHA. Adding a tool is a minor bump; `VERSION` and `package.json` move together.

## Where it came from

Extracted from [roll20-dm-mcp](https://github.com/eschatus/roll20-dm-mcp) in August 2026,
per that repo's issue #171. That server's competency is the Roll20 Mod relay; the D&D Beyond
bridge rode along inside it as a second reverse-engineered protocol with its own auth,
transport and failure modes. One repo, one protocol — so the bridge got its own, and
roll20-dm-mcp v2.0.0 dropped its `ddb_*` tools entirely. This is now the only home for these
reads.

Tool names and default output shapes are **pinned** to what roll20-dm-mcp served, so callers
migrated by pointing at this server. The `full` flags are additive; omit them and the
payloads are byte-compatible with the originals. Extend additively — never reshape a
default.

## Known gaps

Open issues, each with a scoped shape and no live-verified payload behind it yet:

- [#2](https://github.com/eschatus/beyond-mcp/issues/2) `ddb_get_character_actions` — the
  weapon/spell attack list, with to-hit and damage.
- [#3](https://github.com/eschatus/beyond-mcp/issues/3) `ddb_get_character_features` — class
  features, feats and racial traits text.
- [#5](https://github.com/eschatus/beyond-mcp/issues/5) — the inherited slim-path max-HP and
  missing-AC bugs described above.
- [#7](https://github.com/eschatus/beyond-mcp/issues/7) `ddb_lookup_spell` — "what is the
  text of Cloudkill?" without a manual search.

## Development

```sh
npm test                                        # vitest run
npx vitest run src/bridge/ddb-gamelog.test.ts   # one file
npm run lint
npm run dev                                     # stdio, tsx watch
npm run serve:watch                             # HTTP, tsx watch
```

Node 20+, TypeScript strict, NodeNext ESM (imports end in `.js`). Tests sit next to the code
as `src/**/*.test.ts` with mocked transports — **no live D&D Beyond calls in CI** — and
`test/setup.ts` isolates `DDB_DATA_DIR` per worker.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or connected to D&D Beyond, Wizards of the Coast or
Fandom. This server speaks to D&D Beyond's own web endpoints using your own account's
credential, on your behalf — respect their terms of service and your account's standing.
