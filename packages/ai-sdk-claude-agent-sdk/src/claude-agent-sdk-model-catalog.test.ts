import { describe, expect, it, vi, beforeEach } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

import { listClaudeAgentSdkModels } from "./claude-agent-sdk-model-catalog";

describe("listClaudeAgentSdkModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches supported models from claude-agent-sdk query controls", async () => {
    const close = vi.fn();
    const supportedModels = vi.fn().mockResolvedValue([
      {
        value: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        description: "Fast and efficient",
      },
      {
        value: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        description: "Balanced",
      },
    ]);

    sdkMocks.query.mockReturnValue({
      close,
      supportedModels,
    });

    const models = await listClaudeAgentSdkModels({
      apiKey: "sk-ant-test",
      baseURL: "https://anthropic.example.test",
      queryOptions: {
        cwd: "/repo",
      },
    });

    expect(models).toHaveLength(2);
    expect(models[0]?.value).toBe("claude-haiku-4-5");

    expect(sdkMocks.query).toHaveBeenCalledWith({
      prompt: expect.any(Object),
      options: expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-ant-test",
          ANTHROPIC_BASE_URL: "https://anthropic.example.test",
        }),
      }),
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prefers baseURL over deprecated baseUrl when both are provided", async () => {
    const close = vi.fn();
    const supportedModels = vi.fn().mockResolvedValue([
      {
        value: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        description: "Balanced",
      },
    ]);

    sdkMocks.query.mockReturnValue({
      close,
      supportedModels,
    });

    await listClaudeAgentSdkModels({
      baseURL: "https://anthropic.canonical.example.test",
      baseUrl: "https://anthropic.deprecated.example.test",
    });

    expect(sdkMocks.query).toHaveBeenCalledWith({
      prompt: expect.any(Object),
      options: expect.objectContaining({
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: "https://anthropic.canonical.example.test",
        }),
      }),
    });

    expect(close).toHaveBeenCalledTimes(1);
  });
});
