import { describe, it, expect, vi, beforeEach } from "vitest";

const rtRawFetch = vi.fn();
vi.mock("./ddb-rt.js", () => ({ rtRawFetch: (...a: unknown[]) => rtRawFetch(...a) }));

import { setHitPoints, applyCondition, removeCondition, DdbWriteError } from "./ddb-write.js";

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ id: 1, success: true, message: "ok", data, pagination: null }) });

beforeEach(() => rtRawFetch.mockReset());

describe("ddb-write primitives", () => {
  it("setHitPoints PUTs damage-taken with clamped, integer values", async () => {
    rtRawFetch.mockResolvedValue(ok({ removedHitPoints: 5, temporaryHitPoints: 0 }));
    await setHitPoints(170229415, { removedHitPoints: -3.7, temporaryHitPoints: 4.9 });
    const [url, opts] = rtRawFetch.mock.calls[0];
    expect(url).toContain("/life/hp/damage-taken");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ characterId: 170229415, removedHitPoints: 0, temporaryHitPoints: 4 });
  });

  it("applyCondition PUTs, removeCondition DELETEs, with id+level", async () => {
    rtRawFetch.mockResolvedValue(ok({ conditions: [{ id: 11, level: null }] }));
    await applyCondition(1, 11);
    expect(rtRawFetch.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(rtRawFetch.mock.calls[0][1].body)).toEqual({ characterId: 1, id: 11, level: null });

    rtRawFetch.mockResolvedValue(ok({ conditions: [] }));
    await removeCondition(1, 4, 2);
    expect(rtRawFetch.mock.calls[1][1].method).toBe("DELETE");
    expect(JSON.parse(rtRawFetch.mock.calls[1][1].body)).toEqual({ characterId: 1, id: 4, level: 2 });
  });

  it("throws DdbWriteError naming the offending fields on a 400", async () => {
    rtRawFetch.mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ id: 0, success: false, message: "The parameters provided are invalid.", data: ["Missing required field: removedHitPoints"], pagination: null }),
    });
    await expect(setHitPoints(1, { removedHitPoints: 5, temporaryHitPoints: 0 }))
      .rejects.toThrow(/removedHitPoints/);
    await expect(setHitPoints(1, { removedHitPoints: 5, temporaryHitPoints: 0 }))
      .rejects.toBeInstanceOf(DdbWriteError);
  });
});
