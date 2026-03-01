import type { LoopConfig } from "./loop";
import { NodeRuntime } from "./runtime/node";
import { Session } from "./session";
import { InMemorySessionStore } from "./store/memory";
import type { AgentConfig, SessionStore } from "./types";

const DEFAULT_MAX_STEPS = 100;

export class Agent {
  private readonly config: LoopConfig & { store: SessionStore };

  constructor(config: AgentConfig) {
    this.config = {
      ...config,
      tools: config.tools ?? [],
      runtime: config.runtime ?? new NodeRuntime(),
      store: config.store ?? new InMemorySessionStore(),
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    };
  }

  async createSession(id?: string): Promise<Session> {
    const sessionId = id ?? crypto.randomUUID();
    return new Session(sessionId, [], this.config);
  }

  async resumeSession(id: string): Promise<Session> {
    const { store } = this.config;
    const messages = await store.load(id);
    if (messages.length === 0 && !(await store.exists(id))) {
      throw new Error(`Session not found: ${id}`);
    }
    return new Session(id, messages, this.config);
  }
}
