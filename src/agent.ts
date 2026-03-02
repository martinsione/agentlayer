import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { LoopConfig } from "./loop";
import { NodeRuntime } from "./runtime/node";
import { Session } from "./session";
import { InMemorySessionStore } from "./store/memory";
import { createTaskTool } from "./tools/task";
import type {
  AgentHooks,
  AgentOptions,
  CompactionConfig,
  HookEvent,
  PromptResult,
  SessionOptions,
  SessionStore,
} from "./types";

const DEFAULT_MAX_STEPS = 100;

export class Agent {
  private readonly config: LoopConfig & { store: SessionStore; compaction?: CompactionConfig };
  private readonly defaultSendMode: AgentOptions["sendMode"];
  private readonly hooks: AgentHooks | undefined;
  private readonly onEvent: AgentOptions["onEvent"];

  constructor(config: AgentOptions) {
    this.defaultSendMode = config.sendMode;
    this.hooks = config.hooks;
    this.onEvent = config.onEvent;
    const systemPrompt = config.instructions ?? config.systemPrompt;
    const { hooks: _, instructions: __, onEvent: ___, subagents: ____, ...rest } = config;
    this.config = {
      ...rest,
      systemPrompt,
      compaction: config.compaction,
      tools: config.tools ?? [],
      runtime: config.runtime ?? new NodeRuntime(),
      store: config.store ?? new InMemorySessionStore(),
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    };

    if (config.subagents) {
      const subagentTools = Object.entries(config.subagents).map(([name, sub]) =>
        createTaskTool({
          name: `task_${name}`,
          description: sub.description,
          model: sub.model ?? this.config.model,
          tools: sub.tools ?? this.config.tools,
          systemPrompt: sub.instructions,
          maxSteps: sub.maxSteps ?? 50,
        }),
      );
      this.config.tools = [...this.config.tools, ...subagentTools];
    }
  }

  async createSession(opts?: SessionOptions & { id?: string }): Promise<Session> {
    const sessionId = opts?.id ?? crypto.randomUUID();
    const sendMode = opts?.sendMode ?? this.defaultSendMode;
    const session = new Session({
      id: sessionId,
      entries: [],
      leafId: null,
      config: { ...this.config, sendMode },
    });
    this.applyHooks(session);
    return session;
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
    const session = new Session({ id, entries, leafId, config: { ...this.config, sendMode } });
    this.applyHooks(session);
    return session;
  }

  async listSessions(): Promise<string[]> {
    return this.config.store.list();
  }

  async prompt(
    input: string | ModelMessage | ModelMessage[],
    opts?: { onText?: (text: string) => void; signal?: AbortSignal },
  ): Promise<PromptResult> {
    // Use an in-memory store for ephemeral sessions to avoid polluting persistent stores
    const ephemeralConfig = { ...this.config, store: new InMemorySessionStore() };
    const session = new Session({
      id: crypto.randomUUID(),
      entries: [],
      leafId: null,
      config: { ...ephemeralConfig, sendMode: this.defaultSendMode },
    });
    this.applyHooks(session);
    const text = await session.prompt(input, opts);
    return { text, messages: session.messages, usage: session.usage };
  }

  private applyHooks(session: Session): void {
    if (this.hooks) {
      for (const [event, listener] of Object.entries(this.hooks)) {
        if (listener == null) continue;
        const listeners = Array.isArray(listener) ? listener : [listener];
        for (const fn of listeners) {
          session.on(event as HookEvent, fn as any);
        }
      }
    }
    if (this.onEvent) {
      session.subscribe(this.onEvent);
    }
  }
}
