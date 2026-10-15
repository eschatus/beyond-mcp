# Homebrew builders: live probe notes for the other types

These are probe notes for spells, magic items, feats, backgrounds, species and subclasses. One
probe ran per type, live, on 2026-10-12, using the monster recipe in `ddb-homebrew-protocol.md`.
Each probe made at most 4 throwaway private creations, and every one was deleted afterwards.

**Status (2026-10-13): every type is implemented** in `src/bridge/ddb-homebrew-{type}.ts` with
`src/tools/ddbHomebrew{Type}.ts`. Each was verified with a live create/update/delete round-trip
through its MCP tools. The module headers record what each one covers and its v1 gaps (for
example, feat options/spells/actions, trait options, subclass feature options, spell lists). The
notes below are the probe-time evidence; where an implementation found something different (for
example, species options only list when `supportsOptions` is set, and a trait snippet needs at
least 2 characters), the module comment is the newer source.

## Patterns that hold across every type

- **Routes:** the from-scratch builders are `/homebrew/creations/create-{type}/create`, except
  subclasses, whose create form is `/classes/{classId}-{slug}/subclass/create`. The edit page
  needs the current slug.
- **Success signal:** most types answer a successful POST with a 302/303 redirect. Subclass
  create and update answer **200** with the new page instead; read the id from that page and
  **never retry**, because a retry creates a duplicate.
- **Server crashes:** a redirect to `/error` means the server crashed.
- **Silent failures:** for species traits, a POST missing a required field returns 200 with no
  field errors and creates nothing. Only a read-back proves a write.
- **Rich text:** each rich field is a trio of `X-type` (hidden, "1"), `X-wysiwyg` and `X`. The
  server reads the wysiwyg copy, so send the same HTML in both textareas. Only monsters ship
  placeholder templates in their textareas.
- **Shared modifier editor:** spells, items, feats, backgrounds, species traits and subclass
  features all use it. Its subtypes come from an inline `var subTypes` catalogue
  (`embeddedSubTypes` / `resolveSubType` in `ddb-homebrew-core.ts`). The server doesn't check
  that a subtype belongs to its type. On a modifier *edit* page the current subtype is only in
  `var subTypesValue`.
- **Feature type is create-only:** Granted / Additional / Replacement on species traits and
  subclass features can't be changed. An edit is silently ignored.
- **Duplicate labels with different ids** occur for tools, languages, feats, spell classes and
  monster subtypes. `setControl` throws on ambiguity; pass `{ value }` to pick one.
- **Reads lag writes:** edit pages flapped between old and new values, and game-data omitted the
  newest entry about 1 time in 4. Verify through `settle()`. Confirm deletes with a repeat delete
  that answers 404; edit pages and public view pages are not reliable delete oracles.
- **Cascades:** deletes cascade to sub-entries, except species options, which must be deleted
  separately. Sub-entry `/edit` pages may keep returning 200 after a delete, so use the parent's
  listing as the oracle.
- **Listing:** `/my-creations?page=N` lists all of the account's homebrew (links carry
  `entityTypeId` and `id`).

## JSON read-backs (bearer JWT, character-service v5)

| Type | Endpoint | Covers |
| --- | --- | --- |
| Spell | `game-data/spells?classId={a mapped class}&classLevel=20&sharingSetting=2` | most fields + modifiers/conditions |
| Feat | `game-data/feats` | name, description, snippet, prerequisites |
| Species | `game-data/races` | basics, speeds, size; traits lag. A species with options is listed only through its options. |
| Magic item, background, subclass | none for private drafts | use the edit page |

## Findings from a full-sourcebook import (2026-10-13)

A real sourcebook was pushed through every tool: 15 backgrounds, 4 species, 17 subclasses, 15 feats,
12 spells, 74 items and 27 statblocks. That import surfaced and verified these facts live. The module
headers hold the detail.

**Shared sub-forms** (`ddb-homebrew-entity.ts`): limited-use actions and entity spells work on any owner.
- Owner type ids:

  | Owner | Id |
  | --- | --- |
  | Feat | 1088085227 |
  | Feat option | 400581042 |
  | Racial trait (including a species option's traits) | 1960452172 |
  | Class feature | 12168134 |
  | Class-feature option | 258900837 |
  | Species trait option | 306912077 (linked, not yet exercised) |

- **Uses:** the limited-use form has no uses control. Uses are separate rows,
  `/entity/limited-use/{id}/level-scale/create`, built as `(count op ability mod) op PB`, and each row can be
  per level. Uses need a reset, and there is no "minimum of 1".
- **Resets:** "Short or Long Rest" maps to Short Rest. Custom triggers map to Other, with the timing kept in
  the text.
- **Feat spell form:** it lacks always-prepared, charges, save DC and restriction.
- **Ability score on actions:** feat and trait owners need an ability score for an action with an attack
  range or save; class features don't.

**Backgrounds**
- A proficiency pool with ONE option is a fixed grant; with several options it is a choice. The tool fields
  are `skillGrants`, `toolGrants` and `languageGrants`.
- The 2024 "Ability Scores" hidden feats and "Choose a Gaming Set" (#408) can't be selected in homebrew.
- Single-line description fields strip a leading `<p>` and a trailing `</p>` independently.

**Spells**
- `field-attack-type` is the *spell* attack roll control when "as part of weapon attack" is unticked
  (`spellAttack`).
- Higher-level entries link to a modifier (`higherLevels[].modifier`), as official Fireball is built.
  How their level field works depends on the scale type:

  | Scale type | Level field means | Dice |
  | --- | --- | --- |
  | Spell Scale | every N slots | added |
  | Character Level | the character level | absolute |
  | Spell Level | the trigger slot | added |

  Entries stay hidden until higher-level casting is enabled.
- The 2024 Cleric and Druid game-data lists omit homebrew, so read-back tries each mapped class.

**Items**
- "+N" weapons use Bonus / Magic (subtype 312), the same as the official Weapon +1/+2/+3.
- A Weapon item can't be created without a base weapon. Mundane book weapons use PHB stand-ins.
- Armor `dexterity-modifier` is nulled on create but kept on edit, so it is applied in the follow-up save.
- Charge resets: Short Rest, Long Rest, Dawn, Other, None/Consumable.

**Monsters**
- `field-*-save-bonus` adds on top of proficiency and forces proficiency on, so it is only valid for
  proficient saves (`saveBonuses`).
- `languagesNote` is appended after the languages list; it does not replace it.

**Species**
- Option-level traits use the same trait form, at `/entity/species-trait/create/{optId}-1228963568`.
- Trait options exist.
- There is no creature-type control, no Advantage-vs-Poisoned subtype (use Advantage / Saving Throws with a
  restriction), no conditional Expertise, and no understand-only language.

**Subclasses**
- Options carry required level, dependent-option chains (resolve to ids created in the same call; labels
  repeat on update), and their own modifiers, spells and actions.
- A feature with many options can take longer than a 60 s MCP client request timeout, because it makes
  dozens of sequential requests.

**Read lag:** game-data took over 30 s to list some new feats, so `settle()` now waits about 60 s in all.

## Entity type ids

| Type | Id |
| --- | --- |
| Monster | 779871897 |
| Spell | 1118725998 |
| Magic item | 112130694 |
| Feat | 1088085227 (OotD's 1088940854 is wrong) |
| Background | 1669830167 |
| Species | 1743923279 |
| Species option | 1228963568 |
| Racial trait mapping | 1960452172 |
| Subclass (= class) | 789467139 |
| Class feature | 12168134 |


## spell

- entityTypeId 1118725998. Create GET+POST /homebrew/creations/create-spell/create multipart → 303 /homebrew/creations/spells/{id}-{slug}/edit. Edit same pattern; old slug 404 after rename. Delete ajax-post /homebrew/creations/delete?entityTypeId=1118725998&id= → {"RedirectUrl":"/my-creations"}; oracle edit 404 (public view page still 200 after delete — NOT an oracle).
- Create fields: field-Name*, version, spell-level (0 Cantrip,"1st".."9th"), spell-school*, spell-casting-time* (number), spell-activation* (Action, Bonus Action, Hour, Minute, No Action, Reaction, Special), field-spell-casting-time-description HASHED, verbal/somatic/material-field cbs, spell-components, origin* (Self, Touch, Ranged, Sight, Unlimited), spell-range, spell-duration* (Concentration, Instantaneous, Special, Time, Until Dispelled, Until Dispelled or Triggered), spell-duration-interval, spell-duration-unit (Round..Day), spell-description-type=1 + -wysiwyg + spell-description (send both), can-cast-as-ritual, can-cast-at-higher-level, higher-level-scale (Character Level, Spell Scale, Spell Level), class-mapping* multi (414 opts, labels unique: "Wizard", "Wizard - Evoker", "Bard (Legacy)"). No placeholder templates.
- Edit-only: large-avatar HASHED file, spell-aoe (Cone, Cube, Cylinder, Emanation, Line, Sphere, Square, Square Feet), spell-aoe-size, aoe-special-description cb, as-part-of-weapon-attack cb (then attack-type* Melee/Ranged), spell-save-type (STR..CHA), on-miss / spell-save-success / spell-save-fail textareas, spell-tags-public multi.
- Sub-forms urlencoded → 302 edit#section; delete ajax /spells/{modifier|condition|additional}/{subId}/delete:
  modifier /spells/modifier/create/{id}: spell-modifier-type*, spell-modifier-sub-type* (flat 2100+ list, dup labels; resolve via embedded `var subTypes=[[{id,name,type}]]` filtered by type), dice-count, dice-value (d4..d20), fixed-value, primary-stat cb, duration, duration-unit, restriction. Mismatched pair accepted.
  condition /spells/condition/create/{id}: radios condition-effect (apply 1/remove 2/suppress 3)*, condition*, condition-duration, duration-unit, condition-exception, hide cb.
  additional (higher level) /spells/additional/create/{id}: level, modifier (select of this spell's existing modifiers), effect-type* (Additional Count, Additional Creatures, Additional Points, Additional Targets, Extended Area, Extended Duration, Extended Range, Special), dice-count, dice-value, dice-fixed, dice-details. Delete order on replace: additional, then modifiers, then conditions.
- JSON read-back: GET character-service v5 game-data/spells?classId={mapped class id}&classLevel=20&sharingSetting=2 (bearer); find data[].definition.id. Fields: name, version, description, level, school(label), activation{activationTime,activationType}, castingTimeDescription, components [1,2,3], componentsDescription, range{origin label,rangeValue,aoeType label,aoeValue}, duration{durationType label,durationInterval,durationUnit label}, concentration, ritual, canCastAtHigherLevel, scaleType, asPartOfWeaponAttack, attackType, saveDcAbilityId, tags(labels), modifiers[], conditions[]. Lags ~20s after sub-entry deletes (edit page immediate).
- setControl can't pick blank "" option — needed to clear selects.
- Creations 3402445, 3402447 deleted (edit 404, gone from JSON).

## magic-item

- entityTypeId 112130694. Create GET+POST /homebrew/creations/create-magic-item/create multipart → 303 /homebrew/creations/magic-items/{id}-{slug}/edit. Update = same edit-form pattern; slug from 303 Location (no JSON url field). Delete ajax-post /homebrew/creations/delete?entityTypeId=112130694&id= → {"RedirectUrl":"/my-creations"}; oracle edit page 404; sub-entries cascade.
- Create fields (stable names): name*, version, rarity* (Common..Artifact, Varies, Unknown Rarity), item-base-type (blank=Item, 701257905 Armor, 1782728300 Weapon), type* only when Item (Wondrous Item, Rod, Scroll, Staff, Wand, Ring, Potion), base-armor, dexterity-modifier (Full Modifier/Max 2/None), strength-requirement, stealth-check (None/Disadvantage), base-weapon (227, duplicate labels exist!), requires-attunement cb, attunement-description, item-description-type hidden=1, item-description-wysiwyg* + item-description (send same HTML both; wysiwyg wins). No placeholder templates.
- Edit-only: has-charges cb, number-of-charges, charge-reset-condition (Short Rest, Long Rest, Dawn, Other, None/Consumable), charge-reset-description, notes, weight ("2.5"→"2.50"), magic-item-tags-public multi, hashed avatar files.
- Server silently NULLS fields not applicable to base type (armor fields on weapon etc.) — tool should reject mismatches up front.
- Sub-forms (urlencoded, 302 → edit#section):
  modifier: /modifier/create/{id}-112130694/0 ; delete /modifier/{subId}/delete. spell-modifier-type (37 opts), spell-modifier-sub-type EMPTY in HTML — options from embedded `var subTypes = [[{id,name,type}…]]` (1598) filtered by type; subtype wins over type; rpg-stat, dice-count, dice-value, fixed-value, additional-bonus-type multi, restriction, duration-interval, duration-unit, requires-attunement PRE-CHECKED. Edit form doesn't render existing subtype (script var subTypesValue).
  condition: /magic-items/condition/create/{id}; field-item-condition HASHED name; condition-duration, duration-unit, condition-exception. delete /magic-items/condition/{subId}/delete (inferred).
  spell: /magic-items/spell/create/{id}; item-spell labels "Fireball - [Level 3]", Legacy variants; min-charges, max-charges, save-dc, cast-at-level, restriction. delete /magic-items/spell/{subId}/delete.
- Read-back: no JSON for private drafts (game-data/items excludes homebrew; tooltip-json → /error). Oracle = edit form + listing tables (table.listing-rpgentity-modifier, condition table, table.listing-rpgitem-spell-mapping) which show labels.
- setControl can't select blank "" option (needed to clear a select).
- Creations 12082860, 12082883, 12082886 all deleted (edit 404).

## feat

- entityTypeId 1088085227 (NOT OotD's 1088940854). Create GET+POST /homebrew/creations/create-feat/create URLENCODED → 302 /homebrew/creations/create-feat/{id}-{slug}/edit. Edit same URL pattern, 302. Copy: POST /homebrew/creations/create-feat (field-Feat) → 302 /homebrew/creations/edit?entityTypeId=T&id= → 302 edit; copies carry prereqs+modifiers, named COPY_OF_.
- Fields (all stable names; create==edit): name* 3..1024, version 1..100, item-description-type=1 + item-description-wysiwyg + item-description (send both; error attaches to -type), snippet 3..2048, feat-tags-public multi (42; case-variant dups e.g. General/genral). No placeholders, no crashes.
- Sub-entries (urlencoded):
  prerequisite: /entity/prerequisite/create/{id}-T (description*) → 303 /entity/prerequisite/{pid}/edit; mapping /entity/prerequisite-mapping/create/{pid}: prereq-type (Ability Score=1, Class=9, Class Feature=11, Custom Value=6, Feat=10, Level=7, Proficiency=5, Size=4, Species=2, Species Option=3), prereq-sub-type (5982 static opts, JS filtered by embedded {id,name,type}; ability: Strength=1, Dexterity=88, Constitution=89, Intelligence=90, Wisdom=91, Charisma=92), value, create-should-exclude cb. Blank mapping → 303 creates nothing. Deletes /entity/prerequisite/{pid}/delete, /entity/prerequisite-mapping/{mid}/delete.
  modifier: /modifier/create/{id}-T/0 (same generic editor as magic items; subtype empty in HTML, embedded `var subTypes` 1598 rows; required). Edit /modifier/{mid}/0/edit — edit form doesn't render subtype (var subTypesValue) → must re-set raw. Delete /modifier/{mid}/delete.
  option: /feats/{id}-{slug}/feat-option/create (name, description-type/-wysiwyg/description, snippet) → 302 option edit; delete /feats/{id}-{slug}/feat-option/{oid}/delete.
  spell: /entity/spell/create/{id}-T (field-spell multi "Acid Splash - [Cantrip]", many filters; spell-class dup labels). delete /entity/spell/{sid}/delete.
  action: /entity/limited-use/create/{id}-T (33 controls). delete /entity/limited-use/{lid}/delete.
  creature rule: /creature-rule/create/{id}-T (GET only).
- Delete cascades. DELETE ORACLE FLAPS: edit page 404→200→404 over ~1 min; view page stays 200; JSON flaps. Firm oracle: re-POSTing the delete returns 404 consistently.
- JSON: GET character-service v5 game-data/feats (BEARER; cookie-only omits homebrew), filter by id: name, description, snippet, slug, isHomebrew, prerequisites[{description, prerequisiteMappings[{type slug, subType slug, value, friendlyTypeName, friendlySubTypeName, shouldExclude}]}]. Not in JSON: version, tags, modifiers, options, spells, actions → edit form + listings.
- Creations 2455619, 2455631 deleted (re-delete 404).

## background

- entityTypeId 1669830167. Create GET+POST /homebrew/creations/create-background/create multipart → 302 /homebrew/creations/create-background/{id}-{slug}/edit. Edit same, 302. Copy form /homebrew/creations/create-background (field id has a SPACE: "field-Background Background"), not posted. Delete standard ajax; oracle edit 404.
- Fields (stable names, create==edit, no files): name* 2..128, version ≤100, 15 rich trios (X-type=1, X-wysiwyg, X — server reads -wysiwyg; set all 3): short-description* ("Introduction", error attaches to -type), ability-scores-description, feat-description, skill-proficiencies-description, tool-proficiencies-description, languages-description, equipment-description, attribute-description, feature-description, variant-description, variant-feature-description, suggested-characteristics-description, spell-list-pre-description, spell-list-post-description, contacts-description; texts attribute-name ≤128, feature-name ≤256, variant-name ≤128, variant-feature-name ≤128; background-tags-public multi (18). No placeholders. Six single-line fields (ability-scores, feat, skill/tool/languages, equipment) strip <p> wrapper on read-back.
- Sub-forms (urlencoded):
  skill/tool/language modifiers: /modifier/create/{id}-T/{1|2|3}; field-spell-modifier-default-sub-types multi (skills 18: Athletics 3783…; tools 71 with DUPLICATE labels; languages 98 dups) → one "Choose a X - a, b" pool row; edit /modifier/{mid}/{n}/edit replaces set; delete /modifier/{mid}/delete. Empty selection accepted (creates empty modifier).
  equipment slot: /entity/starting-equipment-slot/create/{id}-T (field-name 2..2048) → 303 /entity/starting-equipment-slot/{sid}/edit; delete …/{sid}/delete.
  table row: /backgrounds/{id}-{slug}/attribute/create (field-name 2..512).
  characteristic: /backgrounds/{id}-{slug}/characteristic/create (field-type 1 Personality Trait/2 Ideal/3 Bond/4 Flaw*, field-name 2..256).
  contact: /backgrounds/{id}-{slug}/contact/create (field-type 5 Contact/6 Non-contact, field-name); its delete link is …/characteristic/{sid}/delete — use hrefs verbatim.
  granted feat: /backgrounds/{id}-{slug}/granted-feat/create (field-name* 2..50, field-feat multi 678, dup labels e.g. Alert 1789101 & 12); empty feat accepted.
  spell list: /spell-list/{id}-T/create (field-name 2..50, field-spell-mapping multi 1623); only one per background; edit/delete /spell-list/{id}-T/edit|delete.
  Sub-entry edit/delete: /backgrounds/{slug}/{kind}/{subId}/edit|delete.
- No JSON for private drafts (game-data/backgrounds ignores homebrew drafts). Oracle = edit page (form + section rows + counts); granted feat / spell list selections only on their own edit forms.
- One delete script hung >5 min → use request timeouts.
- Creations 577833, 577835 deleted (edit 404).

## species

- entity types: species 1743923279, species option 1228963568, racial trait mapping 1960452172.
- Create GET+POST /homebrew/creations/create-species/create multipart → 302 /homebrew/creations/species/{id}-{slug}/edit. Edit same → 302 new slug (use Location; fetched form action may carry stale slug).
- Species fields: name* 2..128, version, size* (Tiny=2, Small=3, Medium or Small=10, Medium=4, Large=5, Huge=6, Gargantuan=7), speed-walking/-burrowing/-climbing/-flying/-swimming (≤500), short-description trio, race-group (150; dup "-" labels), description* trio (error on -type), hide-traits-heading cb, racial-trait-introduction* text, supports-subrace cb, 2 hashed avatar files. No placeholders.
- Trait: /entity/species-trait/create/{sid}-1743923279 urlencoded → 302 /entity/species-trait/{tid}/edit. Fields name* 2..256, snippet*, racial-trait-mapping-description* trio, display-order-field, hide-in-builder, hide-in-sheet, hide-on-details-page, is-called-out cbs, feature-type* (Granted 1/Additional 2/Replacement 3; CREATE-ONLY, edit silently ignores), racial-traits-to-replace multi, racial-trait-option-known, required-character-level. Missing required → 200 with NO field-errors and nothing created (must check redirect).
- Modifier on trait: /modifier/create/{tid}-1960452172/0 (generic editor; inline subTypes JSON 1598; mismatch type/subtype accepted; edit page subtype only in `var subTypesValue`).
- Trait option: /entity/species-trait/{tid}/species-trait-option/create (name, snippet, class-feature-option-description trio, dependent-racial-trait-option, required-level, is-granted).
- Species option: /homebrew/creations/species/{id}-{slug}/create-species-options/create multipart → 302 /homebrew/creations/species-options/{oid}-{slug}/edit (name*, version, item-description* trio, race-group, is-variant cb). Options DON'T cascade on species delete — delete separately via generic delete entityTypeId=1228963568.
- Deletes: trait /entity/species-trait/{tid}/delete, trait option …/species-trait-option/{oid}/delete, modifier /modifier/{mid}/delete, species option /species/{id}-{CURRENT slug}/species-options/{oid}/delete; species generic /homebrew/creations/delete?entityTypeId=1743923279&id=. Species edit page has no delete link. Sub-entity /edit pages stay 200 after delete → oracle = parent listing.
- EVENTUAL CONSISTENCY: edit pages flap old/new for seconds–minutes after writes (trait reads); JSON omits newest entry ~20–30% of fetches. Read-back must retry / take consensus.
- JSON: character-service v5 game-data/races (bearer), filter by entityRaceId: fullName, description(short), longDescription, sizeId, weightSpeeds.normal{walk,fly,burrow,swim,climb}, racialTraits[].definition (lags), groupIds (never populated for drafts), isHomebrew. A species with supports-subrace + options is not listed itself (only its options). Modifiers not in JSON.
- Creations 2229674, 2229676, options 1039721, 1039723 deleted (edit 404).

## subclass

- entityTypeId 789467139 (same as classes). class-feature entity type 12168134.
- Router POST /homebrew/creations/create-subclass (class-type label→class id; Wizard 2190886 etc., Legacy dups) → 302 /classes/{classId}-{classSlug}/subclass/create (creates nothing).
- FROM-SCRATCH create: GET+POST /classes/{classId}-{slug}/subclass/create multipart → **200** with new subclass page (NO redirect). Parse new id from body: href="/classes/{NEWID}-{slug}/class-feature/create" or "/classes/{parent}-{slug}/subclass/{NEWID}/edit". NEVER retry (dupes). Rejection also 200 + field-errors.
- Copy: POST /homebrew/creations/create-subclass-from-class (subClass) creates immediately → 302 /homebrew/creations/edit?entityTypeId=789467139&id=NEW → 302 /classes/{parent}-{slug}/subclass/{NEW}/edit. Copies features, leaves descriptions empty (rename fails until filled). Blank subClass → /error.
- Edit: GET/POST /classes/{parentClassId}-{slug}/subclass/{id}/edit (numeric id, slug ignored) multipart → 200 re-render (no redirect).
- Fields: name* ≤50, version ≤100, subclass-short-description* trio, subclass-description* trio (error on -type), spell-casting-ability (STR=1..CHA=6), can-cast-spells (Yes=t/No=f), additional-spell-list multi HASHED name (class ids), spell-prepare-type (Half Level=2, Level=1), knows-all-spells (t/f), spell-learning-style (Learned=2, Prepared=1), spell-mapping multi (~1622 spells), avatar files hashed. No placeholders.
- Feature: /classes/{subId}-{subSlug}/class-feature/create multipart → 302 …/class-feature/{fid}/edit. Fields: name* ≤1024, snippet ≤2048, class-feature-description* trio (min ~4 chars text), multiclass-class-feature-description trio, required-level* 1-20, display-order-field, has-options cb, class-feature-option-known, display-required-level cb, hide-in-builder cb, hide-in-sheet cb, feature-type* (Granted 1/Additional 2/Replacement 3 — CREATE-ONLY; edit silently ignores), class-features-to-replace multi. Feature edit POST → 200. Delete ajax /classes/{subId}-{CURRENT slug}/class-feature/{fid}/delete.
- Feature children: option …/class-feature/{fid}/option/create (multipart; name, snippet, desc trio, multiclass trio, is-granted, required-level, dependent-class-feature-option, prerequisite-text); level scale /entity/levelscale/create/{fid}-12168134 (level, dice-count, dice-value, fixed-value, description); modifier /modifier/create/{fid}-12168134/0 (generic editor, subtype from inline JSON, + available-to-multiclass); spell /entity/spell/create/{fid}-12168134; limited-use/creature-rule/spell-list GET only.
- No JSON for drafts. Oracle = subclass edit form + feature edit form + subclass feature table; edit 404 after delete; features cascade; /entity/spell/{id}/edit stays 200 (stateless, not oracle); public /subclasses page stays 200.
- /my-creations?page=N lists all homebrew (a[href*="homebrew/creations/view"] with entityTypeId & id) — a possible listing tool!
- Creations 2911534, 2911535, 2911540 deleted (edit 404).
