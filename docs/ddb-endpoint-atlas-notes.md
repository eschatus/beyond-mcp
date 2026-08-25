# Endpoint Atlas — distilled findings

Source: the **D&D Beyond Endpoint Atlas** (private artifact, Browser Clanks recon of the live
site, 2026-08-25 — signed-in session, statuses observed **without** a bearer token:
https://claude.ai/code/artifact/fcde07ee-f9cc-4b49-acba-a163d96246ea). This file keeps only
what changes or confirms this server's plans; the artifact is the full reference.

## What overturns our prior conclusions

1. **A browserless spell compendium exists after all** (survey doc said spells were
   permanently out of reach):
   - `GET character-service…/character/v5/game-data/spells?classId=&classLevel=` → **200,
     public**. Both params required (400 with a useful error naming them otherwise). Sibling
     reads: `always-prepared-spells`, `always-known-spells` (same param contract).
   - The `/en` catalog's CMS feeds are public static JSON:
     `https://wizardsprod.a.bigcontent.io/v1/static/{set}` with
     `set ∈ class · species · background · feats · equipment · magical-items_1 · spells_1 · monsters`.
   - The whole `game-data/*` family is public: `classes`, `subclasses`, `races`,
     `racial-trait/collection`, `backgrounds`, `feats`, `items`, `monsters` (the sheet's
     creature list, distinct from monster-service), `themes`, `portraits`, …
2. **Much of DDB needs no auth at all.** monster-service is *entirely public* (5,953 records
   unauthenticated), as are `game-data/*`, `/api/config/json` (603 KB, 94 keys — conditions,
   damage types, weapons, armor, `rules`, `basicActions`, spell components, multiclass slot
   tables…), `/character/v5/rule-data` ("rules lookup tables the sheet renders against"),
   and public-privacy character sheets. Our fail-loud-without-cobalt stance is right for
   campaign/roster/game-log reads but stricter than necessary for compendium reads.

## What it confirms

- **Tooltip URLs are dead**: `data-tooltip-href="//www.dndbeyond.com/{type}/{id}-tooltip"`
  all 404 and the site never fetches them. Value: the attributes are a free entity-type+id
  index embedded in rules/glossary HTML. (Closes #6 q1's endpoint hope; #7 phase 2 should
  use game-data/Amplience instead.)
- **No spell/item/feat JSON *search*** — monsters remain the only compendium category with a
  real search endpoint. Listings for everything else are server-rendered HTML with a
  documented `filter-*` query grammar.
- **Character sheet has no computed AC field** (~70 top-level fields catalogued; AC absent) —
  #5's AC must be derived from stats/modifiers/inventory, matching what parseStats/Avrae do.
- **Encounter-builder monster ids = monster-service ids = web slugs** (16907 = Goblin).

## New surface worth knowing

- **monster-service v1 filtering** (public): working params `search, skip, take,
  monsterTypes, monsterSubTypes, sources, environments, alignments, languages, senses,
  conditionImmunities, damageImmunities, challengeRatingMax, armorClassMin,
  saveProficiencies, skillProficiencies, showHomebrew` (values are entity ids; repeat a key
  to OR). **Silently ignored**: `sizes, isLegendary, challengeRatings, crMin/crMax, sort,
  damageResistances, damageVulnerabilities`, etc. — always diff `pagination.total` against
  an unfiltered call before trusting a param. `?ids=` aborts rather than erroring (we use it
  in `rtGetMonster`; it worked live for us with bearer — the abort was observed cookie-only).
- **Rules text**: `/sources/{publisher}/{book}/{chapter}#{CamelCaseAnchor}` server-rendered;
  `/sources/dnd/br-2024/rules-glossary` is the canonical rules-lookup page. `/srd` exists.
- **Campaigns**: `www.dndbeyond.com/campaigns/v1/details/{gameId}` and
  `/campaigns/v1/{gameId}/characters` — a second roster surface besides the `stt` endpoints
  we use.
- **`characters/list`** (`/character/v5/characters/list`, bearer) — the signed-in user's own
  roster; a capability we don't expose yet.
- **The map's origin**: `media.dndbeyond.com/character-app/asset-manifest.json` is public
  and names every service URL for all six environments. Re-scrape referencing pages rather
  than pinning hashed bundle names.
- **Homebrew** shares the official id space (`isHomebrew`/`homebrewStatus` on
  monster-service records; `showHomebrew` filter) — no separate service.
- **Sheet mutation surface** is fully mapped (e.g. `life/hp/damage-taken`, `life/hp/bonus`,
  `condition`, `spell/prepared`, …) — recorded here ONLY to close the parent repo's open
  "HP endpoint name unknown" note. **This server stays read-only; none of these will ever
  be wired.**

## Not answered by the Atlas

- `character-service-scds…/v2` (the batched party snapshot, #4) was not observed — the walk
  didn't cover whatever page calls it. The #4 spike stands.
- Broo's displayed max HP (#5's 117-vs-131 ground truth) wasn't captured.
- No additional push surface beyond the game-log broker was catalogued (the
  `message-broker-client` bundle is the shared real-time transport — worth a read for #6 q8).

## Operating caution (from the Atlas, adopted here)

These endpoints are undocumented, some are gated by *subscription entitlements* rather than
auth, and they change between builds. Cache politely, keep request rates conversational —
which the gem/prep-time usage pattern already satisfies. Read-only remains the rule.
