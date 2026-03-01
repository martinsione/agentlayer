import { tool, jsonSchema } from "@ai-sdk/provider-utils";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { streamText, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { STREAM_EVENT_TYPES } from "./types";
import type { LoopEvent, Tool, Runtime, BeforeToolCallEvent, ToolCallDecision } from "./types";

const STREAM_EVENTS: Set<string> = new Set(STREAM_EVENT_TYPES);

export type LoopContext = {
  runtime: Runtime;
  onBeforeToolCall?: (event: BeforeToolCallEvent) => Promise<ToolCallDecision>;
};

export type LoopConfig = {
  model: LanguageModel;
  systemPrompt?: string;
  tools: Tool[];
  runtime: Runtime;
  maxSteps: number;
  onBeforeToolCall?: (event: BeforeToolCallEvent) => Promise<ToolCallDecision>;
  getSteeringMessages?: () => ModelMessage[];
  getFollowUpMessages?: () => ModelMessage[];
};

export async function* loop(
  messages: ModelMessage[],
  config: LoopConfig,
  signal?: AbortSignal,
): AsyncGenerator<LoopEvent> {
  const {
    model,
    systemPrompt,
    tools,
    runtime,
    maxSteps,
    onBeforeToolCall,
    getSteeringMessages,
    getFollowUpMessages,
  } = config;

  const toolDefs: Record<string, unknown> = {};
  for (const t of tools) {
    toolDefs[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
      execute: async (input, options) => {
        const ctx = options.experimental_context as LoopContext;
        if (ctx.onBeforeToolCall) {
          const decision = await ctx.onBeforeToolCall({
            toolCallId: options.toolCallId,
            toolName: t.name,
            input: input as Record<string, unknown>,
          });
          if (decision && "deny" in decision) throw new Error(decision.deny);
          if (decision && "input" in decision) input = decision.input;
        }
        return await t.execute(input as Record<string, unknown>, {
          runtime: ctx.runtime,
          signal: options.abortSignal,
        });
      },
    });
  }

  let step = 0;

  while (step < maxSteps) {
    step++;
    if (signal?.aborted) break;

    // Drain point 1: inject steering messages before next model call
    if (getSteeringMessages) {
      const steering = getSteeringMessages();
      for (const msg of steering) messages.push(msg);
    }

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: toolDefs as Parameters<typeof streamText>[0]["tools"],
      stopWhen: stepCountIs(1),
      experimental_context: { runtime, onBeforeToolCall } satisfies LoopContext,
      abortSignal: signal,
    });

    let hasToolCalls = false;

    for await (const part of result.fullStream) {
      if (signal?.aborted) break;

      if (part.type === "tool-call") hasToolCalls = true;

      if (STREAM_EVENTS.has(part.type)) {
        yield part as LoopEvent;
      }
    }

    // Get response messages, yield message events
    const [response, usage, finishReason] = await Promise.all([
      result.response,
      result.usage,
      result.finishReason,
    ]);

    for (const msg of response.messages) {
      messages.push(msg as ModelMessage);

      if (msg.role === "assistant") {
        yield {
          type: "message",
          message: msg as ModelMessage & { role: "assistant" },
          usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
          finishReason,
        };
      } else {
        yield {
          type: "message",
          message: msg as ModelMessage & { role: "tool" },
        };
      }
    }

    // Drain point 3: follow-up messages keep the loop alive
    if (!hasToolCalls) {
      if (getFollowUpMessages) {
        const followUp = getFollowUpMessages();
        if (followUp.length > 0) {
          for (const msg of followUp) messages.push(msg);
          continue;
        }
      }
      break;
    }
  }
}
