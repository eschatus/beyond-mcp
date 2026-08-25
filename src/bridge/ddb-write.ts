// D&D Beyond character-service mutations — the write counterpart to the reads in
// ddb-rt.ts / dndbeyond.ts. Each function is a thin typed wrapper over one v5 mutation
// route; there is NO policy here (whose sheet, whether Beyond20 owns it, when a write is
// appropriate). This module is a primitive surface — callers decide intent. Gating writes
// on at all is a deployment concern (DDB_WRITES) enforced where the tools register, not here.
//
// Auth is the same bearer JWT the reads use (verified live: the mutation routes accept it).
// Every route was contract-probed against the live service; the request/response shapes below
// are what character-service actually returned, not guesses.
//
// Route inventory (from docs/ddb-endpoint-atlas-notes.md) is far larger than this; wrappers
// are added here as each one's body shape is verified live. Unverified routes stay out.

import { rtRawFetch } from "./ddb-rt.js";

const CHAR_SVC = "https://character-service.dndbeyond.com/character/v5";

// character-service wraps every response as { id, success, message, data, pagination }.
export interface CharServiceEnvelope<T = unknown> {
  id: number;
  success: boolean;
  message: string;
  data: T;
  pagination: unknown;
}

export class DdbWriteError extends Error {
  constructor(message: string, readonly status: number, readonly detail: unknown) {
    super(message);
  }
}

async function mutate<T>(path: string, method: "PUT" | "POST" | "DELETE", body: Record<string, unknown>): Promise<CharServiceEnvelope<T>> {
  const res = await rtRawFetch(`${CHAR_SVC}/${path}`, { method, body: JSON.stringify(body) });
  const env = await res.json().catch(() => null) as CharServiceEnvelope<T> | null;
  if (!res.ok || !env?.success) {
    // character-service's 400s carry a `data` array naming the offending fields — surface it.
    const detail = env?.data ?? (await res.text().catch(() => ""));
    throw new DdbWriteError(
      `ddb-write ${method} ${path} → ${res.status}: ${env?.message ?? "request failed"}${Array.isArray(detail) ? ` (${detail.join("; ")})` : ""}`,
      res.status,
      detail,
    );
  }
  return env;
}

// --- HP (verified live) ---
// removedHitPoints is cumulative damage below max; 0 = full. temporaryHitPoints is separate.
// The site models "take 5 damage" as removedHitPoints += 5 and "heal" as removedHitPoints -=;
// this primitive sets the absolute values, so the caller does the arithmetic against a read.
export interface HpState { removedHitPoints: number; temporaryHitPoints: number }

export function setHitPoints(characterId: number, state: HpState): Promise<CharServiceEnvelope<HpState>> {
  return mutate("life/hp/damage-taken", "PUT", {
    characterId,
    removedHitPoints: Math.max(0, Math.trunc(state.removedHitPoints)),
    temporaryHitPoints: Math.max(0, Math.trunc(state.temporaryHitPoints)),
  });
}

// --- Conditions (verified live) ---
// id is the DDB condition id (1 blinded … 15 unconscious; 4 exhaustion uses level 1-6).
// PUT applies, DELETE removes. level is null for everything except exhaustion.
export interface ConditionResult { conditions: Array<{ id: number; level: number | null }> }

export function applyCondition(characterId: number, id: number, level: number | null = null): Promise<CharServiceEnvelope<ConditionResult>> {
  return mutate("condition", "PUT", { characterId, id, level });
}

export function removeCondition(characterId: number, id: number, level: number | null = null): Promise<CharServiceEnvelope<ConditionResult>> {
  return mutate("condition", "DELETE", { characterId, id, level });
}
