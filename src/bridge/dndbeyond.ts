// D&D Beyond domain layer: raw service payloads (ddb-rt.ts) → typed shapes and stats.
//
// D&D Beyond is READ-ONLY in this server, permanently — no write path exists or will be
// added (see docs/ddb-browserless-protocol.md, "Writes"). And there is no browser: the
// old Playwright fallbacks (DOM scrapes, the page-intercept 403 workaround for
// DM-accessible sheets) stayed behind in roll20-dm-mcp and were not carried here.

import { rtGetRawCharacter, rtGetMonster, rtListCampaigns, rtGetCampaignCharacters, rtGetDamageAdjustments } from "./ddb-rt.js";
import {
  challengeRatingLabel, ALIGNMENTS, SIZES, MOVEMENTS, CONDITIONS, DAMAGE_ADJUSTMENTS,
  type DamageAdjustment,
} from "./ddb-monster-tables.js";

export interface DdbCharacter {
  id: number;
  name: string;
  // HP fields as returned by character-service API (Avrae-compatible naming)
  baseHitPoints: number;        // hit dice sum only — Con modifier NOT included
  bonusHitPoints: number | null;
  overrideHitPoints: number | null;
  removedHitPoints: number;
  temporaryHitPoints: number;
  conditions: { id: number; level: number | null }[];
  avatarUrl: string | null;
  armorClass: number;
  passivePerception: number;
  // Present in raw API response — used to compute Con-modifier HP contribution
  classes: Array<{ level: number }>;
  stats: Array<{ id: number; value: number | null }>;  // id 3 = Constitution
}

export function getMaxHp(char: DdbCharacter): number {
  const totalLevel = (char.classes ?? []).reduce((s, c) => s + c.level, 0);
  const conScore = (char.stats ?? []).find(s => s.id === 3)?.value ?? 10;
  const conMod = Math.floor((conScore - 10) / 2);
  return char.overrideHitPoints ?? (char.baseHitPoints + (char.bonusHitPoints ?? 0) + conMod * totalLevel);
}

export function getCurrentHp(char: DdbCharacter): number {
  return getMaxHp(char) - char.removedHitPoints;
}

const DDB_CONDITION_NAMES: Record<number, string> = {
  1:"blinded", 2:"charmed", 3:"deafened", 4:"exhaustion", 5:"frightened",
  6:"grappled", 7:"incapacitated", 8:"invisible", 9:"paralyzed", 10:"petrified",
  11:"poisoned", 12:"prone", 13:"restrained", 14:"stunned", 15:"unconscious",
};

const ABILITY_IDS: Record<number, string> = { 1:"strength",2:"dexterity",3:"constitution",4:"intelligence",5:"wisdom",6:"charisma" };
const SKILL_TO_ABILITY: Record<string, number> = {
  "acrobatics":2,"animal-handling":5,"arcana":4,"athletics":1,"deception":6,
  "history":4,"insight":5,"intimidation":6,"investigation":4,"medicine":5,
  "nature":4,"perception":5,"performance":6,"persuasion":6,"religion":4,
  "sleight-of-hand":2,"stealth":2,"survival":5,
};

export interface DdbCharacterStats {
  name: string; level: number; classes: string; proficiencyBonus: number;
  abilityScores: Record<string, number>;
  abilityMods: Record<string, number>;
  savingThrows: Record<string, { bonus: number; proficient: boolean }>;
  skills: Record<string, { bonus: number; proficient: boolean; expertise: boolean }>;
  initiativeBonus: number; passivePerception: number; walkSpeed: number;
  armorClass: number;
  hp: { max: number; current: number; temp: number };
  conditions: string[];  // active condition names, lowercased
}

 
export function parseStats(raw: any): DdbCharacterStats {
  // Final ability scores: override > base + modifier bonuses
  const scores: Record<string, number> = {};
  for (const stat of (raw.stats ?? [])) {
    scores[ABILITY_IDS[stat.id as number]] = stat.value as number;
  }
  const overrides: Record<number, number | null> = {};
  for (const s of (raw.overrideStats ?? [])) overrides[s.id] = s.value;

  const allMods: { type: string; subType: string; value: number | null }[] =
    [...(raw.modifiers?.race ?? []), ...(raw.modifiers?.class ?? []),
     ...(raw.modifiers?.background ?? []), ...(raw.modifiers?.item ?? []),
     ...(raw.modifiers?.feat ?? []), ...(raw.modifiers?.condition ?? [])];

  const finalScores: Record<string, number> = {};
  for (const [idStr, ability] of Object.entries(ABILITY_IDS)) {
    const id = parseInt(idStr);
    if (overrides[id] != null) { finalScores[ability] = overrides[id]!; continue; }
    let score = scores[ability] ?? 10;
    for (const m of allMods) {
      if (m.type === "bonus" && m.subType === `${ability}-score` && m.value != null) score += m.value;
    }
    finalScores[ability] = score;
  }

  const abilityMods: Record<string, number> = {};
  for (const [a, s] of Object.entries(finalScores)) abilityMods[a] = Math.floor((s - 10) / 2);

  const totalLevel = (raw.classes ?? []).reduce((sum: number, c: { level: number }) => sum + c.level, 0);
  const pb = Math.floor((Math.max(totalLevel, 1) - 1) / 4) + 2;

  const profSet = new Set<string>(), expertSet = new Set<string>(), halfSet = new Set<string>();
  for (const m of allMods) {
    if (m.subType) {
      if (m.type === "proficiency") profSet.add(m.subType);
      else if (m.type === "expertise") expertSet.add(m.subType);
      else if (m.type === "half-proficiency") halfSet.add(m.subType);
    }
  }

  const savingThrows: Record<string, { bonus: number; proficient: boolean }> = {};
  for (const ability of Object.values(ABILITY_IDS)) {
    const prof = profSet.has(`${ability}-saving-throws`);
    savingThrows[ability] = { bonus: abilityMods[ability] + (prof ? pb : 0), proficient: prof };
  }

  const skills: Record<string, { bonus: number; proficient: boolean; expertise: boolean }> = {};
  for (const [skill, abilityId] of Object.entries(SKILL_TO_ABILITY)) {
    const ability = ABILITY_IDS[abilityId];
    const prof = profSet.has(skill), exp = expertSet.has(skill), half = halfSet.has(skill);
    const bonus = abilityMods[ability] + (exp ? pb * 2 : prof ? pb : half ? Math.floor(pb / 2) : 0);
    skills[skill] = { bonus, proficient: prof, expertise: exp };
  }

  let initiativeBonus = abilityMods["dexterity"];
  for (const m of allMods) {
    if (m.type === "bonus" && m.subType === "initiative" && m.value != null) initiativeBonus += m.value;
  }

  const percBonus = skills["perception"]?.bonus ?? abilityMods["wisdom"];
  const walkSpeed = raw.race?.weightSpeeds?.normal?.walk ?? 30;
  const conMod = abilityMods["constitution"] ?? 0;
  const maxHp = raw.overrideHitPoints ?? ((raw.baseHitPoints ?? 0) + (raw.bonusHitPoints ?? 0) + conMod * totalLevel);

  return {
    name: raw.name as string,
    level: totalLevel,
    classes: (raw.classes ?? []).map((c: { level: number; definition: { name: string } }) => `${c.definition?.name ?? "?"}${c.level}`).join(" / "),
    proficiencyBonus: pb,
    abilityScores: finalScores,
    abilityMods,
    savingThrows,
    skills,
    initiativeBonus,
    passivePerception: 10 + percBonus,
    walkSpeed,
    armorClass: raw.armorClass ?? 10,
    hp: { max: maxHp, current: maxHp - (raw.removedHitPoints ?? 0), temp: raw.temporaryHitPoints ?? 0 },
    conditions: (raw.conditions ?? [])
      .map((c: { id: number }) => DDB_CONDITION_NAMES[c.id])
      .filter(Boolean),
  };
}

export async function getCharacterStats(ddbCharId: number): Promise<DdbCharacterStats> {
  const raw = await getRawCharacter(ddbCharId);
  return parseStats(raw);
}

 
export async function getRawCharacter(ddbCharId: number): Promise<any> {
  return rtGetRawCharacter(ddbCharId);
}

export async function getCharacter(ddbCharId: number): Promise<DdbCharacter> {
  try {
    return await rtGetRawCharacter(ddbCharId) as DdbCharacter;
  } catch (err) {
    // roll20-dm-mcp worked around 403s (DM-accessible sheets that reject direct API auth)
    // with a browser page-intercept. This server is browserless, so surface what to do instead.
    if (String(err).includes("403")) {
      throw new Error(
        `ddb-mcp: character ${ddbCharId} returned 403 — the sheet rejects direct API auth for this ` +
        `account (typically a DM-shared sheet). Browserless reads can't work around this: set the ` +
        `sheet's privacy to Public/Campaign, or use the sheet owner's CobaltSession.`,
        { cause: err },
      );
    }
    throw err;
  }
}

export interface DdbCampaignCharacter {
  id: number;
  characterName: string;
  characterAvatarUrl: string | null;
}

export async function getCampaignCharacters(campaignId: string): Promise<DdbCampaignCharacter[]> {
  return rtGetCampaignCharacters(campaignId);
}

export async function listCampaigns(): Promise<{ id: string; name: string }[]> {
  return rtListCampaigns();
}

export interface DdbMonsterAbility {
  name: string;
  description: string;
}

export interface DdbMonsterSpeed {
  walk?: number;
  fly?: number;
  swim?: number;
  burrow?: number;
  climb?: number;
  canHover?: boolean;
}

export interface DdbMonster {
  id: number;
  name: string;
  averageHitPoints: number;
  armorClass: number;
  challengeRating: string;
  largeAvatarUrl: string | null;
  stats?: Array<{ id: number; value: number | null }>;  // id 1-6: STR DEX CON INT WIS CHA
  speed?: DdbMonsterSpeed;
  alignment?: string;
  size?: string;
  specialTraits?: DdbMonsterAbility[];
  actions?: DdbMonsterAbility[];
  reactions?: DdbMonsterAbility[];
  legendaryActions?: DdbMonsterAbility[];
  bonusActions?: DdbMonsterAbility[];
  damageImmunities?: string[];
  damageResistances?: string[];
  damageVulnerabilities?: string[];
  conditionImmunities?: string[];
}

// The raw monster-service v1 record. Numeric-id fields and HTML *Description blobs that
// mapRawMonster decodes into the clean DdbMonster shape above.
interface RawDdbMonster {
  id: number;
  name: string;
  averageHitPoints: number;
  armorClass: number;
  largeAvatarUrl: string | null;
  challengeRatingId?: number | null;
  alignmentId?: number | null;
  sizeId?: number | null;
  stats?: Array<{ statId: number; value: number | null }>;
  movements?: Array<{ movementId: number; speed: number }>;
  damageAdjustments?: number[];
  conditionImmunities?: number[];
  specialTraitsDescription?: string | null;
  actionsDescription?: string | null;
  reactionsDescription?: string | null;
  legendaryActionsDescription?: string | null;
  bonusActionsDescription?: string | null;
}

function decodeMonsterEntities(s: string): string {
  return s
    // numeric entities first — homebrew statblocks litter descriptions with &#160; (nbsp) etc.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–");
}

function stripHtml(html: string): string {
  return decodeMonsterEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// Parse a monster-service *Description HTML blob into named abilities. Each <p> whose lead run is
// bolded (`<strong>Name.</strong>`, optionally inside `<em>`) starts a new ability; a <p> with no
// bold lead is appended to the previous ability's description (multi-paragraph traits/actions, and
// the un-bolded intro line on legendary-action blocks).
function parseAbilityBlock(html: string | null | undefined): DdbMonsterAbility[] {
  if (!html) return [];
  const out: DdbMonsterAbility[] = [];
  const paras = html.split(/<\/p>/i).map((p) => p.replace(/<p[^>]*>/i, "")).filter((p) => stripHtml(p).length > 0);
  for (const para of paras) {
    const full = stripHtml(para);
    const boldMatch = para.match(/<strong>([\s\S]*?)<\/strong>/i);
    const startsBold = boldMatch != null && /^\s*<(em|strong)\b/i.test(para);
    if (startsBold) {
      const lead = stripHtml(boldMatch![1]);                 // e.g. "Devil's Sight." or "Fork."
      const name = lead.replace(/[.:\s]+$/, "").trim();
      const description = full.startsWith(lead) ? full.slice(lead.length).trim() : full;
      out.push({ name, description });
    } else if (out.length > 0) {
      out[out.length - 1].description = `${out[out.length - 1].description}\n${full}`.trim();
    } else {
      out.push({ name: "", description: full });
    }
  }
  return out;
}

// Decode the monster-service damageAdjustments id array into resistance/immunity/vulnerability
// name lists. Prefers the live overlay (newer ids than the baked table), falls back to baked.
function splitDamageAdjustments(
  ids: number[] | undefined,
  overlay: Record<number, DamageAdjustment> | null,
): { resistances: string[]; immunities: string[]; vulnerabilities: string[] } {
  const resistances: string[] = [], immunities: string[] = [], vulnerabilities: string[] = [];
  for (const id of ids ?? []) {
    const adj = overlay?.[id] ?? DAMAGE_ADJUSTMENTS[id];
    if (!adj) continue;
    (adj.type === 2 ? immunities : adj.type === 3 ? vulnerabilities : resistances).push(adj.name);
  }
  return { resistances, immunities, vulnerabilities };
}

function mapRawMonster(raw: RawDdbMonster, overlay: Record<number, DamageAdjustment> | null): DdbMonster {
  const speed: DdbMonsterSpeed = {};
  for (const m of raw.movements ?? []) {
    const key = MOVEMENTS[m.movementId];
    if (key) speed[key] = m.speed;
  }
  const { resistances, immunities, vulnerabilities } = splitDamageAdjustments(raw.damageAdjustments, overlay);
  return {
    id: raw.id,
    name: raw.name,
    averageHitPoints: raw.averageHitPoints,
    armorClass: raw.armorClass,
    challengeRating: challengeRatingLabel(raw.challengeRatingId),
    largeAvatarUrl: raw.largeAvatarUrl ?? null,
    stats: (raw.stats ?? []).map((s) => ({ id: s.statId, value: s.value })),
    speed,
    alignment: raw.alignmentId != null ? ALIGNMENTS[raw.alignmentId] : undefined,
    size: raw.sizeId != null ? SIZES[raw.sizeId] : undefined,
    specialTraits: parseAbilityBlock(raw.specialTraitsDescription),
    actions: parseAbilityBlock(raw.actionsDescription),
    reactions: parseAbilityBlock(raw.reactionsDescription),
    legendaryActions: parseAbilityBlock(raw.legendaryActionsDescription),
    bonusActions: parseAbilityBlock(raw.bonusActionsDescription),
    damageResistances: resistances,
    damageImmunities: immunities,
    damageVulnerabilities: vulnerabilities,
    conditionImmunities: (raw.conditionImmunities ?? []).map((id) => CONDITIONS[id]).filter((s): s is string => !!s),
  };
}

export async function getMonster(nameOrId: string | number): Promise<DdbMonster> {
  // Hit the live monster-service v1 endpoint and normalize its id-array / HTML-blob shape
  // into DdbMonster via mapRawMonster.
  const [raw, overlay] = await Promise.all([rtGetMonster(nameOrId), rtGetDamageAdjustments()]);
  return mapRawMonster(raw as RawDdbMonster, overlay);
}

export function getMonsterAbilityScores(monster: DdbMonster): Record<string, number> {
  const scores: Record<string, number> = { strength:10, dexterity:10, constitution:10, intelligence:10, wisdom:10, charisma:10 };
  for (const stat of (monster.stats ?? [])) {
    const ability = ABILITY_IDS[stat.id];
    if (ability && stat.value != null) scores[ability] = stat.value;
  }
  return scores;
}

export function getMonsterAbilities(monster: DdbMonster): string {
  const lines: string[] = [];

  if (monster.speed) {
    const parts: string[] = [];
    if (monster.speed.walk) parts.push(`${monster.speed.walk}ft walk`);
    if (monster.speed.fly) parts.push(`${monster.speed.fly}ft fly${monster.speed.canHover ? " (hover)" : ""}`);
    if (monster.speed.swim) parts.push(`${monster.speed.swim}ft swim`);
    if (monster.speed.burrow) parts.push(`${monster.speed.burrow}ft burrow`);
    if (monster.speed.climb) parts.push(`${monster.speed.climb}ft climb`);
    if (parts.length > 0) lines.push(`Speed: ${parts.join(", ")}`);
  }

  if (monster.alignment) lines.push(`Alignment: ${monster.alignment}`);

  const formatAbilities = (label: string, items: DdbMonsterAbility[] | undefined) => {
    if (!items || items.length === 0) return;
    lines.push(`${label}:`);
    for (const item of items) {
      lines.push(`  ${item.name}: ${item.description}`);
    }
  };

  formatAbilities("Special Traits", monster.specialTraits);
  formatAbilities("Actions", monster.actions);
  formatAbilities("Bonus Actions", monster.bonusActions);
  formatAbilities("Reactions", monster.reactions);
  formatAbilities("Legendary Actions", monster.legendaryActions);

  const resistances: string[] = [];
  if (monster.damageImmunities?.length) resistances.push(`Immune: ${monster.damageImmunities.join(", ")}`);
  if (monster.damageResistances?.length) resistances.push(`Resistant: ${monster.damageResistances.join(", ")}`);
  if (monster.damageVulnerabilities?.length) resistances.push(`Vulnerable: ${monster.damageVulnerabilities.join(", ")}`);
  if (monster.conditionImmunities?.length) resistances.push(`Condition immune: ${monster.conditionImmunities.join(", ")}`);
  if (resistances.length > 0) lines.push(resistances.join("  "));

  return lines.join("\n");
}
