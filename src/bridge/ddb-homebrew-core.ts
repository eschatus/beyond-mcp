// Type-agnostic plumbing for D&D Beyond's homebrew builders, shared by every homebrew type
// (monsters today; spells, items, … as each is verified). Live-verified behaviour common to all
// builders seen so far — see docs/ddb-homebrew-protocol.md:
//   - a form POST succeeds with a 302/303 redirect; a redirect to /error is a server crash;
//     a rejection is 200 + the re-rendered form carrying <span class="field-errors">.
//   - deletes (the creation and its sub-entries) are the site's `a.ajax-post` links: POST with the
//     RequestVerificationToken cookie echoed as `request-verification-token`.
//   - reads lag writes (replicas/caches): verify with settle(), confirm deletes by re-delete 404.

import type { SiteSession } from "./ddb-rt.js";
import { parseForm, formErrors, encodeForm, setControl, controlById, type ParsedForm } from "./html-form.js";
import { DdbWriteError } from "./ddb-write.js";

const XHR = { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" };

export async function getPage(s: SiteSession, path: string): Promise<string> {
  const res = await s.fetch(path);
  if (res.status !== 200) {
    throw new DdbWriteError(
      `ddb-homebrew GET ${path} → ${res.status}${res.headers.get("location") ? ` (→ ${res.headers.get("location")})` : ""}. ` +
      `Homebrew needs a logged-in session whose account can create homebrew, and the creation must be one of its own.`,
      res.status, null);
  }
  return res.text();
}

export async function loadForm(s: SiteSession, path: string, action: RegExp): Promise<ParsedForm> {
  return (await loadFormPage(s, path, action)).form;
}

/** loadForm plus the page's HTML — modifier and prerequisite pages carry their subtype catalogue in it. */
export async function loadFormPage(s: SiteSession, path: string, action: RegExp): Promise<{ form: ParsedForm; html: string }> {
  const html = await getPage(s, path);
  try { return { form: parseForm(html, action), html }; }
  catch (err) {
    throw new DdbWriteError(`ddb-homebrew ${path}: ${(err as Error).message} — the page has no builder form (session not logged in, or DDB changed the page).`, 200, null);
  }
}

/** POST a form; success is a redirect, whose Location is returned. */
export async function submit(s: SiteSession, form: ParsedForm, what: string): Promise<string> {
  const res = await s.fetch(form.action, { method: "POST", body: encodeForm(form) });
  const location = res.headers.get("location");
  // The builders answer a value they choke on server-side with a redirect to /error (live:
  // any `treasure` selection on create) — a failure, not a success redirect.
  if ((res.status === 302 || res.status === 303) && location && /^(https:\/\/www\.dndbeyond\.com)?\/error\b/.test(location)) {
    throw new DdbWriteError(`ddb-homebrew ${what} POST ${form.action} → DDB server error (redirected to ${location})`, res.status, location);
  }
  if ((res.status === 302 || res.status === 303) && location) return location;
  const errors = res.status === 200 ? formErrors(await res.text()) : [];
  const detail = errors.length ? errors.map((e) => `${e.label || e.id}: ${e.message}`).join("; ") : "no redirect — rejected";
  throw new DdbWriteError(`ddb-homebrew ${what} POST ${form.action} → ${res.status}: ${detail}`, res.status, errors);
}

/** The site's `a.ajax-post` links: POST with the RequestVerificationToken cookie echoed as a field. */
export async function ajaxPost(s: SiteSession, path: string, what: string): Promise<void> {
  if (!s.cookie("RequestVerificationToken")) {
    const r = await s.fetch("/refresh-request-verification-token", { method: "POST", headers: XHR });
    if (r.status !== 200 || !s.cookie("RequestVerificationToken")) {
      throw new DdbWriteError(`ddb-homebrew ${what}: could not mint a RequestVerificationToken (→ ${r.status})`, r.status, null);
    }
  }
  const body = new URLSearchParams({ "request-verification-token": s.cookie("RequestVerificationToken")! });
  const res = await s.fetch(path, { method: "POST", headers: XHR, body });
  const json = await res.json().catch(() => null) as { RedirectUrl?: string } | null;
  if (res.status !== 200 || !json?.RedirectUrl) {
    throw new DdbWriteError(`ddb-homebrew ${what} POST ${path} → ${res.status}: ${json ? JSON.stringify(json).slice(0, 200) : "not the expected {RedirectUrl} reply"}`, res.status, json);
  }
}


/** Control id → the values a fill set on it: what a re-read of the edit form must show. */
export type Asked = Map<string, string[]>;

/** Mismatches between what a fill asked and what the re-read edit form now holds. */
export function verifyEditForm(asked: Asked, edit: ParsedForm): string[] {
  const out: string[] = [];
  const norm = (vs: string[]) => [...vs].map((v) => v.trim()).sort();
  for (const [id, want] of asked) {
    const got = edit.controls.find((c) => c.id === id)?.values ?? [];
    if (JSON.stringify(norm(want)) !== JSON.stringify(norm(got))) out.push(`${id}: asked ${JSON.stringify(want)}, DDB has ${JSON.stringify(got)}`);
  }
  return out;
}

// --- eventual consistency ---
//
// DDB's builder pages and JSON reads are served from replicas/caches that lag writes (live: a
// species trait's edit page flipped old/new/old for minutes; game-data omitted the newest species
// in ~1 of 4 fetches). One read is therefore not proof either way. settle() re-reads with backoff
// until the check passes; only a mismatch that persists through the whole window is reported.
// A passing read can't be a false positive in practice: a stale replica shows the OLD state, which
// can only match the asked state if nothing was changed.

// ~60s in all. 30s proved too short live: game-data/feats took longer than that to list 3 of 15 freshly
// created feats (2026-10-13), turning successful creates into spurious verification failures.
export const SETTLE_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export async function settle<T>(read: () => Promise<{ value: T; mismatches: string[] }>, delaysMs: readonly number[] = SETTLE_DELAYS_MS): Promise<{ value: T; mismatches: string[] }> {
  let last = await read();
  for (const ms of delaysMs) {
    if (last.mismatches.length === 0) return last;
    await new Promise((r) => setTimeout(r, ms));
    last = await read();
  }
  return last;
}

/**
 * Delete a creation of any homebrew type, generic route. Confirmation can't come from reads:
 * monster-service and public view pages keep serving deleted homebrew, and even the edit page
 * flapped 404 → 200 → 404 after a feat delete. The firm oracle (live, feats and monsters):
 * re-POSTing the delete answers 404 once the creation is gone — a lagging replica would show the
 * entity as still present, never as missing, so a 404 is safe to trust.
 */
export async function deleteCreation(s: SiteSession, entityTypeId: number, id: number, editPath: string): Promise<{ id: number; deleted: true }> {
  await getPage(s, editPath); // ownership/existence check before the destructive call
  const path = `/homebrew/creations/delete?entityTypeId=${entityTypeId}&id=${id}`;
  await ajaxPost(s, path, `delete creation ${id}`);
  // ajaxPost minted the token above, so the re-check can reuse it.
  const again = await s.fetch(path, {
    method: "POST", headers: XHR,
    body: new URLSearchParams({ "request-verification-token": s.cookie("RequestVerificationToken") ?? "" }),
  });
  if (again.status !== 404) {
    throw new DdbWriteError(`ddb-homebrew: delete of creation ${id} was acknowledged, but a repeat delete answered ${again.status} instead of 404 — it may still exist`, again.status, null);
  }
  return { id, deleted: true };
}

// --- the generic modifier editor's subtypes ---
//
// Spells, magic items, feats, backgrounds, species traits and subclass features all share DDB's
// modifier editor (/modifier/create/{ownerId}-{ownerTypeId}/{n}, /spells/modifier/create/{id}).
// Its subtype <select> ships EMPTY (or, for spells, as one flat list full of duplicate labels);
// the page script fills it from an inline literal `var subTypes = [[{id,name,type}, …]]`, filtered
// by the chosen modifier type. A browserless fill must read that literal. The server checks only
// that a subtype is present, not that it belongs to the type (live: Sense + a Language subtype was
// accepted), so resolution here is the only guard on the pairing. Names can repeat within a type
// (28 duplicate pairs live, e.g. Language "Birdfolk"), so ambiguity is an error, not a guess.

export interface ModifierSubType { id: number; name: string; type: number }

/** The inline `var subTypes = [[…]]` catalogue on a modifier page. Throws if the page has none. */
export function embeddedSubTypes(html: string): ModifierSubType[] {
  const m = html.match(/var subTypes\s*=\s*(\[\[[\s\S]*?\]\]);/);
  if (!m) throw new Error("ddb-homebrew: modifier page has no inline subTypes catalogue (DDB changed the page?)");
  return (JSON.parse(m[1]) as ModifierSubType[][]).flat();
}

/**
 * The subtype id for (modifier type id, subtype name): exact name first, then case-insensitive.
 * Throws listing the valid names on a miss, and the candidate ids on an ambiguous name — pass the
 * numeric id instead to disambiguate.
 */
export function resolveSubType(subTypes: ModifierSubType[], typeId: number, nameOrId: string | number): number {
  const ofType = subTypes.filter((s) => s.type === typeId);
  if (typeof nameOrId === "number") {
    if (!ofType.some((s) => s.id === nameOrId)) throw new Error(`ddb-homebrew: subtype id ${nameOrId} does not belong to modifier type ${typeId}`);
    return nameOrId;
  }
  const want = nameOrId.trim();
  let hits = ofType.filter((s) => s.name === want);
  if (!hits.length) hits = ofType.filter((s) => s.name.toLowerCase() === want.toLowerCase());
  if (hits.length > 1) throw new Error(`ddb-homebrew: subtype "${want}" is ambiguous for modifier type ${typeId} — ids ${hits.map((h) => h.id).join(", ")}; pass the id`);
  if (!hits.length) {
    const names = ofType.map((s) => s.name).filter(Boolean);
    const shown = names.length > 60 ? `${names.slice(0, 60).join(", ")}, … (${names.length - 60} more)` : names.join(", ");
    throw new Error(`ddb-homebrew: "${want}" is not a subtype of modifier type ${typeId}. Valid: ${shown}`);
  }
  return hits[0].id;
}

/**
 * A modifier EDIT page's current subtype: the select doesn't mark it, the script does
 * (`var subTypesValue = 171;`, "0" when none). An edit must re-post it or the subtype is lost.
 */
export function embeddedSubTypeValue(html: string): number | null {
  const m = html.match(/var subTypesValue\s*=\s*(\d+)/);
  return m && m[1] !== "0" ? Number(m[1]) : null;
}

// --- the generic modifier form (/modifier/create/{ownerId}-{ownerEntityTypeId}/0) ---
//
// One form shape, live-identical on magic items, feats, species traits and subclass features
// (spells use their own /spells/modifier/create form; backgrounds' proficiency grants use the
// /…/{1|2|3} variant with a multi-select instead). Two per-owner extras arrive PRE-CHECKED:
// items' `requires-attunement` and subclass features' `available-to-multiclass` — so the caller's
// boolean is always applied explicitly, defaulting to false (an always-on modifier), never left
// to the form's default.

export interface HomebrewModifier {
  type: string;                                   // "Bonus", "Damage", "Resistance", "Sense", …
  subType: string | number;                       // name within the type, or the id when ambiguous
  stat?: string;                                  // "STR" … "CHA"
  dice?: { count: number; die: 4 | 6 | 8 | 10 | 12 | 20 };
  fixedValue?: number;
  additionalBonus?: string[];                     // "Proficiency Bonus", "Attuned Item Count", "Spell Level"
  restriction?: string;
  duration?: { interval: number; unit: "Round" | "Minute" | "Hour" | "Day" };
  requiresAttunement?: boolean;                   // magic items only
  availableToMulticlass?: boolean;                // subclass features only
}

/**
 * Fill a generic modifier form from a caller modifier. `html` is the page the form came from
 * (it carries the subtype catalogue). Returns the resolved {typeId, subTypeId} for verification.
 * A field the caller sets that this owner's form doesn't have is an error, not a silent drop.
 */
export function fillModifierForm(form: ParsedForm, html: string, m: HomebrewModifier): { typeId: number; subTypeId: number } {
  setControl(form, "field-spell-modifier-type", m.type);
  const typeId = Number(controlById(form, "field-spell-modifier-type").values[0]);
  const subTypeId = resolveSubType(embeddedSubTypes(html), typeId, m.subType);
  controlById(form, "field-spell-modifier-sub-type").values = [String(subTypeId)]; // JS-filled select: no options to match
  if (m.stat !== undefined) setControl(form, "field-rpg-stat", m.stat);
  if (m.dice) { setControl(form, "field-dice-count", m.dice.count); setControl(form, "field-dice-value", `d${m.dice.die}`); }
  if (m.fixedValue !== undefined) setControl(form, "field-fixed-value", m.fixedValue);
  if (m.additionalBonus !== undefined) setControl(form, "field-additional-bonus-type", m.additionalBonus);
  if (m.restriction !== undefined) setControl(form, "field-restriction", m.restriction);
  if (m.duration) { setControl(form, "field-duration-interval", m.duration.interval); setControl(form, "field-duration-unit", m.duration.unit); }
  const has = (id: string) => form.controls.some((c) => c.id === id);
  for (const [id, v, what] of [
    ["field-requires-attunement", m.requiresAttunement, "requiresAttunement"],
    ["field-available-to-multiclass", m.availableToMulticlass, "availableToMulticlass"],
  ] as const) {
    if (has(id)) setControl(form, id, v ?? false);
    else if (v !== undefined) throw new Error(`ddb-homebrew: this modifier form has no ${what} control`);
  }
  return { typeId, subTypeId };
}

/**
 * A creation's CURRENT edit path (slug included — it changes on rename, and edit URLs 404
 * without it). The site's generic `/homebrew/creations/edit?entityTypeId=&id=` answers 302 to it
 * for every type (live: monsters, magic items, species). Preferred over read services, which lag
 * writes (game-data can omit a just-created entry). Note it still redirects for a soft-deleted
 * creation; the edit GET that follows is what 404s.
 */
export async function resolveEditPath(s: SiteSession, entityTypeId: number, id: number): Promise<string> {
  const res = await s.fetch(`/homebrew/creations/edit?entityTypeId=${entityTypeId}&id=${id}`);
  const location = res.headers.get("location");
  if ((res.status !== 302 && res.status !== 303) || !location || !/\/edit\b/.test(location)) {
    throw new DdbWriteError(`ddb-homebrew: no edit page for creation ${id} (entity type ${entityTypeId}) → ${res.status}${location ? ` ${location}` : ""}. Is it one of this account's creations?`, res.status, location);
  }
  return location.replace(/^https:\/\/www\.dndbeyond\.com/, "");
}
