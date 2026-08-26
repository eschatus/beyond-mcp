# Beyond20 primitives survey

Issue #1. A catalog of D&D Beyond read primitives worth adding to this server, using two
existing DDB integrations as requirements sources — **not** as code to copy from. For each
candidate: what the prior art does, which DDB surface actually serves it, whether it's
reachable with our cobalt→JWT client auth, a proposed tool shape, and a build/maybe/skip
verdict.

**No live DDB requests were made to produce this document** — no cookie is available in this
environment. Reachability calls are inferred from `docs/ddb-browserless-protocol.md`, from
cross-checking [Avrae](https://github.com/avrae/avrae) (a partner integration, public source)
and [ddb-importer](https://github.com/MrPrimate/ddb-importer) (an MIT-licensed FoundryVTT
module that also parses character-service v5 sheets), and from what the raw sheet our own
`rtGetRawCharacter` already fetches is known to contain. Every such claim is marked
**UNVERIFIED** with what a live probe needs to check.

## Prior art

### Beyond20 (github.com/kakaroto/Beyond20, GPL-3.0)

A browser extension that bridges D&D Beyond's character/monster/spell pages and dice
roller to Roll20, Foundry, and Discord. Surveyed at commit `a2dcad9` (HEAD of `master`,
2026-08-25). **License constraint honored**: this document describes protocols, DOM
selectors, and data shapes only. No Beyond20 code, comments, or distinctive structure was
copied into this (MIT) repo.

Beyond20's architecture turned out to be simpler than the issue anticipated: it is **almost
entirely a page-DOM scraper**, not a service-API client. Content scripts run in the logged-in
tab and read the rendered character/monster/spell/encounter pages with jQuery selectors
(`src/dndbeyond/base/character.js`, `monster.js`, `spell.js`, `extras.js`). The extension's
background script (`src/extension/background.js`) only routes `chrome.runtime` messages
between tabs — it makes no DDB network calls of its own. The one exception (spell tooltips,
below) is a same-page XHR whose URL is itself scraped from the DOM, not an independently
callable endpoint.

### ddb-mcp/ddb-mcp (github.com/ddb-mcp/ddb-mcp, MIT) — unrelated project, name collision

Not to be confused with this repo, which was originally named `ddb-mcp` too — that collision is
why this project was renamed to **beyond-mcp** when it went public (2026-08-26). It is a **Playwright browser-automation**
MCP server: interactive Wizards-ID login (`ddb_login`) persists a session to
`~/.config/ddb-mcp/session.json`, and every tool works by `page.goto()` + DOM scraping —
including search, which scrapes `https://www.dndbeyond.com/search?q=` and the
`/{spells|monsters|magic-items|races|classes|feats}?filter-search=` listing pages (selectors
like `.listing-body div.info[data-slug]`). Tool surface: `ddb_login`, `ddb_list_characters`,
`ddb_get_character`, `ddb_download_character`, `ddb_list_campaigns`, `ddb_get_campaign`,
`ddb_list_library`, `ddb_read_book`, `ddb_search`, `ddb_navigate`, `ddb_interact`,
`ddb_current_page`. Source layout: `src/auth.ts`, `src/browser.ts`,
`src/tools/{campaign,character,library,navigate,search}.ts`.

Because it's MIT, its code is license-compatible to study or even lift — but its entire
transport (headless-browser DOM automation) is exactly the invariant this repo refuses to
have (`CLAUDE.md`: "Never open a browser"). Its value here is purely as a **second catalog of
what DDB surfaces people want**: it independently confirms which reads are DOM-only (its
search, its `ddb_read_book`) and, where it scrapes something we already have a service API
for (monster search), it's a signal that a browser wasn't actually necessary there.

---

## Candidates

### 1. Spells (spell cards: casting time, range, components, damage/save, description)

**What the prior art does.** Beyond20's `src/dndbeyond/base/spell.js` builds a `Spell` object
by querying a DOM subtree (`.page-title`, `.ddb-statblock-item-{label} …-item-value` for
casting time/range/components/duration/level/school, `.spell-details .more-info-content` for
the description) — no network call. The one exception: `src/dndbeyond/base/monster.js` (lines
~793–818) and `extras.js` (lines ~733–737, the 2024 stat-block styles) inject a spell icon next
to inline spell links inside a monster/feature description; clicking it does
`$.get(spell_url, ...)` where `spell_url` comes from the link's own `data-tooltip-href`
attribute (`…-tooltip` rewritten to `…/tooltip`) and the response is `{Tooltip: "<html>"}` —
a JSON-wrapped HTML fragment, still parsed as DOM by the `Spell` constructor. ddb-mcp/ddb-mcp
has no spell-card tool at all; its `ddb_search` for spells scrapes
`dndbeyond.com/spells?filter-search=` listing HTML.

**DDB surface.** Page DOM (spell page, monster/feature description tooltip) for full spell
text, in both prior-art projects, with no exception that yields an independently-callable
JSON endpoint. The `spell_url` XHR is same-origin and returns real JSON, but its address is
only discoverable by first rendering a page that already contains the `data-tooltip-href`
anchor — there is no known `{spell-name-or-id} → tooltip URL` formula to construct it
cold. Cross-checked against Avrae (`cogs5e/sheets/beyond.py`, `_get_spellbook`): the
character-service v5 sheet's `spellbook.spells[]` entries carry only `id`, `name`, `sab`
(spell attack bonus), `dc`, `mod`, `prepared` — **no casting time/range/components/description**.
Avrae fills those in from its own separately-maintained, separately-licensed SRD compendium
(`gamedata.Spell`, looked up by the DDB spell id), not from a live DDB call. No hostname
resembling a spell-service (`spell-service.dndbeyond.com` or similar) appears in Beyond20,
Avrae's `utils/config.py`, or public search — unlike `monster-service`, nothing analogous
exists for spells.

**Reachability.** Full spell text: **not reachable** without a browser. The character-service
sheet's `spellbook` node *is* reachable (we already fetch the sheet) and gives per-character
casting stats — but not spell descriptions. UNVERIFIED: whether `config/json` (the same
endpoint our `rtGetDamageAdjustments` already hits for monster tables) happens to embed a
spell id→name index; even if so it would not carry casting time/range/description text, so it
wouldn't close this gap. A live probe would need to actually fetch a spell's `data-tooltip-href`
URL pattern to see if it's guessable from a spell id alone (e.g.
`www.dndbeyond.com/attachments/tooltip-fragments/spells/{id}-tooltip`) — if guessable *and*
reachable with just the CobaltSession cookie (same-origin, no bearer), that would flip this
from skip to build, but there's no signal in either prior-art source that anyone has tried
calling it outside a rendered page.

**Proposed tool shape.** None — nothing to build on the full-spell-card front. The
character's known/prepared spell list *with* dc/attack-bonus/prepared flag *is* buildable, but
that's a byproduct of the sheet's other top-level fields and is folded into the actions/attacks
tool below (§2) rather than a standalone "spells" tool, since it carries no spell text.

**Verdict: skip.** Full spell-card text requires a DOM render; there is no DDB read primitive
here that respects the no-browser invariant. (The character-facing spell *list*, sans text,
ships as part of §2 instead.)

---

### 2. Character actions & attacks (weapon/spell attack list, to-hit/damage notations)

**What the prior art does.** Beyond20's `src/dndbeyond/base/character.js` reads the Actions
tab DOM (`.ct-combat-attack--item .ct-item-name` and sibling to-hit/damage nodes) and injects
clickable roll buttons; `content-scripts/character.js` layers on request-building logic
(advantage flags, critical-limit, fighting-style detection — see §3). All DOM.

**DDB surface.** Character-service v5 sheet — **already fetched, already contains this**.
Confirmed via Avrae's public parser (`cogs5e/sheets/beyond.py`, `_process_attacks` /
`_transform_attack` / `_process_actions`, lines ~397–566): the raw sheet's top-level
`attacks[]` array carries **precomputed** `name`, `toHit`, `damage` (dice-notation string),
`saveDc`, `saveStat`, `desc` (HTML), and `activationType` per weapon/spell attack — DDB does
the proficiency+ability+magic-bonus math server-side and puts the result directly in the
sheet. The sibling `actions[]` array (non-attack actions: Second Wind, Rage, etc.) carries
`name`, `snippet` (HTML), `activationType`, and `id`/`typeId`/`componentId` pointers back to
the granting feature. This exactly confirms the issue's hypothesis — no new endpoint needed,
just a projection of fields our `rtGetRawCharacter` already returns.

Additionally: `character-service-scds.dndbeyond.com/v2` (SCDS — see §6) independently returns
a *simplified*, cross-character `attacks[]` with `to_hit` and structured `damage` already
resolved, if that surface turns out reachable — a second, batch-friendly source for the same
data.

**Reachability.** High confidence — this is the raw v5 sheet we already fetch with the
existing bearer JWT; no new auth path, no new endpoint. Only the exact field names above are
UNVERIFIED against our *own* live payload (Avrae's parser is the cross-check, not a live dump
from this repo) — worth confirming field names (`toHit` vs `to_hit`, etc. — character-service
uses camelCase per the fields already relied on in `parseStats`) on the first real
implementation pass.

**Proposed tool shape.**
```ts
server.tool(
  "ddb_get_character_actions",
  "List a character's attacks (weapon/spell, with to-hit and damage) and other actions " +
  "(class features, racial traits, item actions) from their D&D Beyond sheet. Default: name " +
  "+ to-hit/damage/activation. full:true adds save DC/stat and the full description text.",
  { ddbCharId: z.number().int().positive(), full: z.boolean().optional() },
  async ({ ddbCharId, full }) => { ... }
);
```
Default output: `{ attacks: [{name, toHit, damage, activationType}], actions: [{name, activationType}] }`.
`full:true` adds `saveDc`/`saveStat` on attacks and `desc`/`snippet` (HTML stripped to text,
matching the `stripHtml` pattern already used for monster abilities in `dndbeyond.ts`) on both.

**Verdict: build.** Directly serves dm-whisper at table time ("what can this PC do this
turn") and module-ingest at prep time (populating NPC/PC action blocks) — and it's nearly
free, since the source data is already in hand.

---

### 3. Roll semantics & modifiers (advantage/disadvantage, crit ranges, GWF-style rerolls)

**What the prior art does.** Beyond20's roll pipeline (`src/common/roll_renderer.js`,
`Beyond20RollRenderer`) models `RollType` (`NORMAL`, `ADVANTAGE`, `DISADVANTAGE`, `DOUBLE`,
`THRICE`, `SUPER_ADVANTAGE`, `SUPER_DISADVANTAGE` — the last two implement Elven Accuracy's
triple-roll-take-best), a `critical-limit` request field (default 20, lowered to 19/18 for
Champion-style expanded crit ranges), and a `CriticalRules` enum (`PHB`, `HOMEBREW_REROLL`,
`HOMEBREW_MOD`, `HOMEBREW_MAX`) for how extra critical damage is applied. `src/common/dice.js`
implements generic dice-reroll operators (`r=`, `r<=`, `r<`, `r>=`, `r>`) — the mechanism
behind Great Weapon Fighting's "reroll a 1 or 2 once." Crucially, **all of this is gated by
DOM-scraped feature/feat detection**: `content-scripts/character.js` computes `critical_limit`
per-attack by calling `character.hasClassFeature("Improved Critical")` /
`hasFeat(...)` / `hasGreatWeaponFighting(2014|2024)` (lines ~747–796, ~1353–1415,
~1576–1696, ~2043–2101) — i.e., it string-matches feature *names* read off the rendered
Features & Traits tab, not a precomputed "crit range" field.

**DDB surface.** Two halves:
- **Deriving a character's crit range / reroll rules**: the underlying facts (which class
  features / feats a character has) live in the character-service v5 sheet's `classFeatures`
  and `feats` arrays (see §4) — so the *same* name-matching Beyond20 does against the DOM
  could be done against the JSON sheet instead. Confirmed via `ddb-importer`
  (`src/parser/character/specialTraits.ts`, lines ~44–81): it does exactly this —
  `ddb.character.feats.some(feat => feat.definition.name === "War Caster")`,
  `cls.subclassDefinition.classFeatures.some(f => f.name === ...)` for Improved/Superior
  Critical and Wild Magic — reading the raw sheet, no DOM.
- **Enriching live game-log rolls with advantage/crit info**: our `DdbGameLogMessage` type
  (`src/bridge/ddb-gamelog.ts`) currently captures `rollType`/`rollKind`/`diceNotation`/`result`
  per roll but nothing resembling Beyond20's `discarded`/`critical-success` flags. Those flags
  are internal to *Beyond20's own* client-side dice engine (`src/common/dice.js`,
  `DNDBRoll.toJSON()`), not necessarily the shape of DDB's *native* dice-tray roll message that
  reaches the game-log WebSocket — Beyond20's roller and DDB's in-page tray are different code
  paths. **UNVERIFIED**: whether a native (non-Beyond20) advantage roll's raw WS frame contains
  two d20 results with one marked discarded, or some other advantage indicator, or nothing at
  all beyond two separate `rolls[]` entries indistinguishable from two separate d20 checks. A
  live probe needs an actual advantage roll captured from the pump to settle this.

**Reachability.** The classFeatures/feats half is reachable today (same sheet, same auth).
The game-log enrichment half is blocked on the UNVERIFIED point above — building it blind
risks inventing a schema DDB doesn't actually send.

**Proposed tool shape.** No standalone tool. If built, this is an enrichment to §2's output
(`ddb_get_character_actions` `full:true` gaining `criticalHitRange`/`damageRerollRule` per
attack) plus, pending the live-probe finding, extra fields on `ddb_poll_rolls` roll summaries.

**Verdict: maybe.** The crit-range/reroll-rule half is cheap and could ride along with §2's
`full` flag once that tool exists — worth doing then, not worth a separate effort now. The
game-log half needs a live probe first; filing a build issue for it now would be guessing at
an unconfirmed wire format.

---

### 4. Class features / feats / racial traits text

**What the prior art does.** Beyond20's tooltips/whispers render these from
`featureDetailsToList()` in `src/dndbeyond/base/character.js`, which queries
`.ct-feature-snippet > .ct-feature-snippet__heading` and sibling text nodes on the rendered
Features & Traits tab — DOM only. ddb-mcp/ddb-mcp has no equivalent tool (its `ddb_get_character`
also scrapes the character page rather than reading structured JSON).

**DDB surface.** Character-service v5 sheet — already fetched. The sheet's `race.racialTraits[]`,
each class entry's `classFeatures[]` (and `subclassDefinition.classFeatures[]`), and top-level
`feats[]` arrays are structured lists of `{ definition: { name, description, ... }, ... }`
objects. Confirmed structurally (list shape + `definition.name` field) via both Avrae
(`_process_actions`/`_process_attacks` context, `cogs5e/sheets/beyond.py`) and ddb-importer
(`src/parser/character/specialTraits.ts` — matches feature/feat names directly off these
arrays) and the `definition.description` text field specifically via ddb-importer's feature
parsing (`src/parser/features/DDBFeatureMixin.ts` and others, which extract exactly that field
into rendered item text across many files). This is the same shape family as the monster-service
`*Description` HTML blobs our `parseAbilityBlock` already decodes in `dndbeyond.ts` — same
decode/strip approach applies.

**Reachability.** High confidence, same basis as §2: no new endpoint, no new auth, just fields
on the sheet we already have. UNVERIFIED: exact field name casing/nesting until checked
against a live payload (`definition.description` vs some other key) — same caveat as §2.

**Proposed tool shape.**
```ts
server.tool(
  "ddb_get_character_features",
  "List a character's class features, feats, and racial traits from their D&D Beyond sheet. " +
  "Default: name + source (class/feat/race). full:true adds the full description text.",
  { ddbCharId: z.number().int().positive(), full: z.boolean().optional() },
  async ({ ddbCharId, full }) => { ... }
);
```
Default output: `{ features: [{name, source: "class"|"feat"|"race"}] }`. `full:true` adds
`description` (HTML stripped to text, `stripHtml`-style) per entry.

**Verdict: build.** Table-time rules lookups for dm-whisper ("what does Sneak Attack 2024 do
for this PC") and prep-time NPC/PC capability text for module-ingest; same low-cost,
sheet-already-fetched profile as §2 — could plausibly share an implementation pass.

---

### 5. Encounter-builder / combat-tracker monsters

**What the prior art does.** Beyond20's `src/dndbeyond/base/monster.js` detects a different
DOM skin on encounter-builder / combat-tracker pages (`isBlockFinder`, switching to
`.Stat-Block-Styles_*` selectors instead of `.mon-stat-block`/`.ct-creature-block`) but parses
the **same fields** (name, AC, HP, abilities, actions, spells) — it's a re-skin, not a
different data source. Notably, Beyond20 **never touches a monster's numeric id** anywhere in
this file — it only reads rendered text, so it can't itself confirm id parity with
monster-service.

**DDB surface.** The encounter builder places compendium monsters (and DM customizations) on
a per-encounter page. The monster identity itself is the same compendium record our
`monster-service` already serves; no distinct "list monsters in encounter N" service API
appears in Beyond20 or in Avrae's source (no `encounter` reference anywhere in
`avrae/avrae`'s `ddb/` client tree). Any DM-side customization made *within* one specific
encounter (HP overrides, added notes) that isn't saved back to the compendium record would
only exist in that page's DOM/state — out of scope regardless.

**Reachability.** The underlying monster: already reachable, already built (`ddb_get_monster`).
UNVERIFIED: whether an encounter-builder-placed instance's id always matches the plain
compendium id monster-service returns (plausible — it's presented as the same "add from
compendium" flow — but neither prior-art source confirms it, since neither reads ids here). A
live probe would need to add a known monster to a test encounter and diff its DOM-visible
identity against a `ddb_get_monster` lookup by name.

**Proposed tool shape.** None — `ddb_get_monster` already covers this if the id-parity
assumption holds.

**Verdict: skip (already covered).** No new surface to build against; flag the id-parity
assumption as something to sanity-check the next time `ddb_get_monster` is used against an
encounter-sourced monster, not worth a dedicated spike on its own.

---

### 6. Batch character / party snapshot (new — found via Avrae, not in Beyond20's scope)

**What the prior art does.** Not a Beyond20 feature (Beyond20 never needs multi-character
batch reads — it only ever operates on the one page's character). Found while cross-checking
Avrae's DDB client tree: `ddb/character/scds.py` (`CharacterStorageServiceClient`) calls
`POST character-service-scds.dndbeyond.com/v2/characters` with `{"characterIds": [...]}` and
gets back, per id, a **precomputed combat-ready snapshot** (`ddb/character/scds_types.py`,
`SimplifiedCharacterData`): abilities, AC, HP, death-save counts, conditions, classes/level,
initiative bonus, passive scores, proficiency groups, resistances/immunities/vulnerabilities,
senses, skills (with advantage/disadvantage flags), speeds, attuned items, and — notably — an
already-resolved `attacks[]` (name/range/damage/to-hit/save-info) and `casting_info`
(spell-attack/save-DC/modifier values with their contributing sources). This is the multi-PC
equivalent of a `ddb_get_character full:true` call, batched into one round trip.

**DDB surface.** `character-service-scds.dndbeyond.com/v2` — a real, separate REST service
(distinct host from `character-service.dndbeyond.com/character/v5`), auth
`Authorization: Bearer {jwt}` (`ddb/baseclient.py`, identical shape to every other DDB client
call Avrae makes — same as `character-service` and `active-campaigns`).

**Reachability.** UNVERIFIED, but plausible on the same basis our protocol doc already uses
for `active-campaigns`/`active-short-characters` parity: Avrae's JWT is self-minted (partner
`WATERDEEP_SECRET`) rather than cobalt-exchanged, so the audience/claims on *our* client JWT
might not satisfy whatever the SCDS route checks beyond "valid bearer for this user" — that's
exactly the kind of gap a live probe needs to close before relying on it. If it rejects our
JWT, the fallback is simply N parallel `character-service/v5` calls (what we'd do anyway,
just not batched).

**Proposed tool shape.**
```ts
server.tool(
  "ddb_get_party_snapshot",
  "Compact combat-ready snapshot (HP/AC/attacks/skills/conditions/senses) for multiple " +
  "characters in one call — cheaper than ddb_get_character per party member at table time.",
  { ddbCharIds: z.array(z.number().int().positive()).min(1) },
  async ({ ddbCharIds }) => { ... }
);
```
Output: array of `{id, name, hp, ac, attacks: [{name, toHit, damage}], conditions, skills, senses, speeds}`
— a projection of `SimplifiedCharacterData`, shaped like the existing compact character
snapshot but per-party-member and precomputed server-side (no local `parseStats` math needed).

**Verdict: build.** First task is a reachability spike (does our cobalt→JWT get accepted by
`character-service-scds`); if it does, this directly serves dm-whisper's table-time need for
"where does the whole party stand right now" without N sequential character fetches — the
single biggest latency win of everything surveyed here. If the spike fails, close the issue
with the finding and fall back to N `ddb_get_character` calls (already available).

---

### 7. Generic compendium/entity search (spells, items, races, classes, feats — non-monster)

**What the prior art does.** Beyond20 doesn't search at all — its content scripts operate
only on whatever entity page is already open. ddb-mcp/ddb-mcp's `ddb_search` scrapes
`dndbeyond.com/{spells|monsters|magic-items|races|classes|feats}?filter-search=` listing-page
HTML (`.listing-body div.info[data-slug]`) and the site-wide `dndbeyond.com/search?q=`.

**DDB surface.** Page-rendered listing HTML in both cases. Notably, ddb-mcp/ddb-mcp's monster
search is DOM-scraped even though this repo already has a working `monster-service v1`
search endpoint (`ddb_get_monster` by name) — a case where a browser genuinely wasn't
necessary, just not discovered by that project. No equivalent service endpoint is known for
spells/items/races/classes/feats; nothing in Avrae's `utils/config.py` or `ddb/` tree names
such a host.

**Reachability.** Not reachable for non-monster entity types without a browser. UNVERIFIED
whether an internal search-service (parallel to monster-service) exists for these other
entity types — absence of evidence in two independent, DDB-focused codebases is a reasonably
strong (not conclusive) signal that either it doesn't exist or it's not exposed the way
monster-service is.

**Proposed tool shape.** None.

**Verdict: skip.** DOM-only surface for everything except monsters (already covered).

---

### 8. Sourcebook / adventure library reading

**What the prior art does.** Only ddb-mcp/ddb-mcp has this: `ddb_list_library` /
`ddb_read_book` navigate to a purchased sourcebook/adventure's rendered page and scrape its
text. Beyond20 has no equivalent (out of scope for a dice/sheet bridge).

**DDB surface.** Page-rendered HTML of paid, DRM-adjacent content; no service-API equivalent
is referenced anywhere in Beyond20 or Avrae (Avrae's partner integration doesn't need to
re-render purchased book text either — it ships its own licensed SRD compendium, same pattern
as spells in §1).

**Reachability.** Not reachable without a browser, by construction.

**Proposed tool shape.** None.

**Verdict: skip.** DOM-only, and even if it weren't, redistributing paid rulebook/adventure
text through a lookup tool is a separate policy question this survey doesn't need to settle
because the technical answer (no browser ⇒ no access) already forecloses it.

---

## Summary

| # | Primitive | Surface | Reachable? | Verdict |
|---|---|---|---|---|
| 1 | Spell cards (full text) | DOM (+1 DOM-derived tooltip XHR) | No | **skip** |
| 2 | Character actions & attacks | character-service v5 sheet (already fetched) | Yes | **build** |
| 3 | Roll semantics (crit range, GWF reroll, adv/dis) | sheet (crit/reroll rules) + game-log WS (adv/crit flags, UNVERIFIED) | Partial | **maybe** |
| 4 | Class features / feats / racial traits text | character-service v5 sheet (already fetched) | Yes | **build** |
| 5 | Encounter-builder monsters | monster-service (id parity UNVERIFIED) | Yes (existing tool) | **skip (covered)** |
| 6 | Batch party snapshot | character-service-scds v2 (new host, UNVERIFIED auth) | Plausible | **build** |
| 7 | Compendium search (non-monster) | DOM | No | **skip** |
| 8 | Sourcebook/library reading | DOM (+ licensing) | No | **skip** |

8 candidates surveyed: 3 build, 1 maybe, 4 skip.

## Sources

- Beyond20 — github.com/kakaroto/Beyond20 @ `a2dcad9` (GPL-3.0; protocol/shape study only,
  no code lifted): `src/dndbeyond/base/{character,monster,spell,extras,dice}.js`,
  `src/dndbeyond/content-scripts/character.js`, `src/common/{dice,roll_renderer,constants}.js`,
  `src/extension/background.js`.
- ddb-mcp/ddb-mcp — github.com/ddb-mcp/ddb-mcp (MIT; unrelated project, name collision noted
  above): `src/{auth,browser}.ts`, `src/tools/{campaign,character,library,navigate,search}.ts`.
- Avrae — github.com/avrae/avrae (public source, partner integration; cross-check only):
  `cogs5e/sheets/beyond.py`, `utils/config.py`, `ddb/{baseclient,waterdeep}.py`,
  `ddb/character/{scds,scds_types}.py`.
- ddb-importer — github.com/MrPrimate/ddb-importer (MIT; cross-check only):
  `src/parser/character/specialTraits.ts`, `src/parser/features/DDBFeatureMixin.ts`.
- This repo: `docs/ddb-browserless-protocol.md`, `docs/ddb-gamelog-pump.md`,
  `src/bridge/{dndbeyond,ddb-rt,ddb-gamelog}.ts`, `src/tools/ddb.ts`.
