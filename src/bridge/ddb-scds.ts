// D&D Beyond SCDS (Simplified Character Data Service) — the site's own precomputed
// combat-snapshot service. One POST returns a *resolved* view of many characters at once:
// computed AC, max/current/temp HP, named conditions, death saves, initiative, passives,
// senses, skills, resistances/immunities, resolved attacks (to-hit + damage dice), and
// casting info — the numbers the character sheet derives client-side from the raw v5 payload.
//
// Verified live (2026-08-25): POST character-service-scds.../v2/characters
// { characterIds: number[] }  (min 1, max 99) → { foundCharacters: [...] }, authenticated
// with the same cobalt→JWT bearer the other reads use. GET variants 403 (the host wants a
// different auth scheme on GET); the POST batch is the supported path.
//
// This is the authoritative source for AC and max HP — the raw v5 sheet carries neither in
// computed form (see docs/ddb-endpoint-atlas-notes.md, issue #5).

import { rtRawFetch } from "./ddb-rt.js";

const SCDS_URL = "https://character-service-scds.dndbeyond.com/v2/characters";
const MAX_BATCH = 99;

export interface ScdsDamage { type: string | null; value: { diceString: string | null; diceCount: number | null; diceValue: number | null; diceMultiplier: number | null; fixedValue: number | null } }
export interface ScdsAttack {
  name: string;
  toHit: number | null;
  damage: ScdsDamage | null;
  saveInfo: { dc: number; ability: string } | null;
  range: { value: number | null; longRangeValue: number | null; label: string; origin: string | null } | null;
}
export interface ScdsHitPoints { current: number; maximum: number; temp: number }
export interface ScdsCondition { name: string; level: number | null }

// The service returns ~35 fields per character; these are the ones consumers read. Unlisted
// fields (decorations, proficiencyGroups, campaignSetting, …) pass through on the `raw` escape.
export interface ScdsCharacter {
  characterId: number;
  name: string;
  level: number;
  classes: Array<{ name?: string; level?: number }> | unknown;
  race: unknown;
  armorClass: number;
  hitPointInfo: ScdsHitPoints;
  conditions: ScdsCondition[];
  deathSaveInfo: { successCount: number; failCount: number };
  initiativeBonus: number;
  initiativeScore: number;
  proficiencyBonus: number;
  passivePerception: number;
  passiveInsight: number;
  passiveInvestigation: number;
  abilities: unknown;
  skills: unknown;
  senses: unknown;
  speeds: unknown;
  resistances: unknown;
  immunities: unknown;
  vulnerabilities: unknown;
  attacks: ScdsAttack[];
  castingInfo: unknown;
  inspiration: boolean;
  currentXp: number;
  userId: number;
  isAssignedToPlayer: boolean;
  readOnlyUrl: string;
  [k: string]: unknown;
}

async function postBatch(ids: number[]): Promise<ScdsCharacter[]> {
  const res = await rtRawFetch(SCDS_URL, { method: "POST", body: JSON.stringify({ characterIds: ids }) });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ddb-scds ${res.status}: ${detail}`);
  }
  const body = await res.json() as { foundCharacters?: ScdsCharacter[] };
  return body.foundCharacters ?? [];
}

/**
 * Precomputed combat snapshot for the given character ids, in one round-trip per 99 ids.
 * Characters the service can't resolve are silently absent from the result (it returns only
 * `foundCharacters`), so callers should diff against the requested ids to detect misses.
 */
export async function rtGetPartySnapshot(characterIds: number[]): Promise<ScdsCharacter[]> {
  const ids = [...new Set(characterIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return [];
  const out: ScdsCharacter[] = [];
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    out.push(...await postBatch(ids.slice(i, i + MAX_BATCH)));
  }
  return out;
}
