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

## Writes — none, permanently

D&D Beyond is **read-only** in this server, as a design decision inherited from roll20-dm-mcp
(its docs/decisions.md §1): Beyond20 owns PC HP and would overwrite a push, and any live mutation
of a player's sheet should be a deliberate, consented action. roll20-dm-mcp's non-destructive
probe established that browserless writes *are* technically viable (the JWT bearer authenticates
against condition/death-save mutation endpoints); that record lives in the parent repo and is
kept out of this one on purpose. `rtRawFetch` exists for read diagnostics only.

## Config
- `DDB_COBALT=<cookie>` — supply the cobalt session directly.
- `DDB_DATA_DIR` — directory holding `ddb-cobalt.json` (harvester-written) and the monster-config
  cache. Point it at the gem's data dir to share the harvested cookie.
