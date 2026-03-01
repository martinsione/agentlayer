import { tool, jsonSchema } from "@ai-sdk/provider-utils";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { streamText, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { STREAM_EVENT_TYPES } from "./types";
import type {
  LoopEvent,
  Tool,
  ToolResult,
  Runtime,
  ToolProgressEvent,
  BeforeToolCallEvent,
  ToolCallDecision,
  AfterToolCallEvent,
  AfterToolCallDecision,
  BeforeModelCallEvent,
  BeforeModelCallDecision,
  BeforeStopEvent,
  BeforeStopDecision,
  ThinkingLevel,
  ThinkingBudgets,
} from "./types";

const STREAM_EVENTS: Set<string> = new Set(STREAM_EVENT_TYPES);

export type LoopHooks = {
  beforeToolCall?: (event: BeforeToolCallEvent) => Promise<ToolCallDecision>;
  afterToolCall?: (event: AfterToolCallEvent) => Promise<AfterToolCallDecision>;
  beforeModelCall?: (event: BeforeModelCallEvent) => Promise<BeforeModelCallDecision>;
  beforeStop?: (event: BeforeStopEvent) => Promise<BeforeStopDecision>;
};

export type LoopConfig = {
  model: LanguageModel;
  systemPrompt?: string;
  tools: Tool[];
  runtime: Runtime;
  maxSteps: number;
  hooks?: LoopHooks;
  onToolProgress?: (event: ToolProgressEvent) => void;
  getSteeringMessages?: () => ModelMessage[];
  getFollowUpMessages?: () => ModelMessage[];
  thinkingLevel?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  transformContext?: (messages: ModelMessage[]) => ModelMessage[] | Promise<ModelMessage[]>;
};

const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
  minimal: 1024,
  low: 4096,
  medium: 10000,
  high: 32000,
};

function getThinkingBudget(
  level: ThinkingLevel | undefined,
  custom?: ThinkingBudgets,
): number | undefined {
  if (!level || level === "off") return undefined;
  return custom?.[level] ?? DEFAULT_THINKING_BUDGETS[level];
}

function buildToolDefs(
  tools: Tool[],
  runtime: Runtime,
  hooks?: LoopHooks,
  onToolProgress?: LoopConfig["onToolProgress"],
): Record<string, unknown> {
  const toolDefs: Record<string, unknown> = {};
  for (const t of tools) {
    toolDefs[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
      execute: async (input, options) => {
        let resolvedInput = input as Record<string, unknown>;

        if (hooks?.beforeToolCall) {
          const approval =
            typeof t.needsApproval === "function"
              ? t.needsApproval(resolvedInput)
              : !!t.needsApproval;
          const decision = await hooks.beforeToolCall({
            toolCallId: options.toolCallId,
            toolName: t.name,
            input: resolvedInput,
            needsApproval: approval,
          });
          if (decision && "deny" in decision) throw new Error(decision.deny);
          if (decision && "input" in decision) resolvedInput = decision.input;
        }

        const onProgress = onToolProgress
          ? (text: string) =>
              onToolProgress({ toolCallId: options.toolCallId, toolName: t.name, text })
          : undefined;

        let result: string;
        try {
          const rawOrGen = t.execute(resolvedInput, {
            runtime,
            signal: options.abortSignal,
            onProgress,
          });

          let raw: string | ToolResult;
          // Detect async generators by checking for Symbol.asyncIterator
          if (rawOrGen && Symbol.asyncIterator in (rawOrGen as any)) {
            const gen = rawOrGen as AsyncGenerator<string, string | ToolResult>;
            let iterResult = await gen.next();
            while (!iterResult.done) {
              // Each yielded value is a progress string
              if (onProgress) onProgress(iterResult.value);
              iterResult = await gen.next();
            }
            raw = iterResult.value;
          } else {
            raw = await (rawOrGen as Promise<string | ToolResult>);
          }

          result = typeof raw === "string" ? raw : raw.output;
        } catch (err) {
          if (hooks?.afterToolCall) {
            await hooks.afterToolCall({
              toolCallId: options.toolCallId,
              toolName: t.name,
              input: resolvedInput,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
          throw err;
        }

        if (hooks?.afterToolCall) {
          const decision = await hooks.afterToolCall({
            toolCallId: options.toolCallId,
            toolName: t.name,
            input: resolvedInput,
            result,
          });
          if (decision && "result" in decision) return decision.result;
        }

        return result;
      },
    });
  }
  return toolDefs;
}

export async function* loop(
  messages: readonly ModelMessage[],
  config: LoopConfig,
  signal?: AbortSignal,
): AsyncGenerator<LoopEvent> {
  const {
    model,
    systemPrompt,
    tools,
    runtime,
    maxSteps,
    hooks,
    getSteeringMessages,
    getFollowUpMessages,
  } = config;

  // Clone so we never mutate the caller's array
  const msgs = [...messages];

  const toolDefs = buildToolDefs(tools, runtime, hooks, config.onToolProgress);
  let step = 0;

  while (step < maxSteps) {
    step++;
    if (signal?.aborted) break;

    yield { type: "step-start", step } as LoopEvent;

    // Drain point 1: inject steering messages before next model call
    if (getSteeringMessages) {
      const steering = getSteeringMessages();
      for (const msg of steering) msgs.push(msg);
    }

    let system = systemPrompt;
    let currentToolDefs = toolDefs;

    if (hooks?.beforeModelCall) {
      const decision = await hooks.beforeModelCall({ system, tools, messages: msgs });
      if (decision && typeof decision === "object") {
        if ("system" in decision && decision.system !== undefined) system = decision.system;
        if ("tools" in decision && decision.tools !== undefined) {
          currentToolDefs = buildToolDefs(decision.tools, runtime, hooks, config.onToolProgress);
        }
      }
    }

    const budget = getThinkingBudget(config.thinkingLevel, config.thinkingBudgets);
    const contextMessages = config.transformContext
      ? await config.transformContext([...msgs])
      : msgs;

    const result = streamText({
      model,
      system,
      messages: contextMessages,
      tools: currentToolDefs as Parameters<typeof streamText>[0]["tools"],
      stopWhen: stepCountIs(1),
      abortSignal: signal,
      ...(budget !== undefined && {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: budget } },
        },
      }),
    });

    let hasToolCalls = false;

    for await (const part of result.fullStream) {
      if (signal?.aborted) break;

      if (part.type === "tool-call") hasToolCalls = true;

      if (STREAM_EVENTS.has(part.type)) {
        yield part as LoopEvent;
      }
    }

    if (signal?.aborted) break;

    // Get response messages, yield message events
    const [response, usage, finishReason] = await Promise.all([
      result.response,
      result.usage,
      result.finishReason,
    ]);

    for (const msg of response.messages) {
      msgs.push(msg as ModelMessage);

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

    yield { type: "step-end", step } as LoopEvent;

    // Drain point 3: follow-up messages keep the loop alive
    if (!hasToolCalls) {
      if (getFollowUpMessages) {
        const followUp = getFollowUpMessages();
        if (followUp.length > 0) {
          for (const msg of followUp) msgs.push(msg);
          continue;
        }
      }

      // before-stop hook can prevent the loop from ending
      if (hooks?.beforeStop) {
        const decision = await hooks.beforeStop({ messages: msgs });
        if (decision && "preventStop" in decision && decision.preventStop) {
          continue;
        }
      }

      break;
    }
  }
}
