import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  SharedV3Warning,
} from "@ai-sdk/provider";

export type PromptMappingResult = {
  prompt: string;
  warnings: SharedV3Warning[];
};

export function mapPromptToClaudeAgentPrompt(prompt: LanguageModelV3Prompt): PromptMappingResult {
  const warnings: SharedV3Warning[] = [];
  const warningSet = new Set<string>();
  const lines: string[] = [];
  let unsupportedFileIndex = 0;

  const warnOnce = (warning: SharedV3Warning): void => {
    const key = "feature" in warning ? `${warning.type}:${warning.feature}` : warning.type;
    if (warningSet.has(key)) {
      return;
    }

    warningSet.add(key);
    warnings.push(warning);
  };

  const pushLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    lines.push(line);
  };

  const mapFilePart = (part: LanguageModelV3FilePart): string => {
    const localPath = resolveLocalPath(part.data);
    if (localPath != null) {
      return `[file:${part.mediaType}] ${localPath}`;
    }

    if (isUrlLike(part.data)) {
      warnOnce({
        type: "unsupported",
        feature: "file-url",
        details:
          "Only file:// URLs or local paths are supported by claude-agent-sdk prompt mapping.",
      });
    } else {
      warnOnce({
        type: "unsupported",
        feature: "file-inline-data",
        details: "Inline file data is not supported by claude-agent-sdk prompt mapping.",
      });
    }

    unsupportedFileIndex += 1;
    return `[unsupported-file:${unsupportedFileIndex}]`;
  };

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        pushLine(`[system]\n${message.content}`);
        break;
      }

      case "user": {
        const userLines: string[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text.trim()) {
              userLines.push(part.text);
            }
            continue;
          }

          if (part.type === "file") {
            userLines.push(mapFilePart(part));
          }
        }

        if (userLines.length > 0) {
          pushLine(`[user]\n${userLines.join("\n")}`);
        }
        break;
      }

      case "assistant": {
        for (const part of message.content) {
          if (part.type === "text") {
            pushLine(`[assistant]\n${part.text}`);
            continue;
          }

          if (part.type === "reasoning") {
            pushLine(`[assistant:reasoning]\n${part.text}`);
            continue;
          }

          if (part.type === "tool-call") {
            pushLine(
              `[assistant:tool-call] ${part.toolName} ${part.toolCallId}\n${JSON.stringify(part.input)}`,
            );
            continue;
          }

          if (part.type === "tool-result") {
            pushLine(
              `[assistant:tool-result] ${part.toolName} ${part.toolCallId}\n${JSON.stringify(part.output)}`,
            );
            continue;
          }

          if (part.type === "file") {
            pushLine(`[assistant]\n${mapFilePart(part)}`);
          }
        }
        break;
      }

      case "tool": {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            pushLine(
              `[tool:result] ${part.toolName} ${part.toolCallId}\n${JSON.stringify(part.output)}`,
            );
            continue;
          }

          if (part.type === "tool-approval-response") {
            pushLine(
              `[tool:approval] ${part.approvalId}\n${JSON.stringify({ approved: part.approved, reason: part.reason })}`,
            );
          }
        }
        break;
      }
    }
  }

  return {
    prompt: lines.join("\n\n"),
    warnings,
  };
}

function resolveLocalPath(data: unknown): string | null {
  if (data instanceof URL) {
    if (data.protocol !== "file:") {
      return null;
    }

    return decodeURIComponent(data.pathname);
  }

  if (typeof data !== "string") {
    return null;
  }

  if (data.startsWith("file://")) {
    try {
      const parsed = new URL(data);
      if (parsed.protocol === "file:") {
        return decodeURIComponent(parsed.pathname);
      }
    } catch {
      return null;
    }

    return null;
  }

  if (looksLikeLocalPath(data)) {
    return data;
  }

  return null;
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

function isUrlLike(value: unknown): boolean {
  if (value instanceof URL) {
    return true;
  }

  if (typeof value !== "string") {
    return false;
  }

  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("file://");
}
