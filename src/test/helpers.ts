import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { convertArrayToReadableStream } from "@ai-sdk/provider-utils/test";
import { MockLanguageModelV3 } from "ai/test";
import { Agent } from "../agent";
import { loop, type LoopConfig } from "../loop";
import { JustBashRuntime } from "../runtime/just-bash";
import { InMemorySessionStore } from "../store/memory";
import type { LoopEvent, SendMode, SessionEntry, SessionStore, Tool } from "../types";

type MockToolCall = { id: string; name: string; input: Record<string, unknown> };

type MockResponse =
  | { text: string; toolCalls?: undefined }
  | { text?: string; toolCalls: MockToolCall[] };

type FinishUsage = Extract<LanguageModelV3StreamPart, { type: "finish" }>["usage"];

const DEFAULT_USAGE: FinishUsage = {
  inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

const EMPTY_STREAM_RESULT = { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([]) };

export function createMockModel(responses: MockResponse[]) {
  const streamResults = responses.map((r) => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "resp-0", modelId: "mock-model-id", timestamp: new Date(0) },
    ];

    const text = r.text ?? "";
    if (text) {
      parts.push({ type: "text-start", id: "text-0" });
      parts.push({ type: "text-delta", id: "text-0", delta: text });
      parts.push({ type: "text-end", id: "text-0" });
    }

    if (r.toolCalls) {
      for (const tc of r.toolCalls) {
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.name,
          input: JSON.stringify(tc.input),
        });
      }
      parts.push({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: DEFAULT_USAGE,
      });
    } else {
      parts.push({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: DEFAULT_USAGE,
      });
    }

    return { stream: convertArrayToReadableStream(parts) };
  });

  // MockLanguageModelV3 pushes to doStreamCalls before indexing, so it's 1-based.
  // Pad index 0 with an empty stream so our responses start at index 1.
  return new MockLanguageModelV3({ doStream: [EMPTY_STREAM_RESULT, ...streamResults] });
}

export function createFailingModel(message = "model crashed") {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw new Error(message);
    },
  });
}

export function createTestAgent(
  responses: MockResponse[],
  opts?: { store?: SessionStore; tools?: Tool[]; sendMode?: SendMode },
) {
  const model = createMockModel(responses);
  const agent = new Agent({
    model,
    runtime: new JustBashRuntime(),
    store: opts?.store ?? new InMemorySessionStore(),
    tools: opts?.tools,
    sendMode: opts?.sendMode,
  });
  return { agent, model };
}

export function makeEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    type: "message",
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: Date.now(),
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
    ...overrides,
  } as SessionEntry;
}

export function userMessage(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function createSlowTool(name = "slow", delayMs = 50): Tool {
  return {
    name,
    description: `slow tool`,
    parameters: { type: "object", properties: {} },
    execute: async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, delayMs));
      return "done";
    },
  };
}

export async function drainLoop(
  messages: ModelMessage[],
  config: LoopConfig,
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  const gen = loop(messages, config);
  for (let result = await gen.next(); !result.done; result = await gen.next()) {
    events.push(result.value);
  }
  return events;
}
