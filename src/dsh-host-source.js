/**
 * Host-only integration seam. A DSH profile bundle constructs the public
 * InProcessApiClient and supplies the public events API. This standalone demo
 * never imports DSH nested dependencies.
 */
export class DshHostSource {
  constructor(client) {
    this.client = client;
    this.controller = null;
  }

  async listSessions() {
    const response = await this.client.sessions.list({});
    if (!response.result.ok) throw new Error('DSH session list failed');
    return response.result.value.items.map((session) => ({
      id: session.sessionId,
      running: Boolean(session.running),
      // session.list intentionally carries no title or pending-interaction payload.
      updatedAt: new Date(session.updatedAt).toISOString(),
    }));
  }

  onEvent(listener) {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    Promise.all([this.consumeHost(signal, listener), this.consumeMux(signal, listener)])
      .catch(() => { if (!signal.aborted) listener({ kind: "stream-failed" }); });
    return () => this.controller.abort();
  }

  async consumeHost(signal, listener) {
    for await (const frame of this.client.events.host({}, signal)) {
      const item = hostFrame(frame.payload);
      if (item) await listener(item);
    }
  }

  async consumeMux(signal, listener) {
    for await (const frame of this.client.events.mux({}, signal)) {
      const item = muxFrame(frame.payload);
      if (item) await listener(item);
    }
  }
}

function hostFrame(frame) {
  if (frame.type === 'stream/error') return { kind: 'stream-failed' };
  if (frame.type === 'host/session-added') return summary(frame, 'session-added');
  if (frame.type === 'host/session-removed') return summary(frame, 'session-removed');
  if (frame.type === 'host/session-status') return summary(frame, 'session-status');
  return null;
}

function summary(frame, kind) {
  return { sessionId: frame.sessionId, sequence: 0, kind, phase: frame.running ? 'running' : 'idle' };
}

function muxFrame(frame) {
  if (frame.type === 'stream/error') return { kind: 'stream-failed' };
  if (frame.type !== 'session/subscribed') return null;
  return { sessionId: frame.sessionId, sequence: frame.lastSeq || 0, kind: 'session-subscribed', phase: 'subscribed' };
}
