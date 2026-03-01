import type { ModelMessage } from "@ai-sdk/provider-utils";
import { loop, type LoopConfig } from "./loop";
import type { SessionStore, SessionEventMap, ToolCallDecision } from "./types";

type Listener<T> = (event: T) => unknown | Promise<unknown>;

type ListenerFor<K extends keyof SessionEventMap> = K extends "tool_call"
  ? (payload: SessionEventMap[K]) => void | ToolCallDecision | Promise<void | ToolCallDecision>
  : (payload: SessionEventMap[K]) => void | Promise<void>;

export class Session {
  readonly id: string;
  private messages: ModelMessage[];
  private readonly config: LoopConfig & { store: SessionStore };
  private listeners = new Map<keyof SessionEventMap, Set<Listener<unknown>>>();

  constructor(id: string, messages: ModelMessage[], config: LoopConfig & { store: SessionStore }) {
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

  async send(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
    const userMessage: ModelMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };
    this.messages.push(userMessage);
    await this.config.store.append(this.id, userMessage);
    await this.emit("message", { message: userMessage });

    const gen = loop(this.messages, this.config, opts?.signal);

    const turnMessages: ModelMessage[] = [userMessage];
    let lastText = "";
    let lastDecision: ToolCallDecision = undefined;

    try {
      for (;;) {
        const { value: event, done } = await gen.next(lastDecision);
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
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.emit("error", { error });
      throw error;
    }
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
