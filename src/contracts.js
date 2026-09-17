export const ACTIVITY_KINDS = new Set(["session-added", "session-removed", "session-status", "session-subscribed"]);

export function toConversationRow(session) {
  return {
    sessionId: String(session.id),
    title: safeTitle(session.title),
    phase: session.running ? "running" : session.pendingInteraction ? "waiting" : "idle",
    updatedAt: session.updatedAt || new Date().toISOString(),
  };
}

export function toActivityItem(event) {
  if (!ACTIVITY_KINDS.has(event.kind)) return null;
  return {
    sessionId: String(event.sessionId),
    sequence: Number(event.sequence),
    kind: event.kind,
    phase: event.phase || "unknown",
    occurredAt: event.occurredAt || new Date().toISOString(),
  };
}

function safeTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  return title.slice(0, 160) || "Untitled DSH task";
}
