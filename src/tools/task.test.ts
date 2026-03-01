import { describe, expect, test } from "bun:test";
import { loop } from "../loop";
import { JustBashRuntime } from "../runtime/just-bash";
import { createMockModel, drainLoop, userMessage } from "../test/helpers";
import type { LoopEvent, ModelMessage, Tool } from "../types";
import { createTaskTool } from "./task";

describe("createTaskTool", () => {
  const runtime = new JustBashRuntime();

  test("runs a nested loop and returns the assistant text", async () => {
    // The inner model responds with "42" when the task tool is called
    const innerModel = createMockModel([{ text: "42" }]);
    const taskTool = createTaskTool({ model: innerModel });

    // The outer model calls the task tool, then responds with "Done"
    const outerModel = createMockModel([
      {
        toolCalls: [{ id: "t1", name: "task", input: { prompt: "What is the meaning of life?" } }],
      },
      { text: "Done" },
    ]);

    const events = await drainLoop([userMessage("Go")], {
      model: outerModel,
      tools: [taskTool],
      runtime,
      maxSteps: 10,
    });

    // The task tool should have returned "42" as its result
    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.type === "tool-result") {
      expect(toolResults[0].output).toBe("42");
    }
  });

  test("nested agent can use its own tools", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "echoes the input",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        return `echo: ${input.text}`;
      },
    };

    // Inner model: first calls the echo tool, then responds with the final text
    const innerModel = createMockModel([
      { toolCalls: [{ id: "inner-c1", name: "echo", input: { text: "hello" } }] },
      { text: "The echo said: hello" },
    ]);

    const taskTool = createTaskTool({
      model: innerModel,
      tools: [echoTool],
      systemPrompt: "You are a helpful echo agent.",
    });

    // Outer model calls the task tool
    const outerModel = createMockModel([
      {
        toolCalls: [{ id: "t1", name: "task", input: { prompt: "Echo hello for me" } }],
      },
      { text: "All done" },
    ]);

    const events = await drainLoop([userMessage("Go")], {
      model: outerModel,
      tools: [taskTool],
      runtime,
      maxSteps: 10,
    });

    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.type === "tool-result") {
      expect(toolResults[0].output).toBe("The echo said: hello");
    }
  });

  test("abort signal propagates to nested loop", async () => {
    const controller = new AbortController();

    // The inner model is slow — we abort before it completes
    const slowTool: Tool = {
      name: "slow",
      description: "a slow tool",
      parameters: { type: "object", properties: {} },
      execute: async (_input, ctx): Promise<string> => {
        // Abort while the slow tool is "running"
        controller.abort();
        // Check that signal is aborted
        if (ctx.signal?.aborted) return "aborted";
        return "completed";
      },
    };

    // Inner model calls the slow tool, then would respond (but gets aborted)
    const innerModel = createMockModel([
      { toolCalls: [{ id: "inner-c1", name: "slow", input: {} }] },
      { text: "Should not reach here" },
    ]);

    const taskTool = createTaskTool({
      model: innerModel,
      tools: [slowTool],
    });

    // Run the task tool directly to check signal propagation
    const result = await taskTool.execute(
      { prompt: "Do something slow" },
      { runtime, signal: controller.signal },
    );

    // The nested loop should have been cut short by the abort.
    // It either returns the partial text or the no-response fallback.
    const output = result as string;
    expect(output).not.toBe("Should not reach here");
  });

  test("custom name and description", () => {
    const innerModel = createMockModel([{ text: "ok" }]);
    const taskTool = createTaskTool({
      model: innerModel,
      name: "research",
      description: "Research a topic",
    });

    expect(taskTool.name).toBe("research");
    expect(taskTool.description).toBe("Research a topic");
  });

  test("returns fallback when nested loop produces no assistant text", async () => {
    // Model that produces no text content — just an empty response
    const innerModel = createMockModel([{ text: "" }]);
    const taskTool = createTaskTool({ model: innerModel });

    const result = await taskTool.execute({ prompt: "Do something" }, { runtime });

    const output = result as string;
    expect(output).toBe("(no response from subtask)");
  });

  test("respects maxSteps configuration", async () => {
    // Inner model keeps calling tools indefinitely
    const counter = { value: 0 };
    const countTool: Tool = {
      name: "count",
      description: "counts",
      parameters: { type: "object", properties: {} },
      execute: async (): Promise<string> => {
        counter.value++;
        return `count: ${counter.value}`;
      },
    };

    const innerModel = createMockModel([
      { toolCalls: [{ id: "c1", name: "count", input: {} }] },
      { toolCalls: [{ id: "c2", name: "count", input: {} }] },
      { toolCalls: [{ id: "c3", name: "count", input: {} }] },
      { text: "Final" },
    ]);

    const taskTool = createTaskTool({
      model: innerModel,
      tools: [countTool],
      maxSteps: 2,
    });

    const result = await taskTool.execute({ prompt: "Count things" }, { runtime });

    // maxSteps: 2 means only 2 loop iterations, so count should be <= 2
    expect(counter.value).toBeLessThanOrEqual(2);
  });
});
