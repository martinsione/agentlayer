import { NoSuchModelError, type LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

import { createClaudeAgentSdk } from "./claude-agent-sdk-provider";

function callOptions(
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello from test" }] }],
    ...overrides,
  } as LanguageModelV3CallOptions;
}

function createMockQuery(messages: unknown[]) {
  let closed = false;

  const iterator = (async function* () {
    for (const message of messages) {
      if (closed) {
        return;
      }
      yield message;
    }
  })() as any;

  iterator.close = vi.fn(() => {
    closed = true;
  });

  return iterator;
}

function createSuccessfulResultQuery() {
  return createMockQuery([
    {
      type: "result",
      subtype: "success",
      session_id: "session-success-1",
      uuid: "result-success-1",
      is_error: false,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      permission_denials: [],
      modelUsage: {},
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  ]);
}

async function collectStream(stream: ReadableStream<any>): Promise<any[]> {
  const parts: any[] = [];
  for await (const part of stream as any) {
    parts.push(part);
  }
  return parts;
}

describe("createClaudeAgentSdk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a V3 provider and language model callable interface", () => {
    const provider = createClaudeAgentSdk();

    const modelFromFunction = provider("claude-sonnet-4-6");
    const modelFromMethod = provider.languageModel("claude-sonnet-4-6");

    expect(provider.specificationVersion).toBe("v3");
    expect(modelFromFunction.specificationVersion).toBe("v3");
    expect(modelFromMethod.specificationVersion).toBe("v3");
    expect(modelFromFunction.provider).toBe("claude-agent-sdk");
    expect(modelFromFunction.modelId).toBe("claude-sonnet-4-6");
  });

  it("supports generic model ids for stronger typing", () => {
    type ModelIds = "claude-sonnet-4-6" | "claude-opus-4-6";

    const provider = createClaudeAgentSdk<ModelIds>();
    const model = provider("claude-opus-4-6");

    expectTypeOf(model.modelId).toEqualTypeOf<string>();
  });

  it("throws NoSuchModelError for unsupported model kinds", () => {
    const provider = createClaudeAgentSdk();

    expect(() => provider.embeddingModel("text-embedding")).toThrow(NoSuchModelError);
    expect(() => provider.textEmbeddingModel("text-embedding")).toThrow(NoSuchModelError);
    expect(() => provider.imageModel("image-model")).toThrow(NoSuchModelError);
  });

  it("supports canonical providerOptions key when provider uses a custom name", async () => {
    sdkMocks.query.mockReturnValue(createSuccessfulResultQuery());

    const provider = createClaudeAgentSdk({
      name: "claude-custom",
      queryOptions: {
        cwd: "/repo/default",
      },
    });

    const model = provider("default");

    await model.doGenerate(
      callOptions({
        providerOptions: {
          "claude-agent-sdk": {
            cwd: "/repo/canonical",
          },
        },
      }),
    );

    expect(sdkMocks.query).toHaveBeenCalledWith({
      prompt: "[user]\nHello from test",
      options: expect.objectContaining({
        model: "default",
        cwd: "/repo/canonical",
      }),
    });
  });

  it("merges canonical and custom providerOptions with custom taking precedence", async () => {
    sdkMocks.query.mockReturnValue(createSuccessfulResultQuery());

    const provider = createClaudeAgentSdk({
      name: "claude-custom",
      queryOptions: {
        cwd: "/repo/default",
      },
    });

    const model = provider("default");

    await model.doGenerate(
      callOptions({
        providerOptions: {
          "claude-agent-sdk": {
            cwd: "/repo/canonical",
            permissionMode: "default",
          },
          "claude-custom": {
            cwd: "/repo/custom",
          },
        },
      }),
    );

    expect(sdkMocks.query).toHaveBeenCalledWith({
      prompt: "[user]\nHello from test",
      options: expect.objectContaining({
        model: "default",
        cwd: "/repo/custom",
        permissionMode: "default",
      }),
    });
  });

  it("prefers baseURL over deprecated baseUrl when both are provided", async () => {
    sdkMocks.query.mockReturnValue(createSuccessfulResultQuery());

    const provider = createClaudeAgentSdk({
      baseURL: "https://anthropic.canonical.example.test",
      baseUrl: "https://anthropic.deprecated.example.test",
    });
    const model = provider("default");

    await model.doGenerate(callOptions());

    expect(sdkMocks.query).toHaveBeenCalledWith({
      prompt: "[user]\nHello from test",
      options: expect.objectContaining({
        model: "default",
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: "https://anthropic.canonical.example.test",
        }),
      }),
    });
  });

  it("maps doGenerate result, warnings, and provider metadata", async () => {
    const modelUsage = {
      "claude-opus-4-6": {
        inputTokens: 12,
        outputTokens: 5,
      },
    };

    sdkMocks.query.mockReturnValue(
      createMockQuery([
        {
          type: "system",
          subtype: "init",
          session_id: "session-generate-1",
          uuid: "system-generate-1",
          model: "claude-opus-4-6",
        },
        {
          type: "assistant",
          session_id: "session-generate-1",
          uuid: "assistant-1",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: "Hello from assistant" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-generate-1",
          uuid: "result-1",
          is_error: false,
          result: "Hello from result",
          stop_reason: "end_turn",
          total_cost_usd: 0.01,
          num_turns: 2,
          duration_ms: 10,
          duration_api_ms: 8,
          permission_denials: [],
          modelUsage,
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      ]),
    );

    const provider = createClaudeAgentSdk({
      name: "claude-custom",
      apiKey: "sk-ant-test",
      baseURL: "https://anthropic.example.test",
      queryOptions: {
        cwd: "/repo/default",
      },
    });

    const model = provider("default");

    const result = await model.doGenerate(
      callOptions({
        tools: [
          {
            type: "function",
            name: "my-tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: {
              result: { type: "string" },
            },
          },
          name: "result-shape",
          description: "Result schema",
        },
      }),
    );

    expect(sdkMocks.query).toHaveBeenCalledWith({
      prompt: "[user]\nHello from test",
      options: expect.objectContaining({
        model: "default",
        cwd: "/repo/default",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              result: { type: "string" },
            },
            title: "result-shape",
            description: "Result schema",
          },
        },
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-ant-test",
          ANTHROPIC_BASE_URL: "https://anthropic.example.test",
        }),
      }),
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello from result" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "tools",
        details:
          "claude-agent-sdk provider ignores AI SDK tools and toolChoice options in favor of agent-native tooling.",
      },
    ]);
    expect(result.providerMetadata).toEqual({
      "claude-custom": {
        requestedModelId: "default",
        resolvedModelId: "claude-opus-4-6",
        resolvedModelIds: ["claude-opus-4-6"],
        sessionId: "session-generate-1",
        stopReason: "end_turn",
        numTurns: 2,
        totalCostUsd: 0.01,
        modelUsage,
      },
    });
  });

  it("streams text, reasoning, tool events, and finish usage", async () => {
    sdkMocks.query.mockReturnValue(
      createMockQuery([
        {
          type: "system",
          subtype: "init",
          session_id: "session-stream-1",
          uuid: "system-1",
          model: "claude-sonnet-4-6",
        },
        {
          type: "assistant",
          session_id: "session-stream-1",
          uuid: "assistant-stream-1",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "thinking", thinking: "Scanning repository" },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
              { type: "text", text: "Done." },
            ],
          },
        },
        {
          type: "user",
          session_id: "session-stream-1",
          uuid: "user-stream-1",
          parent_tool_use_id: "toolu_1",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md\n" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-stream-1",
          uuid: "result-stream-1",
          is_error: false,
          result: "Done.",
          stop_reason: "end_turn",
          total_cost_usd: 0.02,
          num_turns: 3,
          duration_ms: 15,
          duration_api_ms: 10,
          permission_denials: [],
          modelUsage: {
            "claude-sonnet-4-6": {
              inputTokens: 9,
              outputTokens: 4,
            },
          },
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
        },
      ]),
    );

    const provider = createClaudeAgentSdk();
    const model = provider("default");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts).toContainEqual({
      type: "response-metadata",
      id: "session-stream-1",
      modelId: "claude-sonnet-4-6",
    });

    expect(parts).toContainEqual({
      type: "reasoning-delta",
      id: "assistant-stream-1:thinking:0",
      delta: "Scanning repository",
    });

    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "toolu_1",
      toolName: "Bash",
      input: '{"command":"ls -la"}',
      providerExecuted: true,
      dynamic: true,
    });

    expect(parts).toContainEqual({
      type: "tool-result",
      toolCallId: "toolu_1",
      toolName: "Bash",
      dynamic: true,
      result: "README.md\n",
    });

    expect(parts).toContainEqual({
      type: "text-delta",
      id: "assistant-stream-1:text:2",
      delta: "Done.",
    });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: {
          total: 9,
          noCache: 8,
          cacheRead: 1,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 4,
          text: undefined,
          reasoning: undefined,
        },
        raw: {
          input_tokens: 9,
          output_tokens: 4,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 0,
        },
      },
      providerMetadata: {
        "claude-agent-sdk": {
          requestedModelId: "default",
          resolvedModelId: "claude-sonnet-4-6",
          resolvedModelIds: ["claude-sonnet-4-6"],
          sessionId: "session-stream-1",
          stopReason: "end_turn",
          numTurns: 3,
          totalCostUsd: 0.02,
          modelUsage: {
            "claude-sonnet-4-6": {
              inputTokens: 9,
              outputTokens: 4,
            },
          },
        },
      },
    });
  });

  it("does not emit duplicate tool results when both tool_result block and tool_use_result are present", async () => {
    sdkMocks.query.mockReturnValue(
      createMockQuery([
        {
          type: "assistant",
          session_id: "session-stream-dedup-1",
          uuid: "assistant-dedup-1",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          session_id: "session-stream-dedup-1",
          uuid: "user-dedup-1",
          parent_tool_use_id: "toolu_1",
          tool_use_result: "from-tool_use_result",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "from-content" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-stream-dedup-1",
          uuid: "result-dedup-1",
          is_error: false,
          result: "done",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
          permission_denials: [],
          modelUsage: {},
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      ]),
    );

    const provider = createClaudeAgentSdk();
    const model = provider("default");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    const toolResults = parts.filter((part) => part.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toEqual({
      type: "tool-result",
      toolCallId: "toolu_1",
      toolName: "Bash",
      dynamic: true,
      result: "from-content",
    });
  });

  it("emits raw stream chunks when includeRawChunks is enabled", async () => {
    const messages = [
      {
        type: "assistant",
        session_id: "session-stream-raw-1",
        uuid: "assistant-raw-1",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "text", text: "raw hello" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "session-stream-raw-1",
        uuid: "result-raw-1",
        is_error: false,
        result: "raw hello",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        num_turns: 1,
        duration_ms: 5,
        duration_api_ms: 5,
        permission_denials: [],
        modelUsage: {},
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ] as const;

    sdkMocks.query.mockReturnValue(createMockQuery([...messages]));

    const provider = createClaudeAgentSdk();
    const model = provider("default");

    const streamResult = await model.doStream(
      callOptions({
        includeRawChunks: true,
      }),
    );
    const parts = await collectStream(streamResult.stream);

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });

    const rawParts = parts.filter((part) => part.type === "raw");
    expect(rawParts).toEqual([
      { type: "raw", rawValue: messages[0] },
      { type: "raw", rawValue: messages[1] },
    ]);
  });

  it("does not warn for includeRawChunks or responseFormat name/description", async () => {
    sdkMocks.query.mockReturnValue(
      createMockQuery([
        {
          type: "result",
          subtype: "success",
          session_id: "session-generate-warnings-1",
          uuid: "result-generate-warnings-1",
          is_error: false,
          result: "ok",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 5,
          duration_api_ms: 5,
          permission_denials: [],
          modelUsage: {},
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      ]),
    );

    const provider = createClaudeAgentSdk();
    const model = provider("default");

    const result = await model.doGenerate(
      callOptions({
        includeRawChunks: true,
        responseFormat: {
          type: "json",
          schema: { type: "object", properties: {} },
          name: "shape",
          description: "shape description",
        },
      }),
    );

    expect(result.warnings).toEqual([]);
  });

  it("emits an error and error finish reason for failed result subtype", async () => {
    sdkMocks.query.mockReturnValue(
      createMockQuery([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "session-stream-2",
          uuid: "result-stream-2",
          is_error: true,
          stop_reason: null,
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 5,
          duration_api_ms: 5,
          permission_denials: [],
          modelUsage: {},
          errors: ["permission denied"],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      ]),
    );

    const provider = createClaudeAgentSdk();
    const model = provider("default");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts).toContainEqual({
      type: "error",
      error: new Error("claude-agent-sdk query failed (error_during_execution): permission denied"),
    });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: { unified: "error", raw: "error_during_execution" },
      usage: {
        inputTokens: {
          total: 0,
          noCache: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 0,
          text: undefined,
          reasoning: undefined,
        },
        raw: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      providerMetadata: {
        "claude-agent-sdk": {
          requestedModelId: "default",
          sessionId: "session-stream-2",
          stopReason: null,
          numTurns: 1,
          totalCostUsd: 0,
          modelUsage: {},
        },
      },
    });
  });
});
