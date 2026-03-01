import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { loop, type LoopConfig } from "./loop";
import type {
  MessageEntry,
  SendMode,
  SessionEntry,
  SessionStatus,
  SessionStore,
  SessionEventMap,
  HookEvent,
  HookEventMap,
  HookListener,
  Tool,
  ThinkingLevel,
  ThinkingBudgets,
} from "./types";

type Listener<T> = (event: T) => unknown | Promise<unknown>;

type ListenerFor<K extends keyof SessionEventMap> = K extends HookEvent
  ? HookListener<K>
  : (payload: SessionEventMap[K]) => void | Promise<void>;

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };

type SessionConfig = LoopConfig & { store: SessionStore; sendMode?: SendMode };

export function buildContext(entries: SessionEntry[], leafId: string | null): ModelMessage[] {
  if (leafId === null || entries.length === 0) return [];

  const index = new Map<string, SessionEntry>();
  for (const e of entries) index.set(e.id, e);

  // Walk from leaf to root (with cycle detection)
  const path: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = index.get(leafId);
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  path.reverse();

  // Find most recent compaction entry on the path
  let compactionIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type === "compaction") {
      compactionIdx = i;
      break;
    }
  }

  const messages: ModelMessage[] = [];
  if (compactionIdx >= 0) {
    const compaction = path[compactionIdx] as SessionEntry & { type: "compaction" };

    // 1. Emit summary
    messages.push({
      role: "user",
      content: [{ type: "text", text: `<summary>${compaction.summary}</summary>` }],
    });

    // 2. Emit kept messages before compaction (from firstKeptId onward)
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i]!;
      if (entry.id === compaction.firstKeptId) foundFirstKept = true;
      if (foundFirstKept && entry.type === "message") {
        messages.push(entry.message);
      }
    }

    // 3. Emit all messages after compaction
    for (let i = compactionIdx + 1; i < path.length; i++) {
      const entry = path[i]!;
      if (entry.type === "message") {
        messages.push(entry.message);
      }
    }
  } else {
    for (const entry of path) {
      if (entry.type === "message") {
        messages.push(entry.message);
      }
    }
  }

  return messages;
}

export class Session {
  readonly id: string;
  private entries: SessionEntry[];
  private _leafId: string | null;
  private _messages: ModelMessage[];
  private readonly config: SessionConfig;
  private listeners = new Map<keyof SessionEventMap, Set<Listener<unknown>>>();

  private steeringQueue: ModelMessage[] = [];
  private followUpQueue: ModelMessage[] = [];
  private completion: Deferred | null = null;
  private controller: AbortController | null = null;

  constructor(opts: {
    id: string;
    entries: SessionEntry[];
    leafId: string | null;
    config: SessionConfig;
  }) {
    this.id = opts.id;
    this.entries = opts.entries;
    this._leafId = opts.leafId;
    this._messages = buildContext(opts.entries, opts.leafId);
    this.config = opts.config;
  }

  get leafEntryId(): string | null {
    return this._leafId;
  }

  get messages(): readonly ModelMessage[] {
    return this._messages;
  }

  get status(): SessionStatus {
    return this.completion ? "busy" : "idle";
  }

  get model(): LanguageModel {
    return this.config.model;
  }

  set model(model: LanguageModel) {
    this.config.model = model;
  }

  get tools(): Tool[] {
    return this.config.tools;
  }

  set tools(tools: Tool[]) {
    this.config.tools = tools;
  }

  get systemPrompt(): string | undefined {
    return this.config.systemPrompt;
  }

  set systemPrompt(prompt: string | undefined) {
    this.config.systemPrompt = prompt;
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this.config.thinkingLevel;
  }

  set thinkingLevel(level: ThinkingLevel | undefined) {
    this.config.thinkingLevel = level;
  }

  get thinkingBudgets(): ThinkingBudgets | undefined {
    return this.config.thinkingBudgets;
  }

  set thinkingBudgets(budgets: ThinkingBudgets | undefined) {
    this.config.thinkingBudgets = budgets;
  }

  abort(): void {
    this.controller?.abort();
  }

  private appendEntry(message: ModelMessage): MessageEntry {
    const entry: MessageEntry = {
      type: "message",
      id: crypto.randomUUID(),
      parentId: this._leafId,
      timestamp: Date.now(),
      message,
    };
    this.entries.push(entry);
    this._leafId = entry.id;
    return entry;
  }

  on<K extends keyof SessionEventMap>(event: K, listener: ListenerFor<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    return () => {
      set!.delete(listener as Listener<unknown>);
    };
  }

  send(
    input: string | ModelMessage | ModelMessage[],
    opts?: { mode?: SendMode; signal?: AbortSignal },
  ): void {
    const mode = opts?.mode ?? this.config.sendMode ?? "steer";

    const userMessages: ModelMessage[] = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? [{ role: "user", content: [{ type: "text" as const, text: input }] }]
        : [input];

    if (!this.completion) {
      // Loop idle — push messages and start the loop
      for (const msg of userMessages) this._messages.push(msg);
      this.completion = createDeferred();
      this.controller = new AbortController();
      const combinedSignal = opts?.signal
        ? AbortSignal.any([this.controller.signal, opts.signal])
        : this.controller.signal;
      this.emit("status", { status: "busy" });
      this.runLoop(combinedSignal, userMessages);
      return;
    }

    // Loop running — route based on mode (synchronous, no await)
    const queue = mode === "steer" ? this.steeringQueue : this.followUpQueue;
    for (const msg of userMessages) queue.push(msg);
  }

  waitForIdle(): Promise<void> {
    if (!this.completion) return Promise.resolve();
    return this.completion.promise;
  }

  private async runLoop(
    signal: AbortSignal | undefined,
    initialUserMessages: ModelMessage[],
  ): Promise<void> {
    const pendingUserMessages: ModelMessage[] = [];
    const drainQueue = (queue: ModelMessage[]) => {
      const msgs = queue.splice(0);
      pendingUserMessages.push(...msgs);
      return msgs;
    };

    const gen = loop(
      this._messages,
      {
        ...this.config,
        hooks: {
          beforeToolCall: (e) => this.runHook("before-tool-call", e),
          afterToolCall: (e) => this.runHook("after-tool-call", e),
          beforeModelCall: (e) => this.runHook("before-model-call", e),
          beforeStop: (e) => this.runHook("before-stop", e),
        },
        onToolProgress: (e) => {
          this.emit("tool-progress", e);
        },
        getSteeringMessages: () => drainQueue(this.steeringQueue),
        getFollowUpMessages: () => drainQueue(this.followUpQueue),
      },
      signal,
    );

    const turnMessages: ModelMessage[] = [];
    let lastText = "";

    const persistUserMessage = async (msg: ModelMessage, addToMessages = true) => {
      if (addToMessages) this._messages.push(msg);
      const entry = this.appendEntry(msg);
      await this.config.store.append(this.id, entry);
      turnMessages.push(msg);
      await this.emit("message", { message: msg as ModelMessage & { role: "user" } });
    };

    try {
      for (const msg of initialUserMessages) await persistUserMessage(msg, false);

      await this.emit("turn-start", {});

      for await (const event of gen) {
        for (const msg of pendingUserMessages.splice(0)) await persistUserMessage(msg);

        switch (event.type) {
          case "message": {
            const { type: _, ...payload } = event;
            this._messages.push(payload.message);
            const entry = this.appendEntry(payload.message);
            await this.config.store.append(this.id, entry);
            turnMessages.push(payload.message);

            if (payload.message.role === "assistant") {
              const c = payload.message.content;
              lastText =
                typeof c === "string"
                  ? c
                  : c
                      .filter((p): p is { type: "text"; text: string } => p.type === "text")
                      .map((p) => p.text)
                      .join("");
            }

            await this.emit("message", payload);
            break;
          }

          default:
            await this.emit(event.type as keyof SessionEventMap, event as any);
            break;
        }
      }

      await this.emit("turn-end", { messages: turnMessages, text: lastText });
      this.settle().resolve();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await this.emit("error", { error });
      } catch {}
      this.settle().reject(error);
    }
  }

  private settle(): Deferred {
    const deferred = this.completion!;
    this.completion = null;
    this.controller = null;
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    this.emit("status", { status: "idle" });
    return deferred;
  }

  private async emit<K extends keyof SessionEventMap>(
    event: K,
    payload: SessionEventMap[K],
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      await listener(payload);
    }
  }

  private async runHook<K extends HookEvent>(
    event: K,
    payload: HookEventMap[K]["payload"],
  ): Promise<HookEventMap[K]["decision"]> {
    const set = this.listeners.get(event);
    if (!set?.size) return undefined;
    for (const fn of set) {
      const result = await (fn as Function)(payload);
      if (result != null && typeof result === "object") {
        return result as HookEventMap[K]["decision"];
      }
    }
    return undefined;
  }
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
