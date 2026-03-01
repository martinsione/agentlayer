import type { ModelMessage } from "@ai-sdk/provider-utils";
import { loop, type LoopConfig } from "./loop";
import type { SendMode, SessionStore, SessionEventMap, ToolCallDecision } from "./types";

type Listener<T> = (event: T) => unknown | Promise<unknown>;

type ListenerFor<K extends keyof SessionEventMap> = K extends "tool_call"
  ? (payload: SessionEventMap[K]) => void | ToolCallDecision | Promise<void | ToolCallDecision>
  : (payload: SessionEventMap[K]) => void | Promise<void>;

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };

type SessionConfig = LoopConfig & { store: SessionStore; sendMode?: SendMode };

export class Session {
  readonly id: string;
  private messages: ModelMessage[];
  private readonly config: SessionConfig;
  private listeners = new Map<keyof SessionEventMap, Set<Listener<unknown>>>();

  private steeringQueue: ModelMessage[] = [];
  private followUpQueue: ModelMessage[] = [];
  private completion: Deferred | null = null;

  constructor(id: string, messages: ModelMessage[], config: SessionConfig) {
    this.id = id;
    this.messages = messages;
    this.config = config;
  }

  on<K extends keyof SessionEventMap>(event: K, listener: ListenerFor<K>): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    return this;
  }

  off<K extends keyof SessionEventMap>(event: K, listener: ListenerFor<K>): this {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
    return this;
  }

  send(text: string, opts?: { mode?: SendMode; signal?: AbortSignal }): void {
    const mode = opts?.mode ?? this.config.sendMode ?? "steer";

    const userMessage: ModelMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };

    if (!this.completion) {
      // Loop idle — push message and start the loop
      this.messages.push(userMessage);
      this.completion = createDeferred();
      this.runLoop(opts?.signal, [userMessage]);
      return;
    }

    // Loop running — route based on mode (synchronous, no await)
    if (mode === "steer") {
      this.steeringQueue.push(userMessage);
    } else {
      this.followUpQueue.push(userMessage);
    }
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

    const gen = loop(
      this.messages,
      {
        ...this.config,
        getSteeringMessages: () => {
          const msgs = this.steeringQueue.splice(0);
          pendingUserMessages.push(...msgs);
          return msgs;
        },
        getFollowUpMessages: () => {
          const msgs = this.followUpQueue.splice(0);
          pendingUserMessages.push(...msgs);
          return msgs;
        },
      },
      signal,
    );

    const turnMessages: ModelMessage[] = [];
    let lastText = "";
    let lastDecision: ToolCallDecision = undefined;

    try {
      // Persist and emit initial user messages
      for (const msg of initialUserMessages) {
        await this.config.store.append(this.id, msg);
        turnMessages.push(msg);
        await this.emit("message", { message: msg });
      }

      for (;;) {
        const { value: event, done } = await gen.next(lastDecision);

        // Flush any user messages drained from steering/follow-up queues
        for (const msg of pendingUserMessages.splice(0)) {
          await this.config.store.append(this.id, msg);
          turnMessages.push(msg);
          await this.emit("message", { message: msg });
        }

        if (done) break;
        lastDecision = undefined;

        switch (event.type) {
          case "text_delta":
            await this.emit("text_delta", { delta: event.delta });
            break;

          case "message":
            await this.config.store.append(this.id, event.message);
            turnMessages.push(event.message);
            if (event.message.role === "assistant") {
              const c = event.message.content;
              lastText =
                typeof c === "string"
                  ? c
                  : c
                      .filter((p) => p.type === "text")
                      .map((p) => p.text)
                      .join("");
            }
            await this.emit("message", { message: event.message });
            break;

          case "tool_call":
            lastDecision = await this.emitToolCall({
              callId: event.callId,
              name: event.name,
              args: event.args,
            });
            break;

          case "tool_result":
            await this.config.store.append(this.id, event.message);
            turnMessages.push(event.message);
            await this.emit("tool_result", {
              callId: event.callId,
              name: event.name,
              result: event.result,
              isError: event.isError,
            });
            break;

          case "step":
            await this.emit("step", {
              usage: event.usage,
              finishReason: event.finishReason,
            });
            break;
        }
      }

      await this.emit("turn_end", { messages: turnMessages, text: lastText });
      this.settle().resolve();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.emit("error", { error });
      this.settle().reject(error);
    }
  }

  private settle(): Deferred {
    const deferred = this.completion!;
    this.completion = null;
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
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

  private async emitToolCall(payload: SessionEventMap["tool_call"]): Promise<ToolCallDecision> {
    const set = this.listeners.get("tool_call");
    if (!set) return undefined;
    for (const listener of set) {
      const result = await listener(payload);
      if (result && typeof result === "object" && ("deny" in result || "args" in result)) {
        return result as ToolCallDecision;
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
