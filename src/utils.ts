import type { ModelMessage } from "@ai-sdk/provider-utils";

/** Extract joined text from a ModelMessage's content. */
export function getMessageText(message: ModelMessage): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Return the text of the last assistant message, or "" if none. */
export function getLastAssistantText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return getMessageText(messages[i]!);
  }
  return "";
}
