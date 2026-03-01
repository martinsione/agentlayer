import type { SessionEntry, SessionStore } from "../types";

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionEntry[]>();

  async load(sessionId: string): Promise<SessionEntry[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = [];
      this.sessions.set(sessionId, entries);
    }
    entries.push(entry);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
}
