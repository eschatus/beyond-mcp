// D&D Beyond realtime transport — browserless reads over plain HTTP.
//
// This server NEVER opens a browser. The long-lived `CobaltSession` cookie is supplied
// from outside: the DDB_COBALT env var, or a data file written by whatever harvested it
// (the dm-whisper gem owns the interactive harvest UX). When the cookie is absent or
// rejected, every read fails loud with instructions — there is no silent fallback.
//
// Auth chain (validated live, see docs/ddb-browserless-protocol.md):
//   CobaltSession cookie ──POST auth-service/v1/cobalt-token──▶ short-lived JWT (ttl 300s)
//   JWT  ──Bearer──▶  character-service / monster-service reads
//   JWT + CobaltSession cookie (both)  ──▶  www.dndbeyond.com campaign APIs

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";

const AUTH_SVC = "https://auth-service.dndbeyond.com/v1/cobalt-token";
const CHAR_SVC = "https://character-service.dndbeyond.com/character/v5";
const MON_SVC = "https://monster-service.dndbeyond.com/v1/Monster";
const WWW = "https://www.dndbeyond.com";

// Same filename + shape ({cookie, harvestedAt}) as roll20-dm-mcp used, so pointing
// DDB_DATA_DIR at the gem's data dir shares the already-harvested cookie unchanged.
const cobaltFile = () => dataPath("ddb-cobalt.json");
// JWT lives 300s; refresh with a margin so a call never races the expiry.
const JWT_MARGIN_MS = 30_000;

// A realistic desktop-Chrome fingerprint. www.dndbeyond.com is Cloudflare-fronted but (validated)
// serves JSON to a plain fetch with this UA; the api hosts don't challenge at all.
const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- CobaltSession cookie (env → memory → data file; never a browser) ---

interface CobaltCache { cookie: string; harvestedAt: number }
let _cobaltMem: string | null = null;

function readCobaltFile(): string | null {
  try { return existsSync(cobaltFile()) ? (JSON.parse(readFileSync(cobaltFile(), "utf-8")) as CobaltCache).cookie : null; }
  catch { return null; }
}

export class CobaltUnavailableError extends Error {}

function noCobaltError(reason: "absent" | "rejected"): CobaltUnavailableError {
  const what = reason === "absent"
    ? "no D&D Beyond session cookie is available"
    : "the D&D Beyond session cookie was rejected (expired or revoked), and no fresher one is available";
  return new CobaltUnavailableError(
    `ddb-mcp: ${what}. This server never opens a browser — re-harvest CobaltSession in the gem ` +
    `(writes ${cobaltFile()}) or set DDB_COBALT in the env, then retry.`,
  );
}

/**
 * Resolve the cobalt cookie. `afterRejection` means the cookie we just used failed auth:
 * the only useful answer is a DIFFERENT cookie (the harvester may have written a fresh one
 * to disk, or the env changed under a supervisor) — returning the same one would just fail
 * again, so fail loud instead.
 */
function getCobalt(afterRejection = false): string {
  if (!afterRejection) {
    if (_cobaltMem) return _cobaltMem;
    const found = process.env.DDB_COBALT || readCobaltFile();
    if (found) { _cobaltMem = found; return found; }
    throw noCobaltError("absent");
  }
  const failed = _cobaltMem;
  const candidate = [process.env.DDB_COBALT, readCobaltFile()].find((c) => c && c !== failed);
  if (candidate) { _cobaltMem = candidate; return candidate; }
  throw noCobaltError("rejected");
}

// Cobalt if it's already available (env/mem/disk). Used by the optional damageAdjustments
// overlay, which must silently skip — never throw — when no cookie is around.
function peekCobalt(): string | null {
  return process.env.DDB_COBALT || _cobaltMem || readCobaltFile();
}

// --- cobalt → short-lived JWT (in-memory cache, re-read cobalt sources on 401) ---

interface JwtCache { token: string; expiresAt: number }
let _jwt: JwtCache | null = null;

async function exchangeForJwt(cobalt: string): Promise<{ token: string; ttl: number }> {
  const res = await fetch(AUTH_SVC, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json", Cookie: `CobaltSession=${cobalt}` },
    body: "{}",
  });
  if (!res.ok) {
    const err = new Error(`ddb-rt cobalt-token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<{ token: string; ttl: number }>;
}

async function getJwt(forceFresh = false): Promise<string> {
  if (!forceFresh && _jwt && Date.now() < _jwt.expiresAt) return _jwt.token;
  // Two attempts: a fresh exchange, then (on 401/403) whatever fresher cookie the
  // harvester may have written since we cached ours.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cobalt = getCobalt(attempt > 0);
    try {
      const { token, ttl } = await exchangeForJwt(cobalt);
      _jwt = { token, expiresAt: Date.now() + ttl * 1000 - JWT_MARGIN_MS };
      _cobaltMem = cobalt; // exchange succeeded → this cobalt is good; keep it hot
      return token;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (attempt === 0 && (status === 401 || status === 403)) { _jwt = null; continue; }
      throw err;
    }
  }
  throw new Error("ddb-rt: JWT exchange failed after retry");
}

// The DDB game-log WebSocket takes the JWT as an `stt` query param and the caller's
// numeric userId (the JWT's nameidentifier claim). Both come from the same cobalt→JWT
// exchange the REST reads use, so the game-log pump stays browserless. Returns a FRESH
// token (forceFresh) because the WS holds it for the whole connection — we want the
// full ~300s ttl, not a cached token about to expire. See docs/ddb-gamelog-pump.md.
const NAMEID_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";
export async function rtAuthToken(): Promise<{ token: string; userId: string; expiresAt: number }> {
  const token = await getJwt(true);
  let userId = "";
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    userId = String(claims[NAMEID_CLAIM] ?? "");
  } catch { /* malformed JWT — surface empty userId, caller decides */ }
  if (!userId) throw new Error("ddb-rt: could not derive userId from JWT claims");
  return { token, userId, expiresAt: _jwt?.expiresAt ?? Date.now() + 250_000 };
}

// --- plain-fetch core, with jwt-refresh on 401 and a retry on undici connection blips ---

// `cookie:true` attaches the raw CobaltSession alongside whatever `auth` mode is in play. The
// www.dndbeyond.com campaign APIs need BOTH the JWT bearer (for authorization) and the session
// cookie — cookie alone returns the SPA login HTML, bearer alone is rejected.
interface RtFetchOpts { auth?: "bearer" | "cookie" | "none"; cookie?: boolean; method?: string; body?: string }

async function rtFetch(url: string, opts: RtFetchOpts = {}): Promise<Response> {
  const auth = opts.auth ?? "bearer";
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = { ...BASE_HEADERS };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (auth === "bearer") headers["Authorization"] = `Bearer ${await getJwt(attempt > 0)}`;
    if (auth === "cookie" || opts.cookie) headers["Cookie"] = `CobaltSession=${getCobalt()}`;
    try {
      const res = await fetch(url, { method: opts.method ?? "GET", headers, ...(opts.body ? { body: opts.body } : {}) });
      // A 401 on a bearer call usually means the JWT lapsed mid-flight — refresh once and retry.
      if (res.status === 401 && auth === "bearer" && attempt === 0) { _jwt = null; continue; }
      return res;
    } catch (err) {
      // character-service intermittently throws undici "fetch failed" at connect time; one retry clears it.
      if (attempt === 0 && /fetch failed/i.test(String(err))) { await sleep(300); continue; }
      throw err;
    }
  }
  throw new Error(`ddb-rt: ${url} retries exhausted`);
}

async function rtJson<T>(url: string, opts?: RtFetchOpts): Promise<T> {
  const res = await rtFetch(url, opts);
  if (!res.ok) throw new Error(`ddb-rt ${url} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// --- typed reads (raw payloads; domain mapping stays in dndbeyond.ts) ---

// Full character-service v5 sheet `.data` — parseStats / getMaxHp / getCurrentHp work on top.
 
export async function rtGetRawCharacter(ddbCharId: number): Promise<any> {
  const data = await rtJson<{ data: unknown }>(`${CHAR_SVC}/character/${ddbCharId}`);
  return data.data;
}

// Raw monster-service v1 record (by id) or the best name match (search). NOTE: monster-service uses
// numeric-id fields and HTML *Description blobs — dndbeyond.ts maps it to DdbMonster.
 
export async function rtGetMonster(nameOrId: string | number): Promise<any> {
  const url = typeof nameOrId === "number"
    ? `${MON_SVC}?ids=${nameOrId}`
    : `${MON_SVC}?search=${encodeURIComponent(String(nameOrId))}&skip=0&take=10`;
  const data = await rtJson<{ data: unknown[] }>(url);
  const list = Array.isArray(data.data) ? data.data : [];
  if (list.length === 0) throw new Error(`ddb-rt: monster not found: ${nameOrId}`);
  if (typeof nameOrId === "number") return list[0];
  // Prefer an exact (case-insensitive) name match over search-rank order.
  const want = String(nameOrId).toLowerCase();
  return list.find((m) => String((m as { name?: string }).name ?? "").toLowerCase() === want) ?? list[0];
}

// The campaign/character APIs return HTML-escaped display names (e.g. "Wizards 3&amp;4").
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&quot;/g, '"');
}

export interface RtCampaign { id: string; name: string; playerCount?: number }

// The "campaign set" — every campaign the user is in (as DM or player). Same endpoint Avrae's
// WaterdeepClient uses (ddb/waterdeep.py); needs bearer + cookie (cookie alone = SPA login HTML).
export async function rtListCampaigns(): Promise<RtCampaign[]> {
  const data = await rtJson<{ data: Array<{ id: number; name: string; playerCount?: number }> }>(
    `${WWW}/api/campaign/stt/active-campaigns`,
    { auth: "bearer", cookie: true },
  );
  return (data.data ?? []).map((c) => ({ id: String(c.id), name: decodeEntities(c.name), playerCount: c.playerCount }));
}

export interface RtCampaignCharacter { id: number; characterName: string; characterAvatarUrl: string | null }

export async function rtGetCampaignCharacters(campaignId: string): Promise<RtCampaignCharacter[]> {
  const data = await rtJson<{ data: Array<{ id: number; name: string; avatarUrl: string | null }> }>(
    `${WWW}/api/campaign/stt/active-short-characters/${campaignId}`,
    { auth: "bearer", cookie: true },
  );
  return (data.data ?? []).map((c) => ({ id: c.id, characterName: decodeEntities(c.name), characterAvatarUrl: c.avatarUrl ?? null }));
}

// Raw fetch escape hatch (recon/diagnostics). Returns the Response so callers can inspect
// status/body without this module deciding what "success" looks like. Reads only.
export function rtRawFetch(url: string, opts: RtFetchOpts = {}): Promise<Response> {
  return rtFetch(url, opts);
}

// --- live damageAdjustments overlay (the one monster table that drifts as DDB adds content) ---
//
// The id→name tables in ddb-monster-tables.ts are baked from config/json. The stable ones (CR,
// alignment, size, movement, condition) never change. `damageAdjustments` accretes new ids over
// time, so we overlay it from the live config and disk-cache it with a 7-day TTL. config/json is
// ~57KB of mostly-irrelevant data, so we extract only the damageAdjustments slice into the cache.
// Best-effort: a fetch failure leaves the baked table in charge — this never throws.

const DDB_CONFIG_URL = `${WWW}/api/config/json`;
const monConfigFile = () => dataPath("ddb-monster-config.json");
const MON_CONFIG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DamageAdjustmentEntry { name: string; type: 1 | 2 | 3 }
interface MonConfigCache { fetchedAt: number; damageAdjustments: Record<string, DamageAdjustmentEntry> }

let _monConfigMem: Record<number, DamageAdjustmentEntry> | null = null;
let _monConfigRefreshing = false;

function keyById(rows: Array<{ id: number; name: string; type: number }>): Record<number, DamageAdjustmentEntry> {
  const out: Record<number, DamageAdjustmentEntry> = {};
  for (const r of rows) if (r && typeof r.id === "number") out[r.id] = { name: r.name, type: (r.type as 1 | 2 | 3) };
  return out;
}

async function fetchDamageAdjustments(): Promise<Record<number, DamageAdjustmentEntry>> {
  // Only refresh when cobalt is ALREADY available — the optional overlay must never fail a
  // monster lookup over auth. In offline/CI/test environments (no cobalt) this skips instantly.
  if (!peekCobalt()) throw new Error("ddb-rt: no cobalt available; skipping damageAdjustments overlay (baked table used)");
  // config/json is served to a plain cookie'd fetch (validated); cookie alone is enough here.
  const data = await rtJson<{ data?: { damageAdjustments?: Array<{ id: number; name: string; type: number }> } } & { damageAdjustments?: Array<{ id: number; name: string; type: number }> }>(
    DDB_CONFIG_URL,
    { auth: "cookie" },
  );
  const rows = (data.data?.damageAdjustments ?? data.damageAdjustments ?? []);
  const map = keyById(rows);
  if (Object.keys(map).length === 0) throw new Error("ddb-rt: config/json had no damageAdjustments");
  mkdirSync(path.dirname(monConfigFile()), { recursive: true });
  writeFileSync(monConfigFile(), JSON.stringify({ fetchedAt: Date.now(), damageAdjustments: map } as MonConfigCache), "utf-8");
  _monConfigMem = map;
  return map;
}

// Returns the live damageAdjustments overlay, or null if it can never be obtained (offline cold
// start with no cache). Loads from memory → disk → live fetch; refreshes a stale disk cache in the
// background so the calling monster lookup is never blocked on a refresh.
export async function rtGetDamageAdjustments(): Promise<Record<number, DamageAdjustmentEntry> | null> {
  if (_monConfigMem) return _monConfigMem;
  if (existsSync(monConfigFile())) {
    try {
      const c = JSON.parse(readFileSync(monConfigFile(), "utf-8")) as MonConfigCache;
      _monConfigMem = keyById(Object.entries(c.damageAdjustments).map(([id, v]) => ({ id: Number(id), name: v.name, type: v.type })));
      if (Date.now() - c.fetchedAt > MON_CONFIG_TTL_MS && !_monConfigRefreshing) {
        _monConfigRefreshing = true;
        fetchDamageAdjustments().catch(() => {}).finally(() => { _monConfigRefreshing = false; });
      }
      return _monConfigMem;
    } catch { /* corrupt cache → fall through to a background refresh */ }
  }
  // No cache yet — refresh in the BACKGROUND and return null so the caller uses the baked table.
  // A monster lookup must never block on the optional overlay (in offline environments the live
  // fetch can hang, and getMonster awaits this concurrently with the monster fetch).
  if (!_monConfigRefreshing) {
    _monConfigRefreshing = true;
    fetchDamageAdjustments().catch(() => {}).finally(() => { _monConfigRefreshing = false; });
  }
  return null;
}
