import { describe, it, expect } from "vitest";
import { RollBuffer } from "./roll-buffer.js";
import type { DdbGameLogMessage } from "./ddb-gamelog.js";

const msg = (id: string): DdbGameLogMessage => ({
  id, dateTime: "0", gameId: "g", userId: "u", entityId: "e", eventType: "dice/roll/fulfilled",
});

describe("RollBuffer", () => {
  it("assigns monotonic seqs and drains by cursor", () => {
    const buf = new RollBuffer(10);
    buf.push(msg("a"));
    buf.push(msg("b"));
    const c = buf.push(msg("c"));
    expect(c.seq).toBe(3);
    expect(buf.since(0).map((r) => r.message.id)).toEqual(["a", "b", "c"]);
    expect(buf.since(2).map((r) => r.message.id)).toEqual(["c"]);
    expect(buf.since(3)).toEqual([]);
    expect(buf.lastSeq).toBe(3);
  });

  it("evicts oldest entries past the cap and counts drops", () => {
    const buf = new RollBuffer(3);
    for (const id of ["a", "b", "c", "d", "e"]) buf.push(msg(id));
    expect(buf.size).toBe(3);
    expect(buf.dropped).toBe(2);
    expect(buf.oldestSeq).toBe(3);
    // A cursor older than the eviction horizon just gets what's still held.
    expect(buf.since(0).map((r) => r.message.id)).toEqual(["c", "d", "e"]);
  });

  it("keeps seq climbing across clear so stale cursors stay valid", () => {
    const buf = new RollBuffer(10);
    buf.push(msg("a"));
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.push(msg("b")).seq).toBe(2);
    expect(buf.since(1).map((r) => r.message.id)).toEqual(["b"]);
  });
});
