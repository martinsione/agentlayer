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
import { getLastAssistantText } from "../utils";

const taskSchema = z.object({
  prompt: z.string().describe("The task to perform"),
});

export type TaskToolConfig = {
  model: LanguageModel;
  tools?: Tool[];
  instructions?: string;
  maxSteps?: number;
  name?: string;
  label?: string;
  description?: string;
};

export function createTaskTool(config: TaskToolConfig): Tool {
  const {
    model,
    tools = [],
    instructions,
    maxSteps = 50,
    name = "task",
    label = "Task",
    description = "Run a subtask by spawning a nested agent loop with the given prompt.",
  } = config;

  return {
    name,
    label,
    description,
    parameters: z.toJSONSchema(taskSchema, { target: "draft-7" }) as Record<string, unknown>,
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const { prompt } = taskSchema.parse(input);

      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ];

      for await (const event of loop(
        messages,
        { model, tools, runtime: ctx.runtime, maxSteps, instructions },
        ctx.signal,
      )) {
        if (event.type === "message") {
          messages.push(event.message);
        }
      }

      return getLastAssistantText(messages) || "(no response from subtask)";
    },
  };
}
