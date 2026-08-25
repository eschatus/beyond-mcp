import { describe, it, expect, vi, beforeEach } from "vitest";

const { rtRawFetch } = vi.hoisted(() => ({ rtRawFetch: vi.fn() }));
vi.mock("./ddb-rt.js", () => ({ rtRawFetch }));

import { rtGetPartySnapshot } from "./ddb-scds.js";

const found = (ids: number[]) => ({
  ok: true, status: 200,
  json: async () => ({ foundCharacters: ids.map((id) => ({ characterId: id, name: `C${id}` })) }),
});

beforeEach(() => rtRawFetch.mockReset());

describe("rtGetPartySnapshot", () => {
  it("POSTs characterIds and returns foundCharacters", async () => {
    rtRawFetch.mockResolvedValue(found([1, 2]));
    const out = await rtGetPartySnapshot([1, 2]);
    expect(out.map((c) => c.characterId)).toEqual([1, 2]);
    const [url, opts] = rtRawFetch.mock.calls[0];
    expect(url).toContain("character-service-scds");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ characterIds: [1, 2] });
  });

  it("dedupes and drops invalid ids, and short-circuits an empty set", async () => {
    rtRawFetch.mockResolvedValue(found([5]));
    await rtGetPartySnapshot([5, 5, -1, 0, 3.5]);
    expect(JSON.parse(rtRawFetch.mock.calls[0][1].body)).toEqual({ characterIds: [5] });

    rtRawFetch.mockReset();
    expect(await rtGetPartySnapshot([])).toEqual([]);
    expect(rtRawFetch).not.toHaveBeenCalled();
  });

  it("chunks into batches of 99 and merges the results", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    rtRawFetch
      .mockResolvedValueOnce(found(ids.slice(0, 99)))
      .mockResolvedValueOnce(found(ids.slice(99)));
    const out = await rtGetPartySnapshot(ids);
    expect(rtRawFetch).toHaveBeenCalledTimes(2);
    const bodyIds = (i: number) => JSON.parse((rtRawFetch.mock.calls[i][1] as { body: string }).body).characterIds;
    expect(bodyIds(0)).toHaveLength(99);
    expect(bodyIds(1)).toHaveLength(51);
    expect(out).toHaveLength(150);
  });
});
