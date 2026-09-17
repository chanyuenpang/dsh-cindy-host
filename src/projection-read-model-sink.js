export class ProjectionReadModelSink {
  constructor(model, onActivity = () => {}) { this.model = model; this.onActivity = onActivity; }
  async replaceConversations(rows) { this.model.rows = new Map(rows.map((row) => [row.sessionId, row])); }
  async appendActivity(item) { this.onActivity(item); }
  async markStale() {}
}
