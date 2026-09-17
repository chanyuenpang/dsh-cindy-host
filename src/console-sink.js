export class ConsoleSink {
  constructor(out = console.log) { this.out = out; }
  async replaceConversations(items) { this.out(JSON.stringify({ channel: "dsh:conversations", items }, null, 2)); }
  async appendActivity(item) { this.out(JSON.stringify({ channel: "dsh:activity", item }, null, 2)); }
  async markStale() { this.out(JSON.stringify({ channel: "dsh:projection", state: "stale" }, null, 2)); }
}
