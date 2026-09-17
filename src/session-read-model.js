import { toConversationRow } from './contracts.js';
export class SessionReadModel {
  constructor() { this.rows = new Map(); }
  replace(sessions) { this.rows = new Map(sessions.map((session) => { const row = toConversationRow(session); return [row.sessionId, row]; })); }
  list() { return [...this.rows.values()]; }
}
