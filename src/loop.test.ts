import { describe, expect, test } from "bun:test";
import type { LoopConfig } from "./loop";
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
    expect(types).toEqual(["text-start", "text-delta", "text-end", "message"]);

    const delta = events.find((e) => e.type === "text-delta")!;
    expect(delta.type).toBe("text-delta");
    if (delta.type === "text-delta") expect(delta.text).toBe("Hello");

    const msg = events.find((e) => e.type === "message")!;
    expect(msg.type).toBe("message");
    if (msg.type === "message") {
      expect(msg.message.role).toBe("assistant");
      expect("finishReason" in msg && msg.finishReason).toBe("stop");
    }
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

    const assistantMessages = events.filter(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(2);
  });

  test("tool execution error yields tool-error event", async () => {
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

    const toolError = events.find((e) => e.type === "tool-error");
    expect(toolError).toBeDefined();
    if (toolError?.type === "tool-error") {
      expect(toolError.toolName).toBe("fail");
      expect(String(toolError.error)).toContain("kaboom");
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

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(2);
  });

  test("onBeforeToolCall deny produces tool-error", async () => {
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

    const events = await drainLoop([userMessage("Go")], {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 10,
      onBeforeToolCall: async (e) => {
        if (e.toolCallId === "c2") return { deny: "blocked" };
        return undefined;
      },
    });

    const results = events.filter((e) => e.type === "tool-result");
    const errors = events.filter((e) => e.type === "tool-error");
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(1);
    if (errors[0]?.type === "tool-error") {
      expect(String(errors[0].error)).toContain("blocked");
    }
  });

  test("onBeforeToolCall input override", async () => {
    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo original" } }] },
      { text: "Done" },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Go")], {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 10,
      onBeforeToolCall: async () => {
        return { input: { command: "echo overridden" } };
      },
    });

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(1);
    if (results[0]?.type === "tool-result") {
      expect(results[0].output).toBe("overridden\n");
    }
  });

  test("yields no events when signal is already aborted", async () => {
    const model = createMockModel([{ text: "Hello" }]);
    const runtime = new JustBashRuntime();
    const controller = new AbortController();
    controller.abort();

    const events: LoopEvent[] = [];
    for await (const event of loop(
      [userMessage("Hi")],
      { model, tools: [], runtime, maxSteps: 10 },
      controller.signal,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  test("yields reasoning events when model returns reasoning", async () => {
    const model = createMockModel([{ text: "Answer", reasoning: "Let me think" }]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [],
      runtime,
      maxSteps: 10,
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "message",
    ]);

    const reasoningDelta = events.find((e) => e.type === "reasoning-delta")!;
    if (reasoningDelta.type === "reasoning-delta") {
      expect(reasoningDelta.text).toBe("Let me think");
    }
  });

  test("yields tool-input-* events for tool calls", async () => {
    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] },
      { text: "Done" },
    ]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 10,
    });

    const toolInputTypes = events.filter((e) => e.type.startsWith("tool-input")).map((e) => e.type);
    expect(toolInputTypes).toEqual(["tool-input-start", "tool-input-delta", "tool-input-end"]);
  });

  test("message event includes usage", async () => {
    const model = createMockModel([{ text: "Hello" }]);
    const runtime = new JustBashRuntime();

    const events = await drainLoop([userMessage("Hi")], {
      model,
      tools: [],
      runtime,
      maxSteps: 10,
    });

    const msg = events.find((e) => e.type === "message" && e.message.role === "assistant");
    expect(msg).toBeDefined();
    if (msg?.type === "message" && "usage" in msg) {
      expect(msg.usage).toEqual({ input: 10, output: 5 });
    }
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

    const results = events.filter((e) => e.type === "tool-result");
    const errors = events.filter((e) => e.type === "tool-error");
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(1);
    if (results[0]?.type === "tool-result") {
      expect(results[0].output).toBe("ok");
    }
    if (errors[0]?.type === "tool-error") {
      expect(String(errors[0].error)).toContain("boom");
    }
  });
});

describe("loop steering/follow-up callbacks", () => {
  const runtime = new JustBashRuntime();

  test("steering messages appear in model context before next call", async () => {
    const steeringMsg = userMessage("Actually, do this instead");
    const steeringQueue: ModelMessage[] = [];

    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] },
      { text: "OK, redirected" },
    ]);

    const messages: ModelMessage[] = [userMessage("Hi")];
    let stepCount = 0;
    const events: LoopEvent[] = [];

    for await (const event of loop(messages, {
      model,
      tools: [BashTool],
      runtime,
      maxSteps: 10,
      getSteeringMessages: () => steeringQueue.splice(0),
    })) {
      events.push(event);
      // After the first assistant message completes, queue a steering message for drain point 1
      if (event.type === "message" && event.message.role === "assistant") {
        stepCount++;
        if (stepCount === 1) steeringQueue.push(steeringMsg);
      }
    }

    // The steering message should be in the messages array
    expect(messages.some((m) => m === steeringMsg)).toBe(true);
    // Model should have been called twice (two assistant messages)
    const assistantMessages = events.filter(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(2);
  });

  test("follow-up messages keep loop alive for another turn", async () => {
    const followUpMsg = userMessage("One more thing");

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

    // Should have two assistant messages (two model calls)
    const assistantMessages = events.filter(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(2);

    // Follow-up message should be in the messages array
    expect(messages.some((m) => m === followUpMsg)).toBe(true);

    // Should have two text deltas
    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas).toHaveLength(2);
  });

  test("empty callbacks = identical behavior to no callbacks", async () => {
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
      model: createMockModel([{ text: "Hello" }]),
      tools: [],
      runtime,
      maxSteps: 10,
    });

    expect(eventsWithCallbacks.map((e) => e.type)).toEqual(eventsWithout.map((e) => e.type));
  });
});
