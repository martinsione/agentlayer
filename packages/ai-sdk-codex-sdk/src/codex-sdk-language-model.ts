import type { ReadableStreamDefaultController } from "node:stream/web";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { Codex, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { mapPromptToCodexInput } from "./codex-sdk-message-mapper";
import { getCodexSdkModelInfo } from "./codex-sdk-model-info";
import type {
  CodexSdkCallSettings,
  CodexSdkModelSettings,
  CodexSdkProviderSettings,
} from "./codex-sdk-options";

type CodexSdkModelInit = {
  providerId: string;
  modelId: string;
  providerSettings: CodexSdkProviderSettings;
  modelSettings?: CodexSdkModelSettings;
};

export class CodexSdkLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};

  private codex: Codex;
  private defaultThreadOptions: ThreadOptions;

  constructor(init: CodexSdkModelInit) {
    this.provider = init.providerId;
    this.modelId = init.modelId;

    const baseUrl = resolveBaseUrl(init.providerSettings);

    const codexOptions = {
      ...(init.providerSettings.apiKey != null ? { apiKey: init.providerSettings.apiKey } : {}),
      ...(baseUrl != null ? { baseUrl } : {}),
      ...(init.providerSettings.codexPathOverride != null
        ? { codexPathOverride: init.providerSettings.codexPathOverride }
        : {}),
      ...(init.providerSettings.env != null ? { env: init.providerSettings.env } : {}),
      ...(init.providerSettings.config != null ? { config: init.providerSettings.config } : {}),
    };
    this.codex = new Codex(codexOptions);

    this.defaultThreadOptions = mergeThreadOptions(
      init.providerSettings.threadOptions,
      init.modelSettings,
      this.modelId,
    );
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { input, warnings: promptWarnings } = mapPromptToCodexInput(options.prompt);

    const callSettings = getCallSettings(options.providerOptions, this.provider);
    const threadOptions = mergeThreadOptions(
      this.defaultThreadOptions,
      withoutThreadId(callSettings),
      this.modelId,
    );
    const warnings = [
      ...promptWarnings,
      ...getUnsupportedWarnings(options, threadOptions, this.modelId),
    ];

    const thread =
      callSettings.threadId != null
        ? this.codex.resumeThread(callSettings.threadId, threadOptions)
        : this.codex.startThread(threadOptions);

    const outputSchema =
      options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;

    const turn = await thread.run(input, makeTurnOptions(outputSchema, options.abortSignal));

    const finalText =
      turn.finalResponse.trim().length > 0
        ? turn.finalResponse
        : (extractLastAgentMessage(turn.items) ?? "");

    return {
      content: [{ type: "text", text: finalText }],
      finishReason: { unified: "stop", raw: undefined },
      usage: mapUsage(turn.usage),
      warnings,
      providerMetadata: createProviderMetadata(this.provider, thread.id ?? callSettings.threadId),
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const { input, warnings: promptWarnings } = mapPromptToCodexInput(options.prompt);

    const callSettings = getCallSettings(options.providerOptions, this.provider);
    const threadOptions = mergeThreadOptions(
      this.defaultThreadOptions,
      withoutThreadId(callSettings),
      this.modelId,
    );
    const warnings = [
      ...promptWarnings,
      ...getUnsupportedWarnings(options, threadOptions, this.modelId),
    ];

    const thread =
      callSettings.threadId != null
        ? this.codex.resumeThread(callSettings.threadId, threadOptions)
        : this.codex.startThread(threadOptions);

    const outputSchema =
      options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;

    const streamed = await thread.runStreamed(
      input,
      makeTurnOptions(outputSchema, options.abortSignal),
    );

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: "stream-start", warnings });

        const toolCallsByItemId = new Map<string, string>();
        const textByItemId = new Map<string, string>();
        const reasoningByItemId = new Map<string, string>();

        let finalized = false;
        let threadId = thread.id ?? callSettings.threadId;
        let responseMetadataSent = false;

        const finish = (
          finishReason: LanguageModelV3FinishReason,
          usage?: Usage | null,
          includeRawUsage = true,
        ): void => {
          if (finalized) {
            return;
          }
          finalized = true;
          controller.enqueue({
            type: "finish",
            finishReason,
            usage: mapUsage(usage, includeRawUsage),
            providerMetadata: createProviderMetadata(this.provider, threadId),
          });
        };

        if (threadId != null) {
          controller.enqueue({
            type: "response-metadata",
            id: threadId,
            modelId: this.modelId,
          });
          responseMetadataSent = true;
        }

        try {
          for await (const event of streamed.events) {
            switch (event.type) {
              case "thread.started": {
                threadId = event.thread_id;
                if (!responseMetadataSent) {
                  controller.enqueue({
                    type: "response-metadata",
                    id: event.thread_id,
                    modelId: this.modelId,
                  });
                  responseMetadataSent = true;
                }
                break;
              }

              case "item.started": {
                emitStartedToolEvent(event, toolCallsByItemId, controller);
                break;
              }

              case "item.updated": {
                emitUpdatedItem(
                  event,
                  toolCallsByItemId,
                  textByItemId,
                  reasoningByItemId,
                  controller,
                );
                break;
              }

              case "item.completed": {
                emitCompletedItem(
                  event,
                  toolCallsByItemId,
                  textByItemId,
                  reasoningByItemId,
                  controller,
                );
                break;
              }

              case "turn.completed": {
                finish({ unified: "stop", raw: undefined }, event.usage);
                return;
              }

              case "turn.failed": {
                controller.enqueue({
                  type: "error",
                  error: new Error(event.error.message),
                });
                finish({ unified: "error", raw: "turn-failed" }, null, false);
                return;
              }

              case "error": {
                controller.enqueue({
                  type: "error",
                  error: new Error(event.message),
                });
                finish({ unified: "error", raw: "stream-error" }, null, false);
                return;
              }

              default:
                break;
            }
          }

          if (!finalized) {
            finish({ unified: "stop", raw: undefined }, null, false);
          }
        } catch (error) {
          controller.enqueue({ type: "error", error: asError(error) });
          if (!finalized) {
            finish({ unified: "error", raw: "stream-crashed" }, null, false);
          }
        } finally {
          controller.close();
        }
      },
    });

    return { stream };
  }
}

function emitStartedToolEvent(
  event: Extract<ThreadEvent, { type: "item.started" }>,
  toolCallsByItemId: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const item = event.item;

  if (item.type === "command_execution") {
    const toolCallId = item.id;
    toolCallsByItemId.set(item.id, toolCallId);
    controller.enqueue({
      type: "tool-call",
      toolCallId,
      toolName: "exec",
      input: JSON.stringify({ command: item.command }),
      providerExecuted: true,
      dynamic: true,
    });
    return;
  }

  if (item.type === "mcp_tool_call") {
    const toolCallId = item.id;
    toolCallsByItemId.set(item.id, toolCallId);
    controller.enqueue({
      type: "tool-call",
      toolCallId,
      toolName: `${item.server}/${item.tool}`,
      input: JSON.stringify(item.arguments ?? {}),
      providerExecuted: true,
      dynamic: true,
    });
  }
}

function emitCompletedItem(
  event: Extract<ThreadEvent, { type: "item.completed" }>,
  toolCallsByItemId: Map<string, string>,
  textByItemId: Map<string, string>,
  reasoningByItemId: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const item = event.item;

  if (item.type === "agent_message") {
    emitTextDelta(item.id, item.text, textByItemId, controller);
    controller.enqueue({ type: "text-end", id: item.id });
    textByItemId.delete(item.id);
    return;
  }

  if (item.type === "reasoning") {
    emitReasoningDelta(item.id, item.text, reasoningByItemId, controller);
    controller.enqueue({ type: "reasoning-end", id: item.id });
    reasoningByItemId.delete(item.id);
    return;
  }

  if (item.type === "error") {
    // Codex can emit non-fatal warning items (e.g. unstable feature notices).
    // Keep stream output focused on actionable model/tool parts and rely on
    // turn.failed / top-level error events for fatal failures.
    return;
  }

  if (item.type === "command_execution") {
    let toolCallId = toolCallsByItemId.get(item.id);
    if (toolCallId == null) {
      toolCallId = item.id;
      toolCallsByItemId.set(item.id, toolCallId);
      controller.enqueue({
        type: "tool-call",
        toolCallId,
        toolName: "exec",
        input: JSON.stringify({ command: item.command }),
        providerExecuted: true,
        dynamic: true,
      });
    }

    const isError = item.status === "failed" || (item.exit_code ?? 0) !== 0;
    controller.enqueue({
      type: "tool-result",
      toolCallId,
      toolName: "exec",
      dynamic: true,
      result: {
        command: item.command,
        aggregatedOutput: item.aggregated_output,
        exitCode: item.exit_code,
        status: item.status,
      },
      ...(isError ? { isError: true } : {}),
    });
    return;
  }

  if (item.type === "mcp_tool_call") {
    let toolCallId = toolCallsByItemId.get(item.id);
    if (toolCallId == null) {
      toolCallId = item.id;
      toolCallsByItemId.set(item.id, toolCallId);
      controller.enqueue({
        type: "tool-call",
        toolCallId,
        toolName: `${item.server}/${item.tool}`,
        input: JSON.stringify(item.arguments ?? {}),
        providerExecuted: true,
        dynamic: true,
      });
    }

    const isError = item.status === "failed";
    controller.enqueue({
      type: "tool-result",
      toolCallId,
      toolName: `${item.server}/${item.tool}`,
      dynamic: true,
      result: (item.result?.structured_content ??
        item.result?.content ??
        item.error?.message ??
        "") as any,
      ...(isError ? { isError: true } : {}),
    });
  }
}

function emitUpdatedItem(
  event: Extract<ThreadEvent, { type: "item.updated" }>,
  toolCallsByItemId: Map<string, string>,
  textByItemId: Map<string, string>,
  reasoningByItemId: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const item = event.item;

  if (item.type === "agent_message") {
    emitTextDelta(item.id, item.text, textByItemId, controller);
    return;
  }

  if (item.type === "reasoning") {
    emitReasoningDelta(item.id, item.text, reasoningByItemId, controller);
    return;
  }

  if (item.type === "command_execution") {
    let toolCallId = toolCallsByItemId.get(item.id);
    if (toolCallId == null) {
      toolCallId = item.id;
      toolCallsByItemId.set(item.id, toolCallId);
      controller.enqueue({
        type: "tool-call",
        toolCallId,
        toolName: "exec",
        input: JSON.stringify({ command: item.command }),
        providerExecuted: true,
        dynamic: true,
      });
    }

    const isError = item.status === "failed" || (item.exit_code ?? 0) !== 0;
    controller.enqueue({
      type: "tool-result",
      toolCallId,
      toolName: "exec",
      dynamic: true,
      result: {
        command: item.command,
        aggregatedOutput: item.aggregated_output,
        exitCode: item.exit_code,
        status: item.status,
      },
      preliminary: true,
      ...(isError ? { isError: true } : {}),
    });
  }
}

function emitTextDelta(
  id: string,
  nextText: string,
  textByItemId: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const previousText = textByItemId.get(id);
  if (previousText == null) {
    controller.enqueue({ type: "text-start", id });
    if (nextText.length > 0) {
      controller.enqueue({ type: "text-delta", id, delta: nextText });
    }
    textByItemId.set(id, nextText);
    return;
  }

  const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
  if (delta.length > 0) {
    controller.enqueue({ type: "text-delta", id, delta });
  }
  textByItemId.set(id, nextText);
}

function emitReasoningDelta(
  id: string,
  nextText: string,
  reasoningByItemId: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const previousText = reasoningByItemId.get(id);
  if (previousText == null) {
    controller.enqueue({ type: "reasoning-start", id });
    if (nextText.length > 0) {
      controller.enqueue({ type: "reasoning-delta", id, delta: nextText });
    }
    reasoningByItemId.set(id, nextText);
    return;
  }

  const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
  if (delta.length > 0) {
    controller.enqueue({ type: "reasoning-delta", id, delta });
  }
  reasoningByItemId.set(id, nextText);
}

function createProviderMetadata(
  providerId: string,
  threadId: string | null | undefined,
): SharedV3ProviderMetadata {
  return {
    [providerId]: {
      threadId: threadId ?? null,
    },
  };
}

function getUnsupportedWarnings(
  options: LanguageModelV3CallOptions,
  threadOptions: ThreadOptions,
  modelId: string,
): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  const pushUnsupported = (feature: string, details: string): void => {
    warnings.push({
      type: "unsupported",
      feature,
      details,
    });
  };

  if (options.tools != null || options.toolChoice != null) {
    pushUnsupported("tools", "codex-sdk provider ignores AI SDK tools and toolChoice options.");
  }
  if (options.includeRawChunks) {
    pushUnsupported("includeRawChunks", "codex-sdk provider does not surface raw provider chunks.");
  }
  if (hasHeaders(options.headers)) {
    pushUnsupported(
      "headers",
      "codex-sdk provider does not support per-call HTTP headers in AI SDK call options.",
    );
  }
  if (options.temperature != null) {
    pushUnsupported(
      "temperature",
      "codex-sdk provider ignores temperature in AI SDK call options.",
    );
  }
  if (options.topP != null) {
    pushUnsupported("topP", "codex-sdk provider ignores topP in AI SDK call options.");
  }
  if (options.topK != null) {
    pushUnsupported("topK", "codex-sdk provider ignores topK in AI SDK call options.");
  }
  if (options.maxOutputTokens != null) {
    pushUnsupported(
      "maxOutputTokens",
      "codex-sdk provider ignores maxOutputTokens in AI SDK call options.",
    );
  }
  if (options.stopSequences != null && options.stopSequences.length > 0) {
    pushUnsupported(
      "stopSequences",
      "codex-sdk provider ignores stopSequences in AI SDK call options.",
    );
  }
  if (options.presencePenalty != null) {
    pushUnsupported(
      "presencePenalty",
      "codex-sdk provider ignores presencePenalty in AI SDK call options.",
    );
  }
  if (options.frequencyPenalty != null) {
    pushUnsupported(
      "frequencyPenalty",
      "codex-sdk provider ignores frequencyPenalty in AI SDK call options.",
    );
  }
  if (options.seed != null) {
    pushUnsupported("seed", "codex-sdk provider ignores seed in AI SDK call options.");
  }
  if (
    options.responseFormat?.type === "json" &&
    (options.responseFormat.name != null || options.responseFormat.description != null)
  ) {
    pushUnsupported(
      "responseFormat.name/description",
      "codex-sdk provider only forwards responseFormat.schema as Codex outputSchema.",
    );
  }

  const modelInfo = getCodexSdkModelInfo(modelId);
  const requestedReasoningEffort = threadOptions.modelReasoningEffort;
  if (
    requestedReasoningEffort != null &&
    modelInfo != null &&
    modelInfo.supportedReasoningEfforts.length > 0 &&
    !modelInfo.supportedReasoningEfforts.includes(requestedReasoningEffort)
  ) {
    pushUnsupported(
      "modelReasoningEffort",
      `modelReasoningEffort "${requestedReasoningEffort}" is not listed as supported for ${modelInfo.modelId}. Supported values: ${modelInfo.supportedReasoningEfforts.join(", ")}.`,
    );
  }

  return warnings;
}

function hasHeaders(headers: LanguageModelV3CallOptions["headers"]): boolean {
  if (headers == null) {
    return false;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return [...headers.keys()].length > 0;
  }

  if (Array.isArray(headers)) {
    return headers.length > 0;
  }

  if (typeof headers === "object") {
    return Object.keys(headers).length > 0;
  }

  return true;
}

function getCallSettings(providerOptions: unknown, providerId: string): CodexSdkCallSettings {
  if (providerOptions == null || typeof providerOptions !== "object") {
    return {};
  }

  const value = (providerOptions as Record<string, unknown>)[providerId];
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as CodexSdkCallSettings;
}

function mapUsage(usage: Usage | null | undefined, includeRaw = true): LanguageModelV3Usage {
  if (usage == null) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
    };
  }

  const inputTotal = usage.input_tokens;
  const cacheRead = usage.cached_input_tokens;

  return {
    inputTokens: {
      total: inputTotal,
      noCache: Math.max(0, inputTotal - cacheRead),
      cacheRead,
      cacheWrite: 0,
    },
    outputTokens: {
      total: usage.output_tokens,
      text: undefined,
      reasoning: undefined,
    },
    ...(includeRaw
      ? {
          raw: {
            input_tokens: usage.input_tokens,
            cached_input_tokens: usage.cached_input_tokens,
            output_tokens: usage.output_tokens,
          },
        }
      : {}),
  };
}

function extractLastAgentMessage(
  items: Array<
    | {
        type: "agent_message";
        text: string;
      }
    | {
        type: string;
      }
  >,
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item != null && item.type === "agent_message" && "text" in item) {
      return item.text;
    }
  }

  return undefined;
}

function mergeThreadOptions(
  base: ThreadOptions | undefined,
  extra: Partial<ThreadOptions> | undefined,
  modelId: string,
): ThreadOptions {
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    model: modelId,
  };
}

function withoutThreadId(settings: CodexSdkCallSettings): Partial<ThreadOptions> {
  const { threadId: _threadId, ...threadOptions } = settings;
  return threadOptions;
}

function resolveBaseUrl(settings: CodexSdkProviderSettings): string | undefined {
  return settings.baseUrl ?? settings.baseURL;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown stream error");
}

function makeTurnOptions(
  outputSchema: unknown | undefined,
  signal: AbortSignal | undefined,
): { outputSchema?: unknown; signal?: AbortSignal } {
  return {
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}
