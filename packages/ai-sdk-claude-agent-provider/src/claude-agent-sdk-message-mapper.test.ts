import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { mapPromptToClaudeAgentPrompt } from "./claude-agent-sdk-message-mapper";

describe("mapPromptToClaudeAgentPrompt", () => {
  it("maps mixed prompt roles into a single claude-agent prompt string", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "Follow repo rules." },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          {
            type: "file",
            mediaType: "image/png",
            data: new URL("file:///tmp/mock.png"),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Looking at repository state." },
          { type: "text", text: "I found the issue." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "grep",
            input: { pattern: "TODO" },
          },
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "grep",
            output: { type: "text", value: "found" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_2",
            toolName: "tests",
            output: { type: "json", value: { passed: true } },
          },
        ],
      },
    ];

    const result = mapPromptToClaudeAgentPrompt(prompt);

    expect(result.warnings).toEqual([]);
    expect(result.prompt).toBe(
      [
        "[system]",
        "Follow repo rules.",
        "",
        "[user]",
        "Inspect this image.",
        "[file:image/png] /tmp/mock.png",
        "",
        "[assistant:reasoning]",
        "Looking at repository state.",
        "",
        "[assistant]",
        "I found the issue.",
        "",
        '[assistant:tool-call] grep call_1\n{"pattern":"TODO"}',
        "",
        '[assistant:tool-result] grep call_1\n{"type":"text","value":"found"}',
        "",
        '[tool:result] tests call_2\n{"type":"json","value":{"passed":true}}',
      ].join("\n"),
    );
  });

  it("warns for unsupported file URLs and inline file data", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: new URL("https://example.com/image.png"),
          },
          {
            type: "file",
            mediaType: "image/png",
            data: "inline-base64-data",
          },
        ],
      },
    ];

    const result = mapPromptToClaudeAgentPrompt(prompt);

    expect(result.prompt).toBe("[user]\n[unsupported-file:1]\n[unsupported-file:2]");
    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "file-url",
        details:
          "Only file:// URLs or local paths are supported by claude-agent-sdk prompt mapping.",
      },
      {
        type: "unsupported",
        feature: "file-inline-data",
        details: "Inline file data is not supported by claude-agent-sdk prompt mapping.",
      },
    ]);
  });
});
