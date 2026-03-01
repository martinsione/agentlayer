import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { SessionStore } from "../types";

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, ModelMessage[]>();

  async load(sessionId: string): Promise<ModelMessage[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async append(sessionId: string, message: ModelMessage): Promise<void> {
    let messages = this.sessions.get(sessionId);
    if (!messages) {
      messages = [];
      this.sessions.set(sessionId, messages);
    }
    messages.push(message);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
}
