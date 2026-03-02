/**
 * Task tool — spawn a nested agent loop as a tool call.
 *
 * Uses the existing `loop()` generator to stay DRY. The nested loop runs with
 * its own fresh messages array and returns the final assistant text response.
 */

import type { LanguageModel } from "ai";
import { z } from "zod/v4";
import { loop } from "../loop";
import type { ModelMessage, Tool, ToolContext } from "../types";
import { getMessageText } from "../utils";

const taskSchema = z.object({
  prompt: z.string().describe("The task to perform"),
});

export type TaskToolConfig = {
  model: LanguageModel;
  tools?: Tool[];
  systemPrompt?: string;
  maxSteps?: number;
  name?: string;
  description?: string;
};

export function createTaskTool(config: TaskToolConfig): Tool {
  const {
    model,
    tools = [],
    systemPrompt,
    maxSteps = 50,
    name = "task",
    description = "Run a subtask by spawning a nested agent loop with the given prompt.",
  } = config;

  return {
    name,
    description,
    parameters: z.toJSONSchema(taskSchema, { target: "draft-7" }) as Record<string, unknown>,
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const { prompt } = taskSchema.parse(input);

      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ];

      let lastAssistantText = "";

      for await (const event of loop(
        messages,
        { model, tools, runtime: ctx.runtime, maxSteps, systemPrompt },
        ctx.signal,
      )) {
        if (event.type === "message" && event.message.role === "assistant") {
          const text = getMessageText(event.message);
          if (text) lastAssistantText = text;
        }
      }

      return lastAssistantText || "(no response from subtask)";
    },
  };
}
