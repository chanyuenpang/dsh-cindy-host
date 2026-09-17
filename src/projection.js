import { toActivityItem, toConversationRow } from "./contracts.js";

export class ReadOnlyProjection {
  constructor(sink) {
    this.sink = sink;
    this.source = null;
    this.unsubscribe = null;
    this.rebasing = false;
  }

  async start(source) {
    this.source = source;
    await this.rebaseline();
    this.unsubscribe = source.onEvent((event) => this.apply(event));
  }

  async stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  async apply(event) {
    if (event.kind === "stream-failed") return this.recover();
    const item = toActivityItem(event);
    if (item) await this.sink.appendActivity(item);
  }

  async recover() {
    if (this.rebasing) return;
    this.rebasing = true;
    try {
      await this.sink.markStale();
      await this.rebaseline();
    } finally {
      this.rebasing = false;
    }
  }

  async rebaseline() {
    const sessions = await this.source.listSessions();
    await this.sink.replaceConversations(sessions.map(toConversationRow));
  }
}
