# D&D Beyond roll pump — live game-log capture

Captures a D&D Beyond campaign's **live dice rolls** into a drainable buffer. Built for the
**orphaned-character** case: a PC whose player rolls on D&D Beyond but has no Beyond20
bridge, so their rolls never reach the VTT. Fully browserless — reuses the same cobalt→JWT
the other DDB reads use.

**This server only captures.** Bridging a roll into a VTT (e.g. Roll20 chat via
roll20-dm-mcp's `post_roll_as_character`) is the consumer's job — typically the gem, which
drains `ddb_poll_rolls` (or the HTTP entry's `/events` SSE stream) and posts each roll.

## Transport (all verified live; spiked in roll20-dm-mcp's `src/recon/ddb-gamelog-*.ts`)

```
JWT (auth-service/cobalt-token, ~300s ttl, same as character-service reads)
 │  Bearer                                    │  stt=<JWT> query param
 ▼                                            ▼
REST backfill (dedup seed)                    WebSocket (live push)
game-log-rest-live.dndbeyond.com              wss://game-log-api-live.dndbeyond.com
  /v1/getmessages?gameId=&userId=               /v1?gameId=&userId=&stt=
```

- **Bearer authorizes; cookie/none get 401** ("token missing"). Proven browserless.
- The WS pushes each event as one JSON frame; we keep `eventType === "dice/roll/fulfilled"`.
- `userId` is the JWT's `nameidentifier` claim (`rtAuthToken()` in `ddb-rt.ts`).

## Message shape (only what we consume)

```jsonc
{
  "id": "<uuid>",                    // dedup key
  "dateTime": "1784681529261",       // epoch ms (string)
  "entityId": "130003005",           // the rolling character → the filter key
  "eventType": "dice/roll/fulfilled",
  "data": {
    "action": "Elemental Cleaver",   // header
    "context": { "name": "Broo Zbaaner" },   // speaker
    "rolls": [{
      "rollType": "Force",
      "diceNotationStr": "5d8",       // OFTEN ABSENT — reconstruct from diceNotation (rollNotation())
      "diceNotation": { "constant": 0, "set": [{ "count": 5, "dieType": "d8" }] },
      "result": { "total": 25, "text": "7+1+5+8+4", "values": [7,1,5,8,4] }
    }]
  }
}
```

## Beyond20 gap-fill (the default mode)

Beyond20 sets `data.__b20Override__: true` on every roll it bridges to the VTT — i.e.
rolls that ALREADY reached the table. Verified live across three games: players on
Beyond20 carry it on every roll; players rolling in the native DDB tray never do; a
flaky bridge yields a mix (e.g. one 8th-St player: 6 bridged, 2 dropped).

So the pump SKIPS `__b20Override__` rolls by default (`skipBeyond20`, exposed on the
tool as `includeBeyond20:false`). That makes it a **gap-filler**, not a mirror:

- A working Beyond20 → flagged → skipped. Only its *failures* come through.
- A flapping bridge → its dropped rolls surface, its delivered ones don't. No manual
  start/stop needed.
- Safe to arm **table-wide** (omit `characterNames`): only the orphaned rolls — the
  exact ones missing from the table — get captured.

Set `includeBeyond20:true` to capture every roll regardless (bridging then double-posts
anything Beyond20 also delivered — rarely wanted).

## Mirror, never re-roll

DDB has already determined the dice. Consumers must render the *actual* values
(`result.total`, `result.text`, `rollNotation()`) — a fresh VTT-side roll would invent
different numbers. For Roll20 specifically that means plain text, no `[[…]]` inline-roll
syntax (Roll20 would re-roll it); the Roll20 rendering lives with roll20-dm-mcp's
`post_roll_as_character`.

## Reconnect & backoff (roll20-dm-mcp#166)

The pump reconnects with a fresh JWT ~40s before the ~300s token lapses, and on any
abnormal close (observed `1006`) with the `BACKOFF_MS` ladder. Crucially the failure
counter resets only on a **proven-healthy** connection — a received frame, or an open
surviving `HEALTHY_AFTER_MS` (15s) — never on the bare `open` event, because DDB accepts
the WS upgrade before dropping a bad session; resetting on `open` once turned the ladder
into a fixed 1s retry storm (~90 reconnects → HTTP 429). `pump.status()` distinguishes
`connected` from `retrying` with the consecutive-failure count and last error, and
`ddb_roll_pump_status` reports exactly that. Pinned by `src/bridge/ddb-gamelog.test.ts`.

The dedup set is seeded from REST history on start so a reconnect's replay never
double-emits.

## Consuming

| Surface | How |
|---|---|
| `ddb_poll_rolls` (MCP tool) | Cursor-based drain: pass the previous response's `cursor` as `after`. Response includes a `missed` count if the 500-entry ring evicted rolls the cursor never saw. |
| `GET /events` (HTTP entry only) | SSE push (`event: roll`), bearer-authed. Same payload plus a `summary` line. |

## Known / future

- **WS-only push** — the game log only pushes NEW events; history is REST. The pump seeds
  dedup from REST but does not backfill old rolls into the buffer (by design).
- **Realtime-only tuning** — no safety poll; if the WS silently wedged between reconnects a
  roll could be missed. A low-frequency `getmessages` reconciler is the obvious hardening.
- **Roll buffer is in-memory** — a server restart loses undrained rolls.
