import { ConsoleSink } from "./console-sink.js";
import { FixtureDshSource } from "./fixture-source.js";
import { ReadOnlyProjection } from "./projection.js";

const source = new FixtureDshSource();
const projection = new ReadOnlyProjection(new ConsoleSink());
await projection.start(source);
await source.emit({ sessionId: "dsh-host-demo", sequence: 1, kind: "session-status", phase: "running", occurredAt: "2026-09-16T05:46:00.000Z" });
await source.emit({ sessionId: "remote-research", sequence: 2, kind: "session-added", phase: "waiting", occurredAt: "2026-09-16T05:46:01.000Z" });
