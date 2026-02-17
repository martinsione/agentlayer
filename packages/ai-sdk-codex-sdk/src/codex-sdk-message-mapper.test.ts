import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { mapPromptToCodexInput } from "./codex-sdk-message-mapper";

describe("mapPromptToCodexInput", () => {
  it("maps mixed prompt roles to Codex text/image input preserving order", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "Follow repo rules." },
      {
        role: "user",
        content: [
          { type: "text", text: "Review this screenshot." },
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
          { type: "reasoning", text: "Need to inspect image first." },
          { type: "text", text: "Working on it." },
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
            output: { type: "text", value: "found 2 lines" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_2",
            toolName: "unit-tests",
            output: { type: "json", value: { passed: true } },
          },
        ],
      },
    ];

    const result = mapPromptToCodexInput(prompt);

    expect(result.warnings).toEqual([]);
    expect(result.input).toEqual([
      { type: "text", text: "[system]\nFollow repo rules." },
      { type: "text", text: "[user]\nReview this screenshot." },
      { type: "local_image", path: "/tmp/mock.png" },
      { type: "text", text: "[assistant:reasoning]\nNeed to inspect image first." },
      { type: "text", text: "[assistant]\nWorking on it." },
      {
        type: "text",
        text: '[assistant:tool-call] grep call_1\n{"pattern":"TODO"}',
      },
      {
        type: "text",
        text: '[assistant:tool-result] grep call_1\n{"type":"text","value":"found 2 lines"}',
      },
      {
        type: "text",
        text: '[tool:result] unit-tests call_2\n{"type":"json","value":{"passed":true}}',
      },
    ]);
  });

  it("returns plain string when prompt has no image content", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "Always be concise." },
      {
        role: "user",
        content: [{ type: "text", text: "Say hello." }],
      },
    ];

    const result = mapPromptToCodexInput(prompt);

    expect(result.input).toBe("[system]\nAlways be concise.\n\n[user]\nSay hello.");
    expect(result.warnings).toEqual([]);
  });

  it("warns for unsupported non-file URL and inline binary file parts", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: new URL("https://example.com/screenshot.png"),
          },
          {
            type: "file",
            mediaType: "image/png",
            data: "i-am-base64-not-a-path",
          },
          {
            type: "file",
            mediaType: "application/pdf",
            data: new URL("file:///tmp/doc.pdf"),
          },
        ],
      },
    ];

    const result = mapPromptToCodexInput(prompt);

    expect(result.input).toBe(
      "[user]\n[unsupported-file:1]\n[unsupported-file:2]\n[unsupported-file:3]",
    );
    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "file-url",
        details: "Only file:// image URLs are supported by codex-sdk prompt mapping.",
      },
      {
        type: "unsupported",
        feature: "file-inline-data",
        details: "Inline file data is not supported by codex-sdk prompt mapping.",
      },
      {
        type: "unsupported",
        feature: "file-media-type",
        details: "Only image/* file media types are supported by codex-sdk prompt mapping.",
      },
    ]);
  });
});
