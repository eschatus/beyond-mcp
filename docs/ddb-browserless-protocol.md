# D&D Beyond browserless protocol

Reverse-engineered auth + endpoints that let the DDB bridge run **without a headless browser**.
Everything is plain Node `fetch`. Implemented in [`src/bridge/ddb-rt.ts`](../src/bridge/ddb-rt.ts);
[`src/bridge/dndbeyond.ts`](../src/bridge/dndbeyond.ts) maps raw payloads to typed shapes.

Unlike its origin (roll20-dm-mcp, extracted per its issue #171), **this server never touches a
browser at all**: the `CobaltSession` cookie arrives from the `DDB_COBALT` env var or from
`<data dir>/ddb-cobalt.json`, written by whatever harvested it (the dm-whisper gem owns the
interactive harvest UX). Absent/expired cookie ⇒ loud error, no fallback.

## Auth chain

```
CobaltSession cookie  ──POST auth-service/v1/cobalt-token (Cookie header)──▶  JWT (ttl 300s)
JWT  ──Authorization: Bearer──▶  character-service / monster-service reads
JWT + CobaltSession cookie (both)  ──▶  www.dndbeyond.com campaign APIs
```

- `POST https://auth-service.dndbeyond.com/v1/cobalt-token`, header `Cookie: CobaltSession=<value>`,
  body `{}` → `{ token: <JWT>, ttl: 300 }`. The JWT is a 3-segment token, audience `dndbeyond.com`.
  **TTL is only 300s** — cached in memory with a ~30s margin and re-exchanged from the cobalt cookie.
- The `CobaltSession` cookie is the long-lived "remember me" session. On a 401/403 during exchange
  the sources (env, disk) are re-read once — the harvester may have written a fresh cookie — and if
  no *different* cookie is found the call fails with re-harvest instructions.

## Reads (all validated live, browserless)

| Read | Endpoint | Auth | Notes |
|------|----------|------|-------|
| Character sheet | `GET character-service.../character/v5/character/{id}` | Bearer | Raw sheet `.data`; `parseStats`/`getMaxHp` build on it. Shared sheets even read with no auth. |
| Monster by id | `GET monster-service.../v1/Monster?ids={id}` | Bearer | Raw monster-service shape — **normalized** to `DdbMonster` by `mapRawMonster` (see mapping below). |
| Monster by name | `GET monster-service.../v1/Monster?search={name}&skip=0&take=10` | Bearer | Returns ranked array; `rtGetMonster` prefers an exact (case-insensitive) name match. |
| Campaign characters | `GET www.dndbeyond.com/api/campaign/stt/active-short-characters/{campaignId}` | Bearer **+** cookie | `{data:[{id,name,avatarUrl,userId,userName}]}`. Cookie **alone** returns the SPA login HTML — both headers required. |
| All campaigns (the "set") | `GET www.dndbeyond.com/api/campaign/stt/active-campaigns` | Bearer **+** cookie | `{status:"success",data:[{id,name,dmUsername,playerCount,dmId,…}]}`. Same endpoint Avrae uses. Names are HTML-escaped → decode. |

### Dead endpoints
- `www.dndbeyond.com/api/v5/monster?name=…` **404s** (as of 2026-06-20). monster-service v1 is the
  only working monster transport; the old path was dropped in the extraction.

### Known limitation: 403 character sheets
DM-accessible sheets that reject direct API auth used a browser page-intercept workaround in
roll20-dm-mcp. That fallback was deliberately **not** carried here (browserless invariant);
`getCharacter` surfaces a 403 with instructions (make the sheet Public/Campaign, or use the
owner's cobalt).

### Avrae cross-check (github.com/avrae/avrae)
- Confirms `character-service.../character/v5` (`utils/config.py`) and `…/api/campaign/stt/active-campaigns`
  (`ddb/waterdeep.py`) — same endpoints/shapes.
- **Avrae is an official DDB integration partner**, so it does NOT do the client-side cobalt-token
  exchange — it *mints* its own JWTs signed with a shared `WATERDEEP_SECRET` (`ddb/auth.py`) and
  ingests live events via the partner **Game Log** (push-based, partner-gated). Our cobalt→JWT
  exchange is the correct *client* path; the game-log WebSocket (docs/ddb-gamelog-pump.md) is the
  client-reachable live-event surface.

### monster-service v1 → `DdbMonster` mapping
The monster-service ships ids, not friendly values. `getMonster` normalizes the raw record into
`DdbMonster` via **`mapRawMonster`** in `dndbeyond.ts`. The id→name lookup tables live in
**`src/bridge/ddb-monster-tables.ts`**, captured verbatim from DDB's `GET www.dndbeyond.com/api/config/json`
(stable 5e ruleset data, captured 2026-06-20; validated against the live Horned Devil id 16927):
- `challengeRatingId` → CR string via the baked `CR_VALUES` table (fractions render `"1/8"` etc.;
  the real table has gaps — e.g. id 28 is skipped — so it's baked, not computed).
- `stats[].statId` → `{id, value}` (1–6 = STR…CHA) so `getMonsterAbilityScores` is unchanged.
- `movements[].movementId` → `DdbMonsterSpeed` (`1 walk, 2 burrow, 3 climb, 4 fly, 5 swim`).
- `alignmentId`/`sizeId` → strings via the `ALIGNMENTS`/`SIZES` tables.
- `conditionImmunities` (id array) → names via the `CONDITIONS` table.
- `damageAdjustments` (id array) → resist/immune/vulnerable name lists, split by the entry's `type`
  (1/2/3). This is the one table that **drifts** as DDB adds content, so it's overlaid from a lazy
  7-day disk cache of `config/json` (`rtGetDamageAdjustments` in `ddb-rt.ts`, gated behind `peekCobalt`
  so a missing cookie silently skips it), with the baked `DAMAGE_ADJUSTMENTS` table as fallback.
- Ability sections are **HTML blobs** (`actionsDescription`, `specialTraitsDescription`, …) →
  parsed by `parseAbilityBlock` into the typed `DdbMonsterAbility[]` arrays, with numeric HTML
  entities (`&#160;`) decoded. `getMonsterAbilities` renders these as text.

Known data-quality note: a few DDB monster records (homebrew with unfilled fields) return
`averageHitPoints: 0` / `armorClass: 0`; the mapper passes them through faithfully — guard against
0 before using them.

## Writes — opt-in, browserless, verified live

D&D Beyond writes were originally out of scope (roll20-dm-mcp's read-only stance: Beyond20 owns
PC HP, sheet mutation should be deliberate). **Reversed 2026-08-25** (Adam) once the write surface
was proven live: character-service mutation routes accept the same cobalt→JWT bearer the reads
use — no browser, no separate auth. Writes are gated by `DDB_WRITES=enabled` (see
`src/tools/ddbWrite.ts`) so default installs stay read-only.

Auth chain is identical to reads (bearer JWT). Contract discovery pattern (used to verify each
route before shipping a wrapper): PUT/POST an **empty body** — character-service answers `400`
with a `data` array naming the required fields, e.g.
`["Missing required field: removedHitPoints", ...]`, which is the route's contract. A `GET` on a
mutation route returns `405`, confirming it exists and takes PUT/POST/DELETE.

Verified live (against a throwaway character):

| Change | Method | Route (on character-service `/character/v5/`) | Body | Response `data` |
|---|---|---|---|---|
| Set HP | PUT | `life/hp/damage-taken` | `{characterId, removedHitPoints, temporaryHitPoints}` | `{removedHitPoints, temporaryHitPoints}` |
| Apply condition | PUT | `condition` | `{characterId, id, level}` | `{conditions:[{id,level}], …}` |
| Remove condition | DELETE | `condition` | `{characterId, id, level}` | `{conditions:[…]}` |
| Create character | POST | `builder/standard-build` | `{showHelpText:false}` | new `characterId` |

**Write-test fixture:** character **170229415** ("Eschatus's Character") on the account behind
the cobalt cookie is a throwaway, kept deliberately as the target for live write verification —
mutate it freely, restore it to full/clean when done. Never test writes against a player-owned
or campaign sheet.

`removedHitPoints` is cumulative damage below max (0 = full); the site models damage/heal as
±removedHitPoints, so the HP primitive sets absolute values and the caller does the arithmetic
against a read. Applying an **already-present** condition returns a `400 "An unexpected error has
occurred"` (DDB quirk, not a bug here). The full mutation inventory (rests, inventory, currency,
build choices, descriptions, death saves, limited-use, spell slots…) is catalogued in
`docs/ddb-endpoint-atlas-notes.md`; wrappers are added to `ddb-write.ts` only as each body shape
is verified the same way.

## Config
- `DDB_COBALT=<cookie>` — supply the cobalt session directly.
- `DDB_DATA_DIR` — directory holding `ddb-cobalt.json` (harvester-written) and the monster-config
  cache. Point it at the gem's data dir to share the harvested cookie.
