# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Read-only D&D Beyond lookup MCP server, extracted from roll20-dm-mcp (its issue #171: reduce
that repo to Roll20 primitives, put DDB behind its own seam). Consumers: the dm-whisper gem
(live sessions) and Claude Code via the module-ingest skill (prep time). It serves character
/monster/campaign lookups and captures live game-log dice rolls into a drainable buffer.

## Invariants — do not violate

- **Read-only against D&D Beyond, permanently.** No write tools, no mutation calls. The write
  endpoints were probed and proven viable in roll20-dm-mcp and writes were still rejected as a
  design decision (Beyond20 owns PC HP; sheet mutation needs player consent). Don't revisit
  without Adam.
- **Never open a browser.** The CobaltSession cookie is consumed from `DDB_COBALT` or
  `<data dir>/ddb-cobalt.json`; the interactive harvest UX lives in the gem. When the cookie
  is absent/expired, fail loudly with re-harvest instructions (`CobaltUnavailableError` in
  ddb-rt.ts) — never add a silent fallback or a Playwright dependency.
- **No VTT knowledge.** Nothing Roll20- (or Foundry-) specific belongs here. The roll pump
  buffers raw game-log messages; rendering into a VTT (e.g. `post_roll_as_character` in
  roll20-dm-mcp) is the consumer's job. Keep helpers VTT-neutral (`summarizeRoll`).
- **Tool shapes are a contract.** `ddb_get_character` / `ddb_get_monster` / campaign
  listing default outputs match roll20-dm-mcp's originals so callers migrate seamlessly.
  Extend additively (like the `full` flags), never reshape defaults.
- Rolls captured by the pump carry DDB's actual dice values — consumers must mirror them,
  never re-roll. Keep tool descriptions saying so.

## Commands

```sh
npm test                                        # vitest run (all)
npx vitest run src/bridge/ddb-gamelog.test.ts   # single file
npm run build                                   # tsc → dist/
npm run lint
npm run dev                                     # stdio server, tsx watch
npm run serve                                   # HTTP server (:39210 /mcp, /events SSE)
```

## Architecture

```
src/tools/ddb.ts        lookup tools ──▶ src/bridge/dndbeyond.ts   domain mapping (parseStats,
src/tools/ddbPump.ts    pump tools        │                         mapRawMonster, HP math)
     │                                    ▼
     │                  src/bridge/ddb-rt.ts    auth (cobalt→JWT ttl 300s) + raw fetches
     ▼                                    ▲     + 7-day damageAdjustments overlay cache
src/bridge/roll-buffer.ts  cursor ring    │
src/bridge/ddb-gamelog.ts  WS pump ───────┘     (game-log WS takes the JWT as ?stt=)
src/bridge/ddb-monster-tables.ts                baked id→name tables (CR, alignment, …)
```

- Entry points: `index.ts` (stdio), `index-http.ts` (streamable HTTP + `/events` rolls SSE,
  bearer token auto-generated into `.env`). Both call `buildServer()` in `server.ts`.
- Tool/pump state (the pump singleton, the roll buffer) is module-level in
  `tools/ddbPump.ts` — shared across HTTP sessions by design.
- `dataDir.ts`: all disk state under `DDB_DATA_DIR` (default `./data`). Point it at the
  gem's data dir to share the harvested cookie; file name/shape (`ddb-cobalt.json`)
  is compatible with what roll20-dm-mcp wrote.
- Reconnect backoff resets only on a *proven-healthy* connection (frame received or open
  surviving 15s), not on `open` — the roll20-dm-mcp#166 lesson; pinned by
  `ddb-gamelog.test.ts`. Preserve this when touching the pump.
- Protocol details (endpoints, auth chain, monster-service id mapping, game-log message
  shape, Beyond20 `__b20Override__` gap-fill semantics): `docs/ddb-browserless-protocol.md`
  and `docs/ddb-gamelog-pump.md`. Read them before touching ddb-rt.ts or the pump.

## Conventions

- TypeScript strict, NodeNext ESM (imports end in `.js`), Node 20+.
- Raw DDB payloads are `any` at the transport boundary; typed shapes start at the domain
  mappers in `dndbeyond.ts`.
- Tests are `src/**/*.test.ts` next to the code (vitest, mocked transports — no live DDB
  calls in CI). `test/setup.ts` isolates `DDB_DATA_DIR` per worker.
- Origin: lifted from roll20-dm-mcp (sibling checkout at `E:\personalProjects\roll20-dm-mcp`).
  When a bug is found in shared-history code, check whether the parent still carries the
  same code before/after fixing here.
