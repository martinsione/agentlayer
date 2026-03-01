import { tool, jsonSchema } from "@ai-sdk/provider-utils";
import type { ModelMessage, ToolCallPart } from "@ai-sdk/provider-utils";
import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { LoopEvent, Tool, Runtime, ToolCallDecision } from "./types";

export type LoopConfig = {
  model: LanguageModel;
  systemPrompt?: string;
  tools: Tool[];
  runtime: Runtime;
  maxSteps: number;
};

export async function* loop(
  messages: ModelMessage[],
  config: LoopConfig,
  signal?: AbortSignal,
): AsyncGenerator<LoopEvent, void, ToolCallDecision> {
  const { model, systemPrompt, tools, runtime, maxSteps } = config;

  const toolDefs: Record<string, unknown> = {};
  for (const t of tools) {
    toolDefs[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
    });
  }

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let step = 0;

  while (step < maxSteps) {
    step++;
    if (signal?.aborted) break;

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: toolDefs as Parameters<typeof streamText>[0]["tools"],
      abortSignal: signal,
    });

    let text = "";
    const toolCalls: ToolCallPart[] = [];

    for await (const part of result.fullStream) {
      if (signal?.aborted) break;

      if (part.type === "text-delta") {
        text += part.text;
        yield { type: "text_delta", delta: part.text };
      } else if (part.type === "tool-call") {
        toolCalls.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input as Record<string, unknown>,
        });
      }
    }

    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls],
    };
    messages.push(assistantMessage);
    yield { type: "message", message: assistantMessage };

    const usage = await result.usage;
    const finishReason = await result.finishReason;
    yield {
      type: "step",
      usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
      finishReason,
    };

    if (toolCalls.length === 0) break;

    // Phase 1: collect decisions
    type PendingCall = {
      tc: ToolCallPart;
      tool: Tool | undefined;
      decision: ToolCallDecision;
    };
    const pending: PendingCall[] = [];

    for (const tc of toolCalls) {
      const t = toolMap.get(tc.toolName);
      let decision: ToolCallDecision;
      if (!t) {
        decision = undefined;
      } else {
        decision = yield {
          type: "tool_call",
          callId: tc.toolCallId,
          name: tc.toolName,
          args: tc.input as Record<string, unknown>,
        };
      }
      pending.push({ tc, tool: t, decision });
    }

    // Phase 2: execute in parallel
    const settled = await Promise.all(
      pending.map(
        async ({ tc, tool: t, decision }): Promise<{ output: string; isError: boolean }> => {
          if (!t) {
            return { output: `Tool not found: ${tc.toolName}`, isError: true };
          }
          if (decision && "deny" in decision) {
            return { output: decision.deny, isError: true };
          }
          const args =
            decision && "args" in decision ? decision.args : (tc.input as Record<string, unknown>);
          try {
            const output = await t.execute(args, { runtime, signal });
            return { output, isError: false };
          } catch (err) {
            return { output: err instanceof Error ? err.message : String(err), isError: true };
          }
        },
      ),
    );

    // Phase 3: yield results
    for (let i = 0; i < pending.length; i++) {
      const { tc } = pending[i]!;
      const { output, isError } = settled[i]!;

      const toolMessage: ModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: "text", value: output },
          },
        ],
      };
      messages.push(toolMessage);
      yield {
        type: "tool_result",
        callId: tc.toolCallId,
        name: tc.toolName,
        result: output,
        isError,
        message: toolMessage,
      };
    }
  }
}
