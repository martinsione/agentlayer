import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type { Input, UserInput } from "@openai/codex-sdk";

export type PromptMappingResult = {
  input: Input;
  warnings: SharedV3Warning[];
};

type PromptEntry =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "local_image";
      path: string;
    };

export function mapPromptToCodexInput(prompt: LanguageModelV3Prompt): PromptMappingResult {
  const entries: PromptEntry[] = [];
  const warnings: SharedV3Warning[] = [];
  const warningSet = new Set<string>();
  let unsupportedFileIndex = 0;

  const warnOnce = (warning: SharedV3Warning): void => {
    let key: string = warning.type;
    if ("feature" in warning) {
      key = `${warning.type}:${warning.feature}`;
    }
    if (warningSet.has(key)) {
      return;
    }
    warningSet.add(key);
    warnings.push(warning);
  };

  const pushText = (text: string): void => {
    if (!text.trim()) {
      return;
    }
    entries.push({ type: "text", text });
  };

  const mapUserFile = (part: LanguageModelV3FilePart): PromptEntry | null => {
    if (!part.mediaType.startsWith("image/")) {
      warnOnce({
        type: "unsupported",
        feature: "file-media-type",
        details: "Only image/* file media types are supported by codex-sdk prompt mapping.",
      });
      unsupportedFileIndex += 1;
      return { type: "text", text: `[unsupported-file:${unsupportedFileIndex}]` };
    }

    const path = resolveLocalImagePath(part.data);
    if (path == null) {
      if (isUrlLike(part.data)) {
        warnOnce({
          type: "unsupported",
          feature: "file-url",
          details: "Only file:// image URLs are supported by codex-sdk prompt mapping.",
        });
      } else {
        warnOnce({
          type: "unsupported",
          feature: "file-inline-data",
          details: "Inline file data is not supported by codex-sdk prompt mapping.",
        });
      }
      unsupportedFileIndex += 1;
      return { type: "text", text: `[unsupported-file:${unsupportedFileIndex}]` };
    }

    return { type: "local_image", path };
  };

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        pushText(`[system]\n${message.content}`);
        break;
      }

      case "user": {
        const bufferedLines: string[] = [];

        const flushBuffered = (): void => {
          if (bufferedLines.length === 0) {
            return;
          }
          pushText(`[user]\n${bufferedLines.join("\n")}`);
          bufferedLines.length = 0;
        };

        for (const part of message.content) {
          if (part.type === "text") {
            bufferedLines.push(part.text);
            continue;
          }

          if (part.type === "file") {
            const mapped = mapUserFile(part);
            if (mapped == null) {
              continue;
            }

            if (mapped.type === "local_image") {
              flushBuffered();
              entries.push(mapped);
            } else {
              bufferedLines.push(mapped.text);
            }
          }
        }

        flushBuffered();
        break;
      }

      case "assistant": {
        for (const part of message.content) {
          if (part.type === "text") {
            pushText(`[assistant]\n${part.text}`);
          } else if (part.type === "reasoning") {
            pushText(`[assistant:reasoning]\n${part.text}`);
          } else if (part.type === "tool-call") {
            pushText(
              `[assistant:tool-call] ${part.toolName} ${part.toolCallId}\n${JSON.stringify(part.input)}`,
            );
          } else if (part.type === "tool-result") {
            pushText(
              `[assistant:tool-result] ${part.toolName} ${part.toolCallId}\n${JSON.stringify(part.output)}`,
            );
          } else if (part.type === "file") {
            const mapped = mapUserFile(part);
            if (mapped == null) {
              continue;
            }
            if (mapped.type === "local_image") {
              entries.push(mapped);
            } else {
              pushText(`[assistant]\n${mapped.text}`);
            }
          }
        }
        break;
      }

      case "tool": {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            pushText(
              `[tool:result] ${part.toolName} ${part.toolCallId}\n${JSON.stringify(part.output)}`,
            );
          } else if (part.type === "tool-approval-response") {
            pushText(
              `[tool:approval] ${part.approvalId}\n${JSON.stringify({ approved: part.approved, reason: part.reason })}`,
            );
          }
        }
        break;
      }
    }
  }

  if (!entries.some((entry) => entry.type === "local_image")) {
    return {
      input: entries
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n\n"),
      warnings,
    };
  }

  return {
    input: entries as UserInput[],
    warnings,
  };
}

function resolveLocalImagePath(data: unknown): string | null {
  if (data instanceof URL) {
    if (data.protocol !== "file:") {
      return null;
    }
    return decodeURIComponent(data.pathname);
  }

  if (typeof data === "string") {
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

  return null;
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

function isUrlLike(value: unknown): boolean {
  if (value instanceof URL) {
    return true;
  }
  if (typeof value === "string") {
    return (
      value.startsWith("http://") || value.startsWith("https://") || value.startsWith("file://")
    );
  }
  return false;
}
