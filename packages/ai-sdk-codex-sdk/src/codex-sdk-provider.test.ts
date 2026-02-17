import { NoSuchModelError, type LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, expectTypeOf, it, vi, beforeEach } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}));

vi.mock("@openai/codex-sdk", () => {
  class MockCodex {
    constructor(options: unknown) {
      sdkMocks.ctor(options);
    }

    startThread = sdkMocks.startThread;
    resumeThread = sdkMocks.resumeThread;
  }

  return {
    Codex: MockCodex,
  };
});

import { createCodexSdk } from "./codex-sdk-provider";

function callOptions(
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello from test" }] }],
    ...overrides,
  } as LanguageModelV3CallOptions;
}

function createAsyncEvents(events: unknown[]): AsyncGenerator<any> {
  return (async function* gen() {
    for (const event of events) {
      yield event;
    }
  })();
}

async function collectStream(stream: ReadableStream<any>): Promise<any[]> {
  const parts: any[] = [];
  for await (const part of stream as any) {
    parts.push(part);
  }
  return parts;
}

describe("createCodexSdk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a V3 provider and language model callable interface", () => {
    const provider = createCodexSdk();

    const modelFromFunction = provider("gpt-5");
    const modelFromMethod = provider.languageModel("gpt-5");

    expect(provider.specificationVersion).toBe("v3");
    expect(modelFromFunction.specificationVersion).toBe("v3");
    expect(modelFromMethod.specificationVersion).toBe("v3");
    expect(modelFromFunction.provider).toBe("codex-sdk");
    expect(modelFromFunction.modelId).toBe("gpt-5");
  });

  it("throws NoSuchModelError for unsupported model kinds", () => {
    const provider = createCodexSdk();

    expect(() => provider.embeddingModel("text-embedding-3-large")).toThrow(NoSuchModelError);
    expect(() => provider.imageModel("gpt-image-1")).toThrow(NoSuchModelError);
  });

  it("supports canonical provider option aliases `name` and `baseURL`", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "Hello from alias config" }],
      finalResponse: "Hello from alias config",
      usage: null,
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-alias-1",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk({
      name: "codex-custom",
      baseURL: "https://codex.alias.example.test",
    });

    const model = provider("gpt-5");
    const result = await model.doGenerate(callOptions());

    expect(sdkMocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://codex.alias.example.test",
      }),
    );

    expect(result.providerMetadata).toEqual({
      "codex-custom": {
        threadId: "thread-alias-1",
      },
    });
  });

  it("forwards additional codex options to the Codex constructor", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "ok" }],
      finalResponse: "ok",
      usage: null,
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-extra-opts-1",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk({
      name: "codex-custom",
      apiKey: "key-123",
      baseURL: "https://codex.alias.example.test",
      threadOptions: {
        approvalPolicy: "never",
      },
      // Runtime pass-through for fields that may exist in newer SDK versions.
      experimentalFlagFromFutureSdk: true,
    } as any);

    const model = provider("gpt-5");
    await model.doGenerate(callOptions());

    expect(sdkMocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "key-123",
        baseUrl: "https://codex.alias.example.test",
        experimentalFlagFromFutureSdk: true,
      }),
    );

    const ctorArgs = sdkMocks.ctor.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctorArgs.name).toBeUndefined();
    expect(ctorArgs.provider).toBeUndefined();
    expect(ctorArgs.threadOptions).toBeUndefined();
  });

  it("uses startThread and maps generate result, usage, metadata, and warnings", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "Hello world" }],
      finalResponse: "Hello world",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 2,
        output_tokens: 5,
      },
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-new-1",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk({
      apiKey: "key-123",
      baseUrl: "https://api.example.test",
      threadOptions: {
        workingDirectory: "/repo/default",
        sandboxMode: "workspace-write",
      },
    });

    const model = provider("gpt-5", {
      approvalPolicy: "never",
    });

    const abortController = new AbortController();

    const result = await model.doGenerate(
      callOptions({
        responseFormat: {
          type: "json",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
        abortSignal: abortController.signal,
        tools: [
          {
            type: "function",
            name: "my-tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        toolChoice: { type: "tool", toolName: "my-tool" },
      }),
    );

    expect(sdkMocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "key-123",
        baseUrl: "https://api.example.test",
      }),
    );

    expect(sdkMocks.startThread).toHaveBeenCalledWith({
      workingDirectory: "/repo/default",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      model: "gpt-5",
    });

    expect(run).toHaveBeenCalledWith("[user]\nHello from test", {
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      signal: abortController.signal,
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined });
    expect(result.providerMetadata).toEqual({
      "codex-sdk": {
        threadId: "thread-new-1",
      },
    });

    expect(result.usage).toEqual({
      inputTokens: {
        total: 12,
        noCache: 10,
        cacheRead: 2,
        cacheWrite: 0,
      },
      outputTokens: {
        total: 5,
        text: undefined,
        reasoning: undefined,
      },
      raw: {
        input_tokens: 12,
        cached_input_tokens: 2,
        output_tokens: 5,
      },
    });

    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "tools",
        details: "codex-sdk provider ignores AI SDK tools and toolChoice options.",
      },
    ]);
  });

  it("uses resumeThread when threadId is passed through providerOptions", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "Done" }],
      finalResponse: "Done",
      usage: null,
    });

    sdkMocks.resumeThread.mockReturnValue({
      id: "thread-existing-1",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk({
      threadOptions: {
        sandboxMode: "workspace-write",
      },
    });

    const model = provider("gpt-5", {
      workingDirectory: "/repo/model",
    });

    await model.doGenerate(
      callOptions({
        providerOptions: {
          "codex-sdk": {
            threadId: "thread-existing-1",
            workingDirectory: "/repo/call",
          },
        },
      }),
    );

    expect(sdkMocks.startThread).not.toHaveBeenCalled();
    expect(sdkMocks.resumeThread).toHaveBeenCalledWith("thread-existing-1", {
      sandboxMode: "workspace-write",
      workingDirectory: "/repo/call",
      model: "gpt-5",
    });
  });

  it("falls back to last assistant item when finalResponse is empty", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [
        { id: "r1", type: "reasoning", text: "thinking..." },
        { id: "a1", type: "agent_message", text: "fallback text" },
      ],
      finalResponse: "",
      usage: null,
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-new-2",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "fallback text" }]);
  });

  it("propagates codex execution failures from run()", async () => {
    const run = vi.fn().mockRejectedValue(new Error("codex failed"));

    sdkMocks.startThread.mockReturnValue({
      id: "thread-new-3",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    await expect(model.doGenerate(callOptions())).rejects.toThrow("codex failed");
  });

  it("streams reasoning/tool/text parts and finish metadata", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-1" },
        {
          type: "item.completed",
          item: { id: "reason_1", type: "reasoning", text: "Looking at files..." },
        },
        {
          type: "item.started",
          item: {
            id: "cmd_1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd_1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "README.md\n",
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: { id: "msg_1", type: "agent_message", text: "All done." },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 9, cached_input_tokens: 1, output_tokens: 4 },
        },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-1",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts).toContainEqual({
      type: "response-metadata",
      id: "thread-stream-1",
      modelId: "gpt-5",
    });

    expect(parts).toContainEqual({ type: "reasoning-start", id: "reason_1" });
    expect(parts).toContainEqual({
      type: "reasoning-delta",
      id: "reason_1",
      delta: "Looking at files...",
    });
    expect(parts).toContainEqual({ type: "reasoning-end", id: "reason_1" });

    const toolCall = parts.find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "exec",
      providerExecuted: true,
      dynamic: true,
      input: '{"command":"ls -la"}',
    });

    expect(parts).toContainEqual({
      type: "tool-result",
      toolCallId: toolCall.toolCallId,
      toolName: "exec",
      dynamic: true,
      result: {
        command: "ls -la",
        aggregatedOutput: "README.md\n",
        exitCode: 0,
        status: "completed",
      },
    });

    expect(parts).toContainEqual({ type: "text-start", id: "msg_1" });
    expect(parts).toContainEqual({ type: "text-delta", id: "msg_1", delta: "All done." });
    expect(parts).toContainEqual({ type: "text-end", id: "msg_1" });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
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
          cached_input_tokens: 1,
          output_tokens: 4,
        },
      },
      providerMetadata: {
        "codex-sdk": {
          threadId: "thread-stream-1",
        },
      },
    });
  });

  it("streams error part and error finish reason on stream-level error event", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-2" },
        { type: "error", message: "stream exploded" },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-2",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts).toContainEqual({
      type: "error",
      error: new Error("stream exploded"),
    });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: { unified: "error", raw: "stream-error" },
      usage: {
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
      },
      providerMetadata: {
        "codex-sdk": {
          threadId: "thread-stream-2",
        },
      },
    });
  });

  it("emits raw stream chunks when includeRawChunks is enabled", async () => {
    const startedEvent = { type: "thread.started", thread_id: "thread-stream-raw-1" } as const;
    const completedEvent = {
      type: "turn.completed",
      usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 },
    } as const;

    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([startedEvent, completedEvent]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-raw-1",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(
      callOptions({
        includeRawChunks: true,
      }),
    );
    const parts = await collectStream(streamResult.stream);

    const rawParts = parts.filter((part) => part.type === "raw");
    expect(rawParts).toEqual([
      { type: "raw", rawValue: startedEvent },
      { type: "raw", rawValue: completedEvent },
    ]);
  });

  it("streams turn-failed as error part and error finish reason", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-failed" },
        { type: "turn.failed", error: { message: "permission denied" } },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-failed",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts).toContainEqual({
      type: "error",
      error: new Error("permission denied"),
    });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: { unified: "error", raw: "turn-failed" },
      usage: {
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
      },
      providerMetadata: {
        "codex-sdk": {
          threadId: "thread-stream-failed",
        },
      },
    });
  });

  it("ignores non-fatal item error events and still completes stream", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-item-error" },
        {
          type: "item.completed",
          item: {
            id: "err_1",
            type: "error",
            message: "Under-development features enabled: apply_patch_freeform",
          },
        },
        {
          type: "item.completed",
          item: { id: "msg_1", type: "agent_message", text: "done" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-item-error",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(parts).toContainEqual({ type: "text-start", id: "msg_1" });
    expect(parts).toContainEqual({ type: "text-delta", id: "msg_1", delta: "done" });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toEqual({
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 1,
          text: undefined,
          reasoning: undefined,
        },
        raw: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
      },
      providerMetadata: {
        "codex-sdk": {
          threadId: "thread-stream-item-error",
        },
      },
    });
  });

  it("stream-start warnings include unsupported tools and toolChoice", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-3" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
        },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-3",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(
      callOptions({
        tools: [
          {
            type: "function",
            name: "x",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        toolChoice: { type: "tool", toolName: "x" },
      }),
    );

    const parts = await collectStream(streamResult.stream);

    expect(parts[0]).toEqual({
      type: "stream-start",
      warnings: [
        {
          type: "unsupported",
          feature: "tools",
          details: "codex-sdk provider ignores AI SDK tools and toolChoice options.",
        },
      ],
    });
  });

  it("collects warnings for unsupported call options", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "ok" }],
      finalResponse: "ok",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-warn-1",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const result = await model.doGenerate(
      callOptions({
        temperature: 0.1,
        topP: 0.9,
        topK: 20,
        maxOutputTokens: 12,
        stopSequences: ["END"],
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 42,
        headers: { "x-test": "1" },
        includeRawChunks: true,
        responseFormat: {
          type: "json",
          schema: { type: "object", properties: {} },
          name: "my-shape",
          description: "shape",
        },
      }),
    );

    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "headers",
        details:
          "codex-sdk provider does not support per-call HTTP headers in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "temperature",
        details: "codex-sdk provider ignores temperature in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "topP",
        details: "codex-sdk provider ignores topP in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "topK",
        details: "codex-sdk provider ignores topK in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "maxOutputTokens",
        details: "codex-sdk provider ignores maxOutputTokens in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "stopSequences",
        details: "codex-sdk provider ignores stopSequences in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "presencePenalty",
        details: "codex-sdk provider ignores presencePenalty in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "frequencyPenalty",
        details: "codex-sdk provider ignores frequencyPenalty in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "seed",
        details: "codex-sdk provider ignores seed in AI SDK call options.",
      },
      {
        type: "unsupported",
        feature: "responseFormat.name/description",
        details: "codex-sdk provider only forwards responseFormat.schema as Codex outputSchema.",
      },
    ]);
  });

  it("warns when modelReasoningEffort is not listed for the selected model", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "ok" }],
      finalResponse: "ok",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-warn-effort-1",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5-codex-mini", {
      modelReasoningEffort: "minimal",
    });

    const result = await model.doGenerate(callOptions());

    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "modelReasoningEffort",
        details:
          'modelReasoningEffort "minimal" is not listed as supported for gpt-5-codex-mini. Supported values: medium, high.',
      },
    ]);
  });

  it("does not warn when modelReasoningEffort is listed for the selected model", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "ok" }],
      finalResponse: "ok",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-warn-effort-2",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5.3-codex", {
      modelReasoningEffort: "xhigh",
    });

    const result = await model.doGenerate(callOptions());

    expect(result.warnings).toEqual([]);
  });

  it("does not warn for empty headers object", async () => {
    const run = vi.fn().mockResolvedValue({
      items: [{ id: "a1", type: "agent_message", text: "ok" }],
      finalResponse: "ok",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-warn-2",
      run,
      runStreamed: vi.fn(),
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const result = await model.doGenerate(
      callOptions({
        headers: {},
      }),
    );

    expect(result.warnings).toEqual([]);
  });

  it("handles item.updated deltas for reasoning and agent message", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-delta" },
        {
          type: "item.updated",
          item: { id: "reason_1", type: "reasoning", text: "Thinking" },
        },
        {
          type: "item.updated",
          item: { id: "reason_1", type: "reasoning", text: "Thinking more" },
        },
        {
          type: "item.completed",
          item: { id: "reason_1", type: "reasoning", text: "Thinking more deeply" },
        },
        {
          type: "item.updated",
          item: { id: "msg_1", type: "agent_message", text: "Hello" },
        },
        {
          type: "item.updated",
          item: { id: "msg_1", type: "agent_message", text: "Hello world" },
        },
        {
          type: "item.completed",
          item: { id: "msg_1", type: "agent_message", text: "Hello world!" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-delta",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts).toContainEqual({ type: "reasoning-start", id: "reason_1" });
    expect(parts).toContainEqual({ type: "reasoning-delta", id: "reason_1", delta: "Thinking" });
    expect(parts).toContainEqual({ type: "reasoning-delta", id: "reason_1", delta: " more" });
    expect(parts).toContainEqual({ type: "reasoning-delta", id: "reason_1", delta: " deeply" });
    expect(parts).toContainEqual({ type: "reasoning-end", id: "reason_1" });

    expect(parts).toContainEqual({ type: "text-start", id: "msg_1" });
    expect(parts).toContainEqual({ type: "text-delta", id: "msg_1", delta: "Hello" });
    expect(parts).toContainEqual({ type: "text-delta", id: "msg_1", delta: " world" });
    expect(parts).toContainEqual({ type: "text-delta", id: "msg_1", delta: "!" });
    expect(parts).toContainEqual({ type: "text-end", id: "msg_1" });
  });

  it("ignores unhandled codex item kinds and still completes", async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: createAsyncEvents([
        { type: "thread.started", thread_id: "thread-stream-unhandled-items" },
        {
          type: "item.updated",
          item: {
            id: "todo_1",
            type: "todo_list",
            items: [{ text: "plan", completed: false }],
          },
        },
        {
          type: "item.completed",
          item: {
            id: "web_1",
            type: "web_search",
            query: "agentlayer repo",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "file_1",
            type: "file_change",
            status: "completed",
            changes: [{ path: "README.md", kind: "update" }],
          },
        },
        {
          type: "item.completed",
          item: { id: "msg_1", type: "agent_message", text: "done" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ]),
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-unhandled-items",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(parts).toContainEqual({ type: "text-start", id: "msg_1" });
    expect(parts).toContainEqual({ type: "text-delta", id: "msg_1", delta: "done" });
    expect(parts).toContainEqual({ type: "text-end", id: "msg_1" });
    expect(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("converts unexpected stream crashes to error parts", async () => {
    const streamCrash = new Error("stream iterator crashed");
    const runStreamed = vi.fn().mockResolvedValue({
      events: {
        async *[Symbol.asyncIterator]() {
          throw streamCrash;
        },
      },
    });

    sdkMocks.startThread.mockReturnValue({
      id: "thread-stream-crash",
      run: vi.fn(),
      runStreamed,
    });

    const provider = createCodexSdk();
    const model = provider("gpt-5");

    const streamResult = await model.doStream(callOptions());
    const parts = await collectStream(streamResult.stream);

    expect(parts).toContainEqual({ type: "error", error: streamCrash });
    expect(parts).toContainEqual({
      type: "finish",
      finishReason: { unified: "error", raw: "stream-crashed" },
      usage: {
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
      },
      providerMetadata: {
        "codex-sdk": {
          threadId: "thread-stream-crash",
        },
      },
    });
  });

  it("supports strongly typed model ids through provider generics", () => {
    const provider = createCodexSdk<"gpt-5.2-codex" | "my-custom-model">();

    provider("gpt-5.2-codex");
    provider.languageModel("my-custom-model");
    // @ts-expect-error -- model ids are constrained by the createCodexSdk generic.
    provider("not-in-union");

    expectTypeOf(provider).toBeFunction();
  });
});
