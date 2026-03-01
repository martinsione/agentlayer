import { describe, expect, test } from "bun:test";
import { loop } from "./loop";
import { JustBashRuntime } from "./runtime/just-bash";
import { createMockModel, drainLoop, userMessage } from "./test/helpers";
import { BashTool } from "./tools/bash";
import type { LoopEvent, ModelMessage } from "./types";

describe("loop", () => {
  test("yields events in correct order for text-only", async () => {
    const model = createMockModel([{ text: "Hello" }]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [],
      runtime,
      maxSteps: 10,
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["text_delta", "message", "step"]);

    const e0 = events[0]!;
    expect(e0.type).toBe("text_delta");
    if (e0.type === "text_delta") expect(e0.delta).toBe("Hello");

    const e1 = events[1]!;
    expect(e1.type).toBe("message");
    if (e1.type === "message") expect(e1.message.role).toBe("assistant");

    const e2 = events[2]!;
    expect(e2.type).toBe("step");
    if (e2.type === "step") expect(e2.finishReason).toBe("stop");
  });

  test("stops after maxSteps even if model keeps calling tools", async () => {
    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo 1" } }] },
      { toolCalls: [{ id: "c2", name: "bash", input: { command: "echo 2" } }] },
      { toolCalls: [{ id: "c3", name: "bash", input: { command: "echo 3" } }] },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 2,
    });

    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(2);
  });

  test("tool execution error yields isError tool_result", async () => {
    const failingTool = {
      name: "fail",
      description: "always fails",
      parameters: { type: "object", properties: {} },
      execute: async (): Promise<string> => {
        throw new Error("kaboom");
      },
    };
    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "fail", input: {} }] },
      { text: "OK" },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [failingTool],
      runtime,
      maxSteps: 10,
    });

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.result).toBe("kaboom");
    }
  });

  test("tool not found yields error tool_result", async () => {
    const model = createMockModel([
      { toolCalls: [{ id: "call-1", name: "nonexistent", input: {} }] },
      { text: "OK" },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [],
      runtime,
      maxSteps: 10,
    });

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.result).toBe("Tool not found: nonexistent");
    }
  });

  test("multiple tool calls in one step execute in parallel", async () => {
    const executionLog: { name: string; time: number }[] = [];
    const start = Date.now();

    const slowTool = (name: string) => ({
      name,
      description: `slow tool ${name}`,
      parameters: { type: "object", properties: {} },
      execute: async (): Promise<string> => {
        executionLog.push({ name, time: Date.now() - start });
        await new Promise((r) => setTimeout(r, 50));
        return `${name}-done`;
      },
    });

    const model = createMockModel([
      {
        toolCalls: [
          { id: "c1", name: "slow_a", input: {} },
          { id: "c2", name: "slow_b", input: {} },
        ],
      },
      { text: "Done" },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Go")], {
      model,
      tools: [slowTool("slow_a"), slowTool("slow_b")],
      runtime,
      maxSteps: 10,
    });

    expect(executionLog).toHaveLength(2);
    const timeDiff = Math.abs(executionLog[0]!.time - executionLog[1]!.time);
    expect(timeDiff).toBeLessThan(20);

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    if (results[0]?.type === "tool_result") expect(results[0].result).toBe("slow_a-done");
    if (results[1]?.type === "tool_result") expect(results[1].result).toBe("slow_b-done");

    const tcEvents = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
    expect(tcEvents.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ]);
  });

  test("parallel execution with mixed approve and deny", async () => {
    const model = createMockModel([
      {
        toolCalls: [
          { id: "c1", name: "bash", input: { command: "echo allowed" } },
          { id: "c2", name: "bash", input: { command: "echo denied" } },
        ],
      },
      { text: "OK" },
    ]);
    const runtime = new JustBashRuntime();
    const messages: ModelMessage[] = [userMessage("Go")];

    const events: LoopEvent[] = [];
    const gen = loop(messages, { model, tools: [BashTool], runtime, maxSteps: 10 });
    let callIndex = 0;
    for (let result = await gen.next(); !result.done; ) {
      events.push(result.value);
      if (result.value.type === "tool_call") {
        const decision = callIndex === 1 ? { deny: "blocked" } : undefined;
        callIndex++;
        result = await gen.next(decision);
      } else {
        result = await gen.next();
      }
    }

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    if (results[0]?.type === "tool_result") {
      expect(results[0].result).toBe("allowed\n");
      expect(results[0].isError).toBe(false);
    }
    if (results[1]?.type === "tool_result") {
      expect(results[1].result).toBe("blocked");
      expect(results[1].isError).toBe(true);
    }
  });

  test("yields no events when signal is already aborted", async () => {
    const model = createMockModel([{ text: "Hello" }]);
    const runtime = new JustBashRuntime();
    const controller = new AbortController();
    controller.abort();

    const events: LoopEvent[] = [];
    const gen = loop(
      [userMessage("Hi")],
      { model, tools: [], runtime, maxSteps: 10 },
      controller.signal,
    );
    for (let result = await gen.next(); !result.done; result = await gen.next()) {
      events.push(result.value);
    }

    expect(events).toHaveLength(0);
  });

  test("parallel execution: one tool throws, others succeed", async () => {
    const succeedTool = {
      name: "succeed",
      description: "succeeds",
      parameters: { type: "object", properties: {} },
      execute: async (): Promise<string> => "ok",
    };
    const failTool = {
      name: "fail",
      description: "fails",
      parameters: { type: "object", properties: {} },
      execute: async (): Promise<string> => {
        throw new Error("boom");
      },
    };

    const model = createMockModel([
      {
        toolCalls: [
          { id: "c1", name: "succeed", input: {} },
          { id: "c2", name: "fail", input: {} },
        ],
      },
      { text: "Done" },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Go")], {
      model,
      tools: [succeedTool, failTool],
      runtime,
      maxSteps: 10,
    });

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    if (results[0]?.type === "tool_result") {
      expect(results[0].result).toBe("ok");
      expect(results[0].isError).toBe(false);
    }
    if (results[1]?.type === "tool_result") {
      expect(results[1].result).toBe("boom");
      expect(results[1].isError).toBe(true);
    }
  });
});
