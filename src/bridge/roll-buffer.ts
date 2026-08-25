// Bounded in-memory buffer between the game-log pump and its consumers. The pump pushes
// each captured roll; consumers drain with a cursor (`since`) — the polling surface the
// gem bridges into a VTT — or subscribe live (the HTTP entry's SSE stream).

import type { DdbGameLogMessage } from "./ddb-gamelog.js";

export interface BufferedRoll {
  /** Monotonic 1-based sequence number — the poll cursor. */
  seq: number;
  receivedAt: number;
  message: DdbGameLogMessage;
}

export class RollBuffer {
  private items: BufferedRoll[] = [];
  private nextSeq = 1;
  private droppedTotal = 0;

  // Deliberately shallow: buffered rolls are live table events, and a consumer that
  // comes back after a long stall must NOT replay a flood of stale rolls into chat.
  // Older entries evict; `missed` in ddb_poll_rolls tells the consumer they existed.
  constructor(private readonly cap = 10) {}

  push(message: DdbGameLogMessage): BufferedRoll {
    const entry: BufferedRoll = { seq: this.nextSeq++, receivedAt: Date.now(), message };
    this.items.push(entry);
    if (this.items.length > this.cap) {
      this.droppedTotal += this.items.length - this.cap;
      this.items.splice(0, this.items.length - this.cap);
    }
    return entry;
  }

  /** Every buffered roll with seq > after (0 = everything still held). */
  since(after = 0): BufferedRoll[] {
    return this.items.filter((i) => i.seq > after);
  }

  /** Highest seq ever assigned (0 = nothing captured yet). */
  get lastSeq(): number { return this.nextSeq - 1; }

  /** Oldest seq still held, or null when empty. */
  get oldestSeq(): number | null { return this.items[0]?.seq ?? null; }

  /** Rolls evicted by the cap over the buffer's lifetime. */
  get dropped(): number { return this.droppedTotal; }

  get size(): number { return this.items.length; }

  clear(): void {
    this.items = [];
    // seq keeps climbing so cursors held across a clear stay valid (they just read empty).
  }
}
