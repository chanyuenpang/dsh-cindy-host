export class FixtureDshSource {
  constructor() {
    this.listeners = new Set();
    this.sessions = [
      { id: "dsh-host-demo", title: "DSH Cindy Host demo", running: true, updatedAt: "2026-09-16T05:45:00.000Z" },
      { id: "remote-research", title: "Remote control research", pendingInteraction: true, updatedAt: "2026-09-16T05:44:00.000Z" },
    ];
  }

  async listSessions() { return this.sessions; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async emit(event) { for (const listener of this.listeners) await listener(event); }
}
