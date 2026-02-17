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
import type {
  Options,
  Query,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mapPromptToClaudeAgentPrompt } from "./claude-agent-sdk-message-mapper";
import type {
  ClaudeAgentSdkCallSettings,
  ClaudeAgentSdkModelSettings,
  ClaudeAgentSdkProviderSettings,
} from "./claude-agent-sdk-options";

type ClaudeAgentSdkModelInit = {
  providerId: string;
  modelId: string;
  providerSettings: ClaudeAgentSdkProviderSettings;
  modelSettings?: ClaudeAgentSdkModelSettings;
};

type ClaudeResultSubtype = Exclude<SDKResultMessage["subtype"], "success">;

export class ClaudeAgentSdkLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};

  private providerSettings: ClaudeAgentSdkProviderSettings;
  private modelSettings: ClaudeAgentSdkModelSettings;

  constructor(init: ClaudeAgentSdkModelInit) {
    this.provider = init.providerId;
    this.modelId = init.modelId;
    this.providerSettings = init.providerSettings;
    this.modelSettings = init.modelSettings ?? {};
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { prompt, warnings: promptWarnings } = mapPromptToClaudeAgentPrompt(options.prompt);
    const callSettings = getCallSettings(options.providerOptions, this.provider);
    const warnings = [...promptWarnings, ...getUnsupportedWarnings(options)];

    const outputSchema = resolveJsonOutputSchema(options.responseFormat);

    const { abortController, cleanup: cleanupAbortController } = createAbortController(
      options.abortSignal,
    );

    const queryOptions = makeQueryOptions({
      modelId: this.modelId,
      providerSettings: this.providerSettings,
      modelSettings: this.modelSettings,
      callSettings,
      outputSchema,
      abortController,
    });

    const run = query({ prompt, options: queryOptions });

    let resultMessage: SDKResultMessage | undefined;
    let lastAssistantText = "";
    let sessionId: string | null | undefined;
    let resolvedModelId: string | undefined;

    try {
      for await (const message of run) {
        sessionId ??= message.session_id;
        resolvedModelId ??= readResolvedModelId(message);

        if (message.type === "assistant") {
          const assistantText = extractAssistantText(message);
          if (assistantText.trim().length > 0) {
            lastAssistantText = assistantText;
          }
          continue;
        }

        if (message.type === "result") {
          resultMessage = message;
        }
      }
    } finally {
      cleanupAbortController();
      safeCloseQuery(run);
    }

    if (resultMessage == null) {
      throw new Error("claude-agent-sdk stream ended without a result message.");
    }

    if (resultMessage.subtype !== "success") {
      throw new Error(formatResultError(resultMessage));
    }

    const finalText =
      resultMessage.result.trim().length > 0 ? resultMessage.result : (lastAssistantText ?? "");

    return {
      content: [{ type: "text", text: finalText }],
      finishReason: { unified: "stop", raw: resultMessage.stop_reason ?? undefined },
      usage: mapUsage(resultMessage.usage),
      warnings,
      providerMetadata: createProviderMetadata(
        this.provider,
        this.modelId,
        sessionId,
        resultMessage,
        resolvedModelId,
      ),
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const { prompt, warnings: promptWarnings } = mapPromptToClaudeAgentPrompt(options.prompt);
    const includeRawChunks = options.includeRawChunks === true;
    const callSettings = getCallSettings(options.providerOptions, this.provider);
    const warnings = [...promptWarnings, ...getUnsupportedWarnings(options)];

    const outputSchema = resolveJsonOutputSchema(options.responseFormat);

    const { abortController, cleanup: cleanupAbortController } = createAbortController(
      options.abortSignal,
    );

    const queryOptions = makeQueryOptions({
      modelId: this.modelId,
      providerSettings: this.providerSettings,
      modelSettings: this.modelSettings,
      callSettings,
      outputSchema,
      abortController,
    });

    const run = query({ prompt, options: queryOptions });

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: "stream-start", warnings });

        let finalized = false;
        let sessionId: string | null | undefined;
        let resolvedModelId: string | undefined;
        let responseMetadataSent = false;

        const toolCallNameById = new Map<string, string>();

        const finish = (
          finishReason: LanguageModelV3FinishReason,
          usage?: unknown,
          result?: SDKResultMessage,
        ): void => {
          if (finalized) {
            return;
          }

          finalized = true;
          controller.enqueue({
            type: "finish",
            finishReason,
            usage: mapUsage(usage),
            providerMetadata: createProviderMetadata(
              this.provider,
              this.modelId,
              sessionId,
              result,
              resolvedModelId,
            ),
          });
        };

        try {
          for await (const message of run) {
            if (includeRawChunks) {
              controller.enqueue({
                type: "raw",
                rawValue: message,
              });
            }

            sessionId ??= message.session_id;
            resolvedModelId ??= readResolvedModelId(message);

            if (!responseMetadataSent && sessionId != null) {
              controller.enqueue({
                type: "response-metadata",
                id: sessionId,
                modelId: resolvedModelId ?? this.modelId,
              });
              responseMetadataSent = true;
            }

            if (message.type === "assistant") {
              emitAssistantMessage(message, toolCallNameById, controller);
              continue;
            }

            if (message.type === "user") {
              emitUserToolResults(message, toolCallNameById, controller);
              continue;
            }

            if (message.type === "result") {
              if (message.subtype === "success") {
                finish(
                  { unified: "stop", raw: message.stop_reason ?? undefined },
                  message.usage,
                  message,
                );
              } else {
                controller.enqueue({ type: "error", error: new Error(formatResultError(message)) });
                finish(
                  { unified: mapErrorSubtypeToUnified(message.subtype), raw: message.subtype },
                  message.usage,
                  message,
                );
              }
              return;
            }
          }

          if (!finalized) {
            finish({ unified: "stop", raw: undefined }, undefined);
          }
        } catch (error) {
          controller.enqueue({ type: "error", error: asError(error) });
          if (!finalized) {
            finish({ unified: "error", raw: "stream-crashed" }, undefined);
          }
        } finally {
          cleanupAbortController();
          safeCloseQuery(run);
          controller.close();
        }
      },
    });

    return { stream };
  }
}

function emitAssistantMessage(
  message: SDKAssistantMessage,
  toolCallNameById: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const blocks = normalizeContentBlocks(message.message?.content);

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block == null) {
      continue;
    }

    const blockType = readString(block, "type");

    if (blockType === "text") {
      const text = readString(block, "text");
      if (text != null) {
        emitTextBlock(`${message.uuid}:text:${index}`, text, controller);
      }
      continue;
    }

    if (blockType === "thinking") {
      const text = readString(block, "thinking") ?? readString(block, "text");
      if (text != null) {
        emitReasoningBlock(`${message.uuid}:thinking:${index}`, text, controller);
      }
      continue;
    }

    if (blockType === "tool_use") {
      const toolCallId = readString(block, "id") ?? `${message.uuid}:tool:${index}`;
      const toolName = readString(block, "name") ?? "tool";
      const input = readUnknown(block, "input") ?? {};

      toolCallNameById.set(toolCallId, toolName);
      controller.enqueue({
        type: "tool-call",
        toolCallId,
        toolName,
        input: JSON.stringify(input),
        providerExecuted: true,
        dynamic: true,
      });
    }
  }
}

function emitUserToolResults(
  message: SDKUserMessage,
  toolCallNameById: Map<string, string>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  const payload = asObject(message.message);
  const content = payload?.content;
  const emittedToolResultIds = new Set<string>();

  if (Array.isArray(content)) {
    for (const block of content) {
      const blockObj = asObject(block);
      if (readString(blockObj, "type") !== "tool_result") {
        continue;
      }

      const toolCallId =
        readString(blockObj, "tool_use_id") ?? message.parent_tool_use_id ?? "tool-result";
      const toolName = toolCallNameById.get(toolCallId) ?? "tool";
      const result = normalizeToolResult(readUnknown(blockObj, "content"));
      const isError = readBoolean(blockObj, "is_error") === true;

      controller.enqueue({
        type: "tool-result",
        toolCallId,
        toolName,
        dynamic: true,
        result: result as any,
        ...(isError ? { isError: true } : {}),
      });
      emittedToolResultIds.add(toolCallId);
    }
  }

  if (message.tool_use_result != null && message.parent_tool_use_id != null) {
    const toolCallId = message.parent_tool_use_id;
    if (emittedToolResultIds.has(toolCallId)) {
      return;
    }
    const toolName = toolCallNameById.get(toolCallId) ?? "tool";

    controller.enqueue({
      type: "tool-result",
      toolCallId,
      toolName,
      dynamic: true,
      result: message.tool_use_result as any,
    });
  }
}

function emitTextBlock(
  id: string,
  text: string,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  controller.enqueue({ type: "text-start", id });
  if (text.length > 0) {
    controller.enqueue({ type: "text-delta", id, delta: text });
  }
  controller.enqueue({ type: "text-end", id });
}

function emitReasoningBlock(
  id: string,
  text: string,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): void {
  controller.enqueue({ type: "reasoning-start", id });
  if (text.length > 0) {
    controller.enqueue({ type: "reasoning-delta", id, delta: text });
  }
  controller.enqueue({ type: "reasoning-end", id });
}

function mapErrorSubtypeToUnified(
  subtype: ClaudeResultSubtype,
): LanguageModelV3FinishReason["unified"] {
  if (subtype === "error_max_turns") {
    return "length";
  }

  return "error";
}

function getUnsupportedWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];

  const pushUnsupported = (feature: string, details: string): void => {
    warnings.push({ type: "unsupported", feature, details });
  };

  if (options.tools != null || options.toolChoice != null) {
    pushUnsupported(
      "tools",
      "claude-agent-sdk provider ignores AI SDK tools and toolChoice options in favor of agent-native tooling.",
    );
  }

  if (hasHeaders(options.headers)) {
    pushUnsupported(
      "headers",
      "claude-agent-sdk provider does not support per-call HTTP headers in AI SDK call options.",
    );
  }

  if (options.temperature != null) {
    pushUnsupported(
      "temperature",
      "claude-agent-sdk provider ignores temperature in AI SDK call options.",
    );
  }

  if (options.topP != null) {
    pushUnsupported("topP", "claude-agent-sdk provider ignores topP in AI SDK call options.");
  }

  if (options.topK != null) {
    pushUnsupported("topK", "claude-agent-sdk provider ignores topK in AI SDK call options.");
  }

  if (options.maxOutputTokens != null) {
    pushUnsupported(
      "maxOutputTokens",
      "claude-agent-sdk provider ignores maxOutputTokens in AI SDK call options.",
    );
  }

  if (options.stopSequences != null && options.stopSequences.length > 0) {
    pushUnsupported(
      "stopSequences",
      "claude-agent-sdk provider ignores stopSequences in AI SDK call options.",
    );
  }

  if (options.presencePenalty != null) {
    pushUnsupported(
      "presencePenalty",
      "claude-agent-sdk provider ignores presencePenalty in AI SDK call options.",
    );
  }

  if (options.frequencyPenalty != null) {
    pushUnsupported(
      "frequencyPenalty",
      "claude-agent-sdk provider ignores frequencyPenalty in AI SDK call options.",
    );
  }

  if (options.seed != null) {
    pushUnsupported("seed", "claude-agent-sdk provider ignores seed in AI SDK call options.");
  }

  return warnings;
}

function getCallSettings(providerOptions: unknown, providerId: string): ClaudeAgentSdkCallSettings {
  if (providerOptions == null || typeof providerOptions !== "object") {
    return {};
  }

  const readProviderSettings = (providerKey: string): ClaudeAgentSdkCallSettings | null => {
    const providerCallOptions = (providerOptions as Record<string, unknown>)[providerKey];
    if (
      providerCallOptions == null ||
      typeof providerCallOptions !== "object" ||
      Array.isArray(providerCallOptions)
    ) {
      return null;
    }
    return providerCallOptions as ClaudeAgentSdkCallSettings;
  };

  const canonicalSettings = readProviderSettings("claude-agent-sdk");
  if (providerId === "claude-agent-sdk") {
    return canonicalSettings ?? {};
  }

  const customSettings = readProviderSettings(providerId);
  return {
    ...(canonicalSettings ?? {}),
    ...(customSettings ?? {}),
  };
}

function makeQueryOptions(params: {
  modelId: string;
  providerSettings: ClaudeAgentSdkProviderSettings;
  modelSettings: ClaudeAgentSdkModelSettings;
  callSettings: ClaudeAgentSdkCallSettings;
  outputSchema: unknown | undefined;
  abortController: AbortController | undefined;
}): Options {
  const mergedSettings: Record<string, unknown> = {
    ...(params.providerSettings.queryOptions ?? {}),
    ...(params.modelSettings ?? {}),
    ...(params.callSettings ?? {}),
  };

  const env = resolveEnv(
    params.providerSettings,
    readObjectRecord(mergedSettings, "env") as Options["env"] | undefined,
  );

  const outputFormat =
    params.outputSchema != null && typeof params.outputSchema === "object"
      ? { type: "json_schema" as const, schema: params.outputSchema as Record<string, unknown> }
      : undefined;

  return {
    ...(mergedSettings as Partial<Options>),
    ...(env != null ? { env } : {}),
    model: params.modelId,
    ...(params.abortController != null ? { abortController: params.abortController } : {}),
    ...(outputFormat != null ? { outputFormat } : {}),
  };
}

function resolveEnv(
  providerSettings: ClaudeAgentSdkProviderSettings,
  overrideEnv: Options["env"] | undefined,
): Options["env"] | undefined {
  const env: Record<string, string | undefined> = {
    ...(providerSettings.env ?? {}),
    ...(overrideEnv ?? {}),
  };

  if (providerSettings.apiKey != null && env.ANTHROPIC_API_KEY == null) {
    env.ANTHROPIC_API_KEY = providerSettings.apiKey;
  }

  if (providerSettings.authToken != null && env.ANTHROPIC_AUTH_TOKEN == null) {
    env.ANTHROPIC_AUTH_TOKEN = providerSettings.authToken;
  }

  const baseURL = providerSettings.baseURL ?? providerSettings.baseUrl;
  if (baseURL != null && env.ANTHROPIC_BASE_URL == null) {
    env.ANTHROPIC_BASE_URL = baseURL;
  }

  if (Object.keys(env).length === 0) {
    return undefined;
  }

  return env;
}

function mapUsage(usage: unknown): LanguageModelV3Usage {
  if (usage == null || typeof usage !== "object") {
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

  const usageRecord = usage as Record<string, unknown>;

  const inputTotal = toNumber(usageRecord.input_tokens);
  const cacheRead =
    toNumber(usageRecord.cache_read_input_tokens) ?? toNumber(usageRecord.cached_input_tokens) ?? 0;
  const cacheWrite = toNumber(usageRecord.cache_creation_input_tokens) ?? 0;
  const outputTotal = toNumber(usageRecord.output_tokens);
  const rawUsage = {
    input_tokens: inputTotal,
    output_tokens: outputTotal,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };

  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal != null ? Math.max(0, inputTotal - cacheRead - cacheWrite) : undefined,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: outputTotal,
      text: undefined,
      reasoning: undefined,
    },
    raw: rawUsage,
  };
}

function createProviderMetadata(
  providerId: string,
  requestedModelId: string,
  sessionId: string | null | undefined,
  resultMessage?: SDKResultMessage,
  resolvedModelId?: string,
): SharedV3ProviderMetadata {
  const payload: {
    requestedModelId: string;
    resolvedModelId?: string;
    resolvedModelIds?: string[];
    sessionId: string | null;
    stopReason?: string | null;
    numTurns?: number;
    totalCostUsd?: number;
    modelUsage?: SDKResultMessage["modelUsage"];
  } = {
    requestedModelId,
    ...(resolvedModelId != null ? { resolvedModelId } : {}),
    sessionId: sessionId ?? null,
  };

  if (resultMessage != null) {
    payload.stopReason = resultMessage.stop_reason ?? null;
    payload.numTurns = resultMessage.num_turns;
    payload.totalCostUsd = resultMessage.total_cost_usd;
    payload.modelUsage = resultMessage.modelUsage;

    const resolvedModelIds = Object.keys(resultMessage.modelUsage ?? {}).filter(
      (modelId) => modelId.length > 0,
    );
    if (resolvedModelIds.length > 0) {
      payload.resolvedModelIds = resolvedModelIds;
      if (payload.resolvedModelId == null && resolvedModelIds.length === 1) {
        const onlyResolvedModelId = resolvedModelIds[0];
        if (onlyResolvedModelId != null) {
          payload.resolvedModelId = onlyResolvedModelId;
        }
      }
    }
  }

  return {
    [providerId]: payload,
  } satisfies SharedV3ProviderMetadata;
}

function readResolvedModelId(message: unknown): string | undefined {
  if (message == null || typeof message !== "object") {
    return undefined;
  }

  const record = message as Record<string, unknown>;
  if (record.type !== "system" || record.subtype !== "init") {
    return undefined;
  }

  const model = record.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

function extractAssistantText(message: SDKAssistantMessage): string {
  const blocks = normalizeContentBlocks(message.message?.content);
  const parts: string[] = [];

  for (const block of blocks) {
    if (readString(block, "type") !== "text") {
      continue;
    }

    const text = readString(block, "text");
    if (text != null && text.trim().length > 0) {
      parts.push(text);
    }
  }

  return parts.join("\n");
}

function normalizeContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<Record<string, unknown>> = [];
  for (const item of content) {
    const block = asObject(item);
    if (block != null) {
      blocks.push(block);
    }
  }

  return blocks;
}

function normalizeToolResult(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  const textParts: string[] = [];
  for (const part of content) {
    const partObject = asObject(part);
    if (partObject == null) {
      continue;
    }

    if (readString(partObject, "type") !== "text") {
      return content;
    }

    const text = readString(partObject, "text");
    if (text == null) {
      return content;
    }

    textParts.push(text);
  }

  return textParts.join("\n");
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

function createAbortController(signal: AbortSignal | undefined): {
  abortController: AbortController | undefined;
  cleanup: () => void;
} {
  if (signal == null) {
    return {
      abortController: undefined,
      cleanup: () => {},
    };
  }

  const abortController = new AbortController();

  const onAbort = (): void => {
    abortController.abort(signal.reason);
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    abortController,
    cleanup: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function safeCloseQuery(run: Query): void {
  try {
    run.close();
  } catch {
    // ignore close errors during cleanup
  }
}

function formatResultError(result: Exclude<SDKResultMessage, { subtype: "success" }>): string {
  const errorDetails = result.errors.filter((error) => error.trim().length > 0).join("; ");
  if (errorDetails.length > 0) {
    return `claude-agent-sdk query failed (${result.subtype}): ${errorDetails}`;
  }

  return `claude-agent-sdk query failed (${result.subtype}).`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const candidate = readUnknown(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function readBoolean(
  value: Record<string, unknown> | null | undefined,
  key: string,
): boolean | undefined {
  const candidate = readUnknown(value, key);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function readUnknown(value: Record<string, unknown> | null | undefined, key: string): unknown {
  if (value == null) {
    return undefined;
  }

  return value[key];
}

function readObjectRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const candidate = value[key];
  return asObject(candidate);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown stream error");
}

function resolveJsonOutputSchema(
  responseFormat: LanguageModelV3CallOptions["responseFormat"],
): unknown | undefined {
  if (responseFormat?.type !== "json") {
    return undefined;
  }

  const { schema } = responseFormat;
  if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const resolvedSchema = { ...schema } as Record<string, unknown>;
  if (responseFormat.name != null && resolvedSchema.title == null) {
    resolvedSchema.title = responseFormat.name;
  }
  if (responseFormat.description != null && resolvedSchema.description == null) {
    resolvedSchema.description = responseFormat.description;
  }

  return resolvedSchema;
}
