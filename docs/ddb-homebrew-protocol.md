# D&D Beyond homebrew builders: the write protocol

How `src/bridge/ddb-homebrew.ts` creates, updates and deletes homebrew **monsters** with no
browser. Every route below was verified live on 2026-10-12 against throwaway private monsters,
which were all deleted afterwards. Read this before touching the homebrew bridge.

## There is no API

Homebrew has no JSON write API. The only write surface is the site's server-rendered builder
forms on `www.dndbeyond.com`. They authenticate with **cookies alone**: `CobaltSession`, plus
whatever the site sets along the way. The JWT bearer the service reads use isn't needed. So the
bridge does what a browser does: GET the live form, fill it, POST every control, follow nothing.

Three properties of the forms shape the code:

- **Per-render CSRF tokens.** Each form carries `security-token` and `authenticity-token` hidden
  inputs, so every write starts with a fresh GET.
- **Per-render hashed field names.** STR, DEX and the other ability scores, initiative bonus,
  save bonuses and the avatar uploads get names like `fdb5c7a0…`, which change on every load.
  Element **ids** are stable (`field-strength`), so controls are addressed by id and posted under
  whatever name the live page gave them.
- **Placeholder templates are real values.** On the create form, the description textareas ship
  pre-filled with "Trait Name. Enter the description…" text. A POST would save that verbatim, so
  a create blanks every description the caller didn't supply.

Select options are matched by **label only**. Option values are opaque ids that collide with
labels: on the CR select, value `"5"` is labelled `1`, and label `5` has value `"9"`. An early
version matched values first, and so silently saved the wrong CR.

## Routes

| Op | Request | Success |
| --- | --- | --- |
| Create | GET+POST `/homebrew/creations/create-monster/create` (multipart) | `303` → `/homebrew/creations/monsters/{id}-{slug}/edit` |
| Update | GET+POST `/homebrew/creations/monsters/{id}-{slug}/edit` (multipart, every control) | `303` → the edit URL, with a new slug after a rename |
| Add movement | GET+POST `/monster/movement/create/{id}` (urlencoded: `movement-type`, `speed`, `note`) | `302` → `…/edit#movement` |
| Add sense | GET+POST `/monster/senses/create/{id}` (`sense`, `sense-note`) | `302` → `…/edit#senses` |
| Add skill | GET+POST `/monster/skills/create/{id}` (`skill`, `value`, `additional-bonus`) | `302` → `…/edit#skills` |
| Add language | GET+POST `/entity/language/create/{id}-779871897` (`language`, `note`) | `302` → `…/edit#languages` |
| Remove sub-entry | ajax-post `/monster/{movement\|senses\|skills}/{subId}/delete`, `/entity/language/{subId}/delete` | `200` `{"RedirectUrl": …}` |
| Delete monster | ajax-post `/homebrew/creations/delete?entityTypeId=779871897&id={id}` | `200` `{"RedirectUrl": …}` |

- `779871897` is the monster entity type id.
- The edit page lists each sub-entry with `/…/{subId}/edit` and `/…/{subId}/delete` links. That
  page is the only index of sub-entry ids.
- The edit URL needs the slug: `/homebrew/creations/monsters/{id}/edit` without it returns 404.
  The bridge takes the slug from monster-service's `url` field, which follows renames.
- A skill's "Base Value" is the statblock's **total** bonus. Value 4 renders as `Perception +4`.
- `field-lair-challenge-rating` is really the "Lair XP" select. Its labels are XP amounts
  (`10` … `155000`), not CRs.

**ajax-post** is the site's `a.ajax-post` link handler. It POSTs urlencoded
`request-verification-token=<value of the RequestVerificationToken cookie>` with
`X-Requested-With: XMLHttpRequest`. That cookie isn't set by page loads:
`POST /refresh-request-verification-token` (XHR) mints it and replies `{"result":"success"}`,
the same thing the site's `Cobalt.Utils.getRequestVerificationToken` does. `rtSiteSession()`
keeps a cookie jar so the minted cookie rides along.

## Failure modes

- **Validation rejection:** the server answers `200` with the form re-rendered, and each bad
  field carries a `<span class="field-errors">` beside its control. `formErrors()` maps these
  back to field ids and labels.
- **Server crash:** a `303` redirect to `/error`. It's still a redirect, so it must never be
  read as success. Live trigger: **any `treasure` value on the create POST**, whatever option is
  picked. The same value saves fine through the edit form, so create strips `treasure` and
  applies it in a follow-up builder save.
- **Weak sub-form validation:** a skill posted with no value is *accepted* (`302`). The redirect
  doesn't prove anything; only the read-back does.

## Verification (three oracles)

No single read covers every field, so each write is checked three ways:

1. **The re-rendered edit form.** It must show every non-description control the caller set.
   This is the only place treasure, tags, habitats, saves and initiative read back. Descriptions
   aren't compared, because the server may normalize their HTML.
2. **monster-service** (`?ids={id}&showHomebrew=t`), for sub-entries. Movements, senses, skills
   and languages read back as data only here. The expected ids come from the live sub-form's
   options, so no id table is baked in.
3. **The caller's labels against the read side's own baked tables** (`challengeRatingLabel`,
   `SIZES`, `ALIGNMENTS`, plus name, AC, HP, hit dice and abilities). This catches a label that
   was resolved to the wrong option, a bug the first two oracles would agree on.

Any mismatch that persists throws `DdbWriteError`, naming the monster id so the caller can fix or
delete it. A blank hit-dice modifier is stored as `"0"`, so the tool sends 0 for an omitted
modifier.
Nothing is retried or repaired silently.

**Reads lag writes.** Builder pages and JSON reads come from replicas or caches that lag. Probes
of other types saw edit pages flip between old and new values for minutes. So verification runs
through `settle()`, which re-reads with backoff (about 30 s in total) and reports only a mismatch
that persists.

**Deletes** can't be confirmed by reads. monster-service keeps serving deleted homebrew from its
cache, and after a feat delete even the edit page went 404 → 200 → 404. The firm oracle, verified
live for feats and monsters, is to **re-POST the delete: it answers 404** once the creation is gone.
A lagging replica would show the entity as still present, never as missing, so a 404 is safe to
trust.

## Live-checked id agreement

The builder's option values match monster-service's ids for: size (Medium = 4), alignment
(Neutral = 5), CR (1/4 = 3, 5 = 9), monster type (Humanoid = 11), damage adjustments
("Fire - Resistance" = 9), movement (Walk = 1, Climb = 3), sense (Darkvision = 2) and skill
(Perception = 14).

## Prior art

These projects are useful protocol references. None has a license, so read them but don't copy
their code.

- [Thedougler/campaign-foundry ADR 0022](https://github.com/Thedougler/campaign-foundry/blob/HEAD/docs/adr/0022-ddb-homebrew-writes-through-captured-contracts.md):
  the first published browserless monster round-trip (create by copying a base monster, update,
  delete). It is the source of the `RequestVerificationToken` lead.
- [karpiq24/OotD `dndbeyond-manager`](https://github.com/karpiq24/OotD/tree/HEAD/.agents/skills/dndbeyond-manager):
  Playwright-based. Has a field-by-field map of every builder type, entity type ids for the other
  homebrew kinds, and the `[rollable]` tag syntax.

## Listing, and deletes are soft

`/my-creations` is the account's own creations list. It supports the filters `filter-type` (entity
type id), `filter-name` (a substring) and `filter-status` (1 Private, 2 Published, 3 Deleted), plus
`page=N`, at about 20 rows per page. `src/bridge/ddb-homebrew-list.ts` reads it, and
`ddb_list_homebrew` exposes it. **Deleting homebrew is a soft delete:** a deleted creation stays
listed as "Deleted, …" with no view link. So rows are parsed from their markup (`data-slug` =
`{id}-{slug}`), and deleted rows are hidden unless the caller asks for them.

## Other types

See `ddb-homebrew-types.md` for the live probe notes on the other types.

## Not covered yet

Spells, magic items, feats and backgrounds have similar flat from-scratch builders at
`/homebrew/creations/create-{spell|magic-item|feat|background}/create`. Species and subclasses
can only be copied from an existing entry. None of these routes has been verified live, so none
ships until it has been.
