import type { LoopConfig } from "./loop";
import { NodeRuntime } from "./runtime/node";
import { Session } from "./session";
import { InMemorySessionStore } from "./store/memory";
import type { AgentOptions, SessionOptions, SessionStore } from "./types";

const DEFAULT_MAX_STEPS = 100;

export class Agent {
  private readonly config: LoopConfig & { store: SessionStore };
  private readonly defaultSendMode: AgentOptions["sendMode"];

  constructor(config: AgentOptions) {
    this.defaultSendMode = config.sendMode;
    this.config = {
      ...config,
      tools: config.tools ?? [],
      runtime: config.runtime ?? new NodeRuntime(),
      store: config.store ?? new InMemorySessionStore(),
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    };
  }

  async createSession(opts?: SessionOptions & { id?: string }): Promise<Session> {
    const sessionId = opts?.id ?? crypto.randomUUID();
    const sendMode = opts?.sendMode ?? this.defaultSendMode;
    return new Session({
      id: sessionId,
      entries: [],
      leafId: null,
      config: { ...this.config, sendMode },
    });
  }

  async resumeSession(id: string, opts?: SessionOptions & { leafId?: string }): Promise<Session> {
    const { store } = this.config;
    const entries = await store.load(id);
    if (entries.length === 0 && !(await store.exists(id))) {
      throw new Error(`Session not found: ${id}`);
    }
    const sendMode = opts?.sendMode ?? this.defaultSendMode;
    const leafId = opts?.leafId ?? (entries.length > 0 ? entries[entries.length - 1]!.id : null);
    if (opts?.leafId && !entries.some((e) => e.id === opts.leafId)) {
      throw new Error(`Entry not found: ${opts.leafId}`);
    }
    return new Session({ id, entries, leafId, config: { ...this.config, sendMode } });
  }
}
