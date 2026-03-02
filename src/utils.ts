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
