// Vitest global setup — runs before each test file's imports.
import * as fs from "fs";
import * as path from "path";

// Vitest runs test files across parallel worker processes. Give each worker its own
// data dir (keyed by pid) so file-based caches never collide across workers. An
// explicitly-provided DDB_DATA_DIR is respected as-is.
const dataDir = process.env.DDB_DATA_DIR
  ? path.resolve(process.env.DDB_DATA_DIR)
  : path.resolve(".tmp-test-data", `w${process.pid}`);
process.env.DDB_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });
