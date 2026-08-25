import * as path from "path";

// Single source of truth for the directory holding live state + credentials: the
// harvested cobalt cookie (ddb-cobalt.json) and the monster-config overlay cache.
//
// Override with DDB_DATA_DIR — point it at the same per-user directory the dm-whisper
// gem manages (where roll20-dm-mcp's ROLL20_DATA_DIR points, e.g. %APPDATA%/dm-whisper)
// so the cookie the gem harvests is shared with this server. Defaults to ./data
// (cwd-relative). Resolved lazily (per call) so a test or the launcher can set the env
// after import and still be honored.
export const dataDir = (): string => path.resolve(process.env.DDB_DATA_DIR ?? "./data");

export const dataPath = (...segments: string[]): string => path.join(dataDir(), ...segments);
