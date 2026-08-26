import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rtGetCampaignCharacters, type RtCampaignCharacter } from "../bridge/ddb-rt.js";
import { DdbGameLogPump, summarizeRoll, type DdbGameLogMessage } from "../bridge/ddb-gamelog.js";
import { RollBuffer, type BufferedRoll } from "../bridge/roll-buffer.js";
import { text } from "./helpers.js";

// One pump per server process — a single WebSocket to a DDB campaign's game log.
// Captured rolls land in a bounded buffer; consumers drain it with ddb_poll_rolls
// (or subscribe to the HTTP entry's /events SSE stream). This server never posts
// rolls anywhere — bridging into a VTT (e.g. roll20-dm-mcp post_roll_as_character)
// is the caller's job.
let pump: DdbGameLogPump | null = null;
let pumpInfo: { gameId: string; names: string[]; started: number } | null = null;
const buffer = new RollBuffer(10);

// Live subscription hook for the HTTP entry's SSE stream.
type RollListener = (roll: BufferedRoll) => void;
const listeners = new Set<RollListener>();
export function onBufferedRoll(fn: RollListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Match one requested name to exactly one campaign character. Exact (case-insensitive) wins;
 * otherwise a substring match in either direction, but only when it lands on a single
 * character — "Kai" against both "Kaila" and "Kairon" is ambiguous, not a coin flip.
 *
 * Roster entries with blank names are skipped: `"broo".includes("")` is true, so a nameless
 * character absorbed EVERY request and the pump armed on its entityId — reporting success,
 * then capturing nothing.
 */
export function matchByName(chars: RtCampaignCharacter[], name: string): { hit?: RtCampaignCharacter; candidates: RtCampaignCharacter[] } {
  const want = name.trim().toLowerCase();
  if (!want) return { candidates: [] };
  const named = chars.filter((c) => (c.characterName ?? "").trim().length > 0);

  const exact = named.filter((c) => c.characterName.trim().toLowerCase() === want);
  if (exact.length === 1) return { hit: exact[0], candidates: exact };

  const partial = named.filter((c) => {
    const have = c.characterName.trim().toLowerCase();
    return have.includes(want) || want.includes(have);
  });
  return partial.length === 1 ? { hit: partial[0], candidates: partial } : { candidates: partial };
}

interface EntityResolution { ids: string[]; resolved: string[]; missing: string[]; ambiguous: string[] }

async function resolveEntityIds(gameId: string, names: string[]): Promise<EntityResolution> {
  const chars = await rtGetCampaignCharacters(gameId);       // [{ id, characterName }]
  const ids: string[] = [], resolved: string[] = [], missing: string[] = [], ambiguous: string[] = [];
  for (const n of names) {
    const { hit, candidates } = matchByName(chars, n);
    if (hit) { ids.push(String(hit.id)); resolved.push(`${n} → ${hit.characterName} (${hit.id})`); }
    else if (candidates.length > 1) ambiguous.push(`${n} → ${candidates.map((c) => c.characterName).join(" / ")}`);
    else missing.push(n);
  }
  return { ids, resolved, missing, ambiguous };
}

export function registerDdbPumpTools(server: McpServer): void {
  server.tool(
    "start_ddb_roll_pump",
    "Capture live D&D Beyond dice rolls from a campaign's game log. Subscribes (browserless) to the DDB game-log WebSocket and buffers each fulfilled roll — drain with ddb_poll_rolls and bridge into your VTT yourself (this server posts nothing anywhere; rolls MUST be mirrored, never re-rolled). By default it SKIPS rolls Beyond20 already bridged to the table (data.__b20Override__), so what you drain is exactly the gap a flaky Beyond20 left — safe to arm table-wide (omit characterNames) or per-player without double-posting downstream.",
    {
      characterNames: z.array(z.string()).optional().describe("DDB character names to capture, e.g. [\"Broo Zbaaner\"]. Omit to cover EVERY character."),
      gameId: z.string().optional().describe("D&D Beyond game/campaign id to read. Defaults to the DDB_CAMPAIGN_ID env var."),
      includeBeyond20: z.boolean().optional().describe("Default false. Leave false to skip rolls Beyond20 already bridged (the gap-fill behavior). Set true ONLY to capture EVERY roll regardless — bridging then double-posts anything Beyond20 also delivers."),
    },
    async ({ characterNames, gameId, includeBeyond20 }) => {
      const game = gameId || process.env.DDB_CAMPAIGN_ID;
      if (!game || game === "0") return text("No gameId given and DDB_CAMPAIGN_ID is not set — pass the DDB campaign id (find it with ddb_list_campaigns).");

      if (pump) { pump.stop(); pump = null; }
      buffer.clear();

      let entityIds: string[] | undefined;
      let resolvedNote = "all characters";
      if (characterNames?.length) {
        const { ids, resolved, missing, ambiguous } = await resolveEntityIds(game, characterNames);
        if (!ids.length) {
          return text(
            `None of [${characterNames.join(", ")}] matched exactly one character in DDB game ${game}.` +
            (ambiguous.length ? ` AMBIGUOUS: ${ambiguous.join("; ")} — use the full name.` : "") +
            " Check the names (list them with ddb_list_campaign_characters).",
          );
        }
        entityIds = ids;
        resolvedNote = resolved.join("; ")
          + (missing.length ? ` · UNMATCHED: ${missing.join(", ")}` : "")
          + (ambiguous.length ? ` · AMBIGUOUS, skipped: ${ambiguous.join("; ")}` : "");
      }

      pumpInfo = { gameId: game, names: characterNames ?? [], started: Date.now() };
      pump = new DdbGameLogPump({
        gameId: game,
        entityIds,
        skipBeyond20: includeBeyond20 !== true,
        onStatus: (s) => console.error(s),
        onRoll: (m: DdbGameLogMessage) => {
          const entry = buffer.push(m);
          for (const fn of listeners) {
            try { fn(entry); } catch (e) { console.error(`[ddb-pump] listener failed: ${(e as Error).message}`); }
          }
        },
      });
      await pump.start();
      const mode = includeBeyond20 ? "ALL rolls (incl. Beyond20-bridged)" : "gap-fill (skips rolls Beyond20 already bridged)";
      return text(`D&D Beyond roll pump ARMED — game ${game}, capturing: ${resolvedNote}. Mode: ${mode}. Drain with ddb_poll_rolls; stop with stop_ddb_roll_pump.`);
    }
  );

  server.tool(
    "ddb_poll_rolls",
    "Drain dice rolls the pump has captured since a cursor. Returns each roll's seq (the cursor), a one-line summary, and the raw DDB game-log message (mirror its actual dice values when bridging — never re-roll). Pass the previous response's cursor as `after`; start with 0 (or omit) for everything buffered.",
    {
      after: z.number().int().nonnegative().optional().describe("Return only rolls with seq > after. Use the `cursor` from the previous poll. Default 0."),
    },
    async ({ after }) => {
      if (!pump) return text("Roll pump: not running — start_ddb_roll_pump first.");
      const cursor = after ?? 0;
      const rolls = buffer.since(cursor);
      // A cursor pointing before the eviction horizon means the caller polled too slowly
      // for the buffer cap — say so instead of silently skipping.
      const oldest = buffer.oldestSeq;
      const missed = oldest != null && cursor + 1 < oldest ? oldest - cursor - 1 : 0;
      const s = pump.status();
      return text(JSON.stringify({
        rolls: rolls.map((r) => ({ seq: r.seq, receivedAt: r.receivedAt, summary: summarizeRoll(r.message), message: r.message })),
        cursor: buffer.lastSeq,
        missed,
        pump: { state: s.state, failures: s.failures, lastError: s.lastError },
      }));
    }
  );

  server.tool(
    "stop_ddb_roll_pump",
    "Stop the D&D Beyond roll pump (disconnect the game-log WebSocket). Buffered rolls remain drainable until the next start.",
    {},
    async () => {
      if (!pump) return text("No roll pump is running.");
      pump.stop(); pump = null;
      pumpInfo = null;
      return text(`Roll pump stopped. Captured ${buffer.lastSeq} roll(s) this session (still drainable via ddb_poll_rolls until the next start).`);
    }
  );

  server.tool(
    "ddb_roll_pump_status",
    "Report the D&D Beyond roll pump's connection health (CONNECTED vs RETRYING, consecutive failures, last error) and how many rolls it has captured. RETRYING with a climbing failure count means the socket keeps dropping — usually an expired DDB session cookie; re-harvest and restart the pump.",
    {},
    async () => {
      if (!pump || !pumpInfo) return text("Roll pump: not running.");
      const mins = Math.round((Date.now() - pumpInfo.started) / 60000);
      // Connection health, not object existence — a pump in a reconnect loop must
      // not report as healthy (roll20-dm-mcp#166).
      const s = pump.status();
      const health =
        s.state === "connected" ? "CONNECTED" :
        s.state === "retrying" ? `RETRYING (${s.failures} consecutive failure${s.failures === 1 ? "" : "s"})` :
        s.state.toUpperCase();
      return text(`Roll pump: ${health} · game ${pumpInfo.gameId} · ${pumpInfo.names.length ? pumpInfo.names.join(", ") : "all characters"} · ${buffer.lastSeq} roll(s) captured (${buffer.size} buffered, ${buffer.dropped} evicted) · up ${mins}m${s.lastError ? ` · last error: ${s.lastError}` : ""}`);
    }
  );
}
