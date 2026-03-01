import { describe, expect, test } from "bun:test";
import { STEERING_DENY_REASON, type LoopConfig } from "./loop";
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

describe("loop steering/follow-up callbacks", () => {
  const runtime = new JustBashRuntime();

  test("steering messages appear in model context before next call", async () => {
    const steeringMsg = userMessage("Actually, do this instead");
    // Use a queue pattern: push the steering message after the first model call completes
    const steeringQueue: ModelMessage[] = [];

    // Response 1: tool call → triggers tool execution → next iteration
    // Response 2: text (after steering injected at drain point 1) → loop ends
    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] },
      { text: "OK, redirected" },
    ]);

    const messages: ModelMessage[] = [userMessage("Hi")];
    let stepCount = 0;
    const events: LoopEvent[] = [];
    const gen = loop(messages, {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 10,
      getSteeringMessages: () => steeringQueue.splice(0),
    });

    for (let result = await gen.next(); !result.done; result = await gen.next()) {
      events.push(result.value);
      // After the first step completes, queue a steering message for drain point 1
      if (result.value.type === "step") {
        stepCount++;
        if (stepCount === 1) steeringQueue.push(steeringMsg);
      }
    }

    // The steering message should be in the messages array
    expect(messages.some((m) => m === steeringMsg)).toBe(true);
    // Model should have been called twice (two steps)
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(2);
  });

  test("follow-up messages keep loop alive for another turn", async () => {
    const followUpMsg = userMessage("One more thing");

    // Response 1: text only (would normally break) → follow-up keeps alive
    // Response 2: text only → loop ends (no more follow-ups)
    const model = createMockModel([{ text: "First reply" }, { text: "Second reply" }]);

    let followUpReturned = false;
    const messages: ModelMessage[] = [userMessage("Hi")];
    const config: LoopConfig = {
      model,
      tools: [],
      runtime,
      maxSteps: 10,
      getFollowUpMessages: () => {
        if (!followUpReturned) {
          followUpReturned = true;
          return [followUpMsg];
        }
        return [];
      },
    };

    const events = await drainLoop(messages, config);

    // Should have two steps (two model calls)
    const steps = events.filter((e) => e.type === "step");
    expect(steps).toHaveLength(2);

    // Follow-up message should be in the messages array
    expect(messages.some((m) => m === followUpMsg)).toBe(true);

    // Should have two text deltas
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
  });

  test("steering during Phase 1 auto-denies remaining tool calls", async () => {
    const steeringMsg = userMessage("Stop, new instruction");
    const steeringQueue: ModelMessage[] = [];

    // Response 1: two tool calls → steering injected between first and second tool_call yield
    // Response 2: text → loop ends
    const model = createMockModel([
      {
        toolCalls: [
          { id: "c1", name: "bash", input: { command: "echo a" } },
          { id: "c2", name: "bash", input: { command: "echo b" } },
        ],
      },
      { text: "Redirected" },
    ]);

    const messages: ModelMessage[] = [userMessage("Go")];
    const events: LoopEvent[] = [];
    const gen = loop(messages, {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 10,
      getSteeringMessages: () => steeringQueue.splice(0),
    });

    let toolCallCount = 0;
    for (let result = await gen.next(); !result.done; ) {
      events.push(result.value);
      if (result.value.type === "tool_call") {
        toolCallCount++;
        if (toolCallCount === 1) {
          // Inject steering after first tool_call yield, before second drain point 2 check
          steeringQueue.push(steeringMsg);
        }
        result = await gen.next(); // approve the tool call
      } else {
        result = await gen.next();
      }
    }

    // First tool call yielded normally, second was auto-denied
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);

    // Both produce tool_result: first approved (executed), second denied
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    if (toolResults[0]?.type === "tool_result") {
      expect(toolResults[0].isError).toBe(false);
      expect(toolResults[0].result).toBe("a\n");
    }
    if (toolResults[1]?.type === "tool_result") {
      expect(toolResults[1].isError).toBe(true);
      expect(toolResults[1].result).toBe(STEERING_DENY_REASON);
    }
  });

  test("empty callbacks = identical behavior to no callbacks", async () => {
    const model = createMockModel([{ text: "Hello" }]);

    const messagesWithCallbacks: ModelMessage[] = [userMessage("Hi")];
    const eventsWithCallbacks = await drainLoop(messagesWithCallbacks, {
      model: createMockModel([{ text: "Hello" }]),
      tools: [],
      runtime,
      maxSteps: 10,
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    });

    const messagesWithout: ModelMessage[] = [userMessage("Hi")];
    const eventsWithout = await drainLoop(messagesWithout, {
      model,
      tools: [],
      runtime,
      maxSteps: 10,
    });

    expect(eventsWithCallbacks.map((e) => e.type)).toEqual(eventsWithout.map((e) => e.type));
  });
});
