import test from "node:test";
import assert from "node:assert/strict";
import { FixtureDshSource } from "../src/fixture-source.js";
import { ReadOnlyProjection } from "../src/projection.js";

class MemorySink {
  constructor() { this.snapshots = []; this.activity = []; this.stale = 0; }
  async replaceConversations(rows) { this.snapshots.push(rows); }
  async appendActivity(item) { this.activity.push(item); }
  async markStale() { this.stale += 1; }
}

test("projects a safe conversation baseline and lifecycle item", async () => {
  const source = new FixtureDshSource();
  const sink = new MemorySink();
  const projection = new ReadOnlyProjection(sink);
  await projection.start(source);
  await source.emit({ sessionId: "dsh-host-demo", sequence: 1, kind: "session-status", phase: "running", occurredAt: "2026-09-16T05:46:00.000Z" });
  assert.equal(sink.snapshots[0].length, 2);
  assert.equal(sink.snapshots[0][0].phase, "running");
  assert.deepEqual(sink.activity[0], { sessionId: "dsh-host-demo", sequence: 1, kind: "session-status", phase: "running", occurredAt: "2026-09-16T05:46:00.000Z" });
});

test("discards unallowlisted payload-bearing frames", async () => {
  const source = new FixtureDshSource();
  const sink = new MemorySink();
  const projection = new ReadOnlyProjection(sink);
  await projection.start(source);
  await source.emit({ sessionId: "dsh-host-demo", sequence: 2, kind: "session-event", message: "secret prompt", toolArgs: { token: "secret" } });
  assert.equal(sink.activity.length, 0);
});

test("marks stale and rebaselines without raw error text", async () => {
  const source = new FixtureDshSource();
  const sink = new MemorySink();
  const projection = new ReadOnlyProjection(sink);
  await projection.start(source);
  await source.emit({ kind: "stream-failed", error: "credential leaked" });
  assert.equal(sink.stale, 1);
  assert.equal(sink.snapshots.length, 2);
});
