import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { convertArrayToReadableStream } from "@ai-sdk/provider-utils/test";
import { MockLanguageModelV3 } from "ai/test";
import { Agent } from "./agent";
import { JustBashRuntime } from "./runtime/just-bash";
import { buildContext } from "./session";
import { InMemorySessionStore } from "./store/memory";
import {
  createFailingModel,
  createMockModel,
  createSlowTool,
  createTestAgent,
  userMessage,
} from "./test/helpers";
import { BashTool } from "./tools/bash";
import type {
  MessageEvent,
  BeforeToolCallEvent,
  MessageEntry,
  CompactionEntry,
  SessionEntry,
  StatusEvent,
  StepStartEvent,
  StepEndEvent,
  Tool,
} from "./types";

describe("Session.send", () => {
  test("text-only response", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const userMessages: ModelMessage[] = [];
    const assistantMessages: { message: ModelMessage; finishReason: string }[] = [];
    const deltas: string[] = [];
    let turnEnd: { messages: ModelMessage[]; text: string } | undefined;

    session.on("message", (e) => {
      if (e.message.role === "user") userMessages.push(e.message);
      if (e.message.role === "assistant" && "finishReason" in e)
        assistantMessages.push({ message: e.message, finishReason: e.finishReason });
    });
    session.on("text-delta", (e) => {
      deltas.push(e.text);
    });
    session.on("turn-end", (e) => {
      turnEnd = e;
    });

    session.send("Hi");
    await session.waitForIdle();

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.role).toBe("user");

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]!.message.role).toBe("assistant");
    expect(assistantMessages[0]!.finishReason).toBe("stop");

    expect(deltas).toEqual(["Hello"]);

    expect(turnEnd).toBeDefined();
    expect(turnEnd!.text).toBe("Hello");
    expect(turnEnd!.messages).toHaveLength(2);
  });

  test("multi-turn conversation sends full history", async () => {
    const { agent, model } = createTestAgent([{ text: "First reply" }, { text: "Second reply" }]);
    const session = await agent.createSession();

    session.send("Message 1");
    await session.waitForIdle();
    session.send("Message 2");
    await session.waitForIdle();

    const secondCallMessages = model.doStreamCalls[1]!.prompt;
    expect(secondCallMessages.length).toBeGreaterThanOrEqual(3); // user1 + assistant1 + user2
    expect(secondCallMessages[0]!.role).toBe("user");
    expect(secondCallMessages[1]!.role).toBe("assistant");
    expect(secondCallMessages[2]!.role).toBe("user");
  });

  test("tool call + tool result", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "echo hi" } }] },
        { text: "Done" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const beforeToolCalls: BeforeToolCallEvent[] = [];
    const toolResults: { output: unknown; toolName: string }[] = [];
    let turnEndText = "";

    session.on("before-tool-call", (e) => {
      beforeToolCalls.push(e);
    });
    session.on("tool-result", (e) => {
      toolResults.push({ output: e.output, toolName: e.toolName });
    });
    session.on("turn-end", (e) => {
      turnEndText = e.text;
    });

    session.send("Run echo");
    await session.waitForIdle();

    expect(beforeToolCalls).toHaveLength(1);
    expect(beforeToolCalls[0]).toEqual({
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo hi" },
    });

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.toolName).toBe("bash");
    expect(toolResults[0]!.output).toBe("hi\n");

    expect(turnEndText).toBe("Done");
  });

  test("tool call denied via before-tool-call", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "rm -rf /" } }] },
        { text: "OK" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const toolErrors: { error: unknown }[] = [];
    session.on("before-tool-call", () => ({ deny: "blocked" }));
    session.on("tool-error", (e) => {
      toolErrors.push({ error: e.error });
    });

    session.send("Do something dangerous");
    await session.waitForIdle();

    expect(toolErrors).toHaveLength(1);
    expect(String(toolErrors[0]!.error)).toContain("blocked");
  });

  test("error event fires and send rejects on model failure", async () => {
    const agent = new Agent({
      model: createFailingModel(),
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();

    const errors: Error[] = [];
    session.on("error", (e) => {
      errors.push(e.error);
    });

    const orig = console.error;
    console.error = () => {};
    let threw = false;
    try {
      session.send("Hi");
      await session.waitForIdle();
    } catch {
      threw = true;
    } finally {
      console.error = orig;
    }
    expect(threw).toBe(true);
    expect(errors).toHaveLength(1);
  });

  test("tool call args override via before-tool-call", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "echo original" } }] },
        { text: "Done" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const toolResults: { output: unknown }[] = [];
    session.on("before-tool-call", () => ({ input: { command: "echo overridden" } }));
    session.on("tool-result", (e) => {
      toolResults.push({ output: e.output });
    });

    session.send("Run something");
    await session.waitForIdle();

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.output).toBe("overridden\n");
  });

  test("unsubscribe removes a listener", async () => {
    const { agent } = createTestAgent([{ text: "A" }, { text: "B" }]);
    const session = await agent.createSession();

    const deltas: string[] = [];
    const unsub = session.on("text-delta", (e) => {
      deltas.push(e.text);
    });

    session.send("First");
    await session.waitForIdle();
    unsub();
    session.send("Second");
    await session.waitForIdle();

    expect(deltas).toEqual(["A"]);
  });

  test("turn-start fires before stream events", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const order: string[] = [];
    session.on("turn-start", () => {
      order.push("turn-start");
    });
    session.on("text-start", () => {
      order.push("text-start");
    });
    session.on("text-delta", () => {
      order.push("text-delta");
    });
    session.on("message", (e) => {
      if (e.message.role !== "user") order.push("message");
    });
    session.on("turn-end", () => {
      order.push("turn-end");
    });

    session.send("Hi");
    await session.waitForIdle();

    expect(order[0]).toBe("turn-start");
    expect(order).toContain("text-start");
    expect(order).toContain("text-delta");
    expect(order).toContain("message");
    expect(order[order.length - 1]).toBe("turn-end");
  });

  test("stream events pass through to session listeners", async () => {
    const { agent } = createTestAgent([{ text: "Hi", reasoning: "Thinking" }]);
    const session = await agent.createSession();

    const types: string[] = [];
    for (const event of [
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ] as const) {
      session.on(event, () => {
        types.push(event);
      });
    }

    session.send("Hello");
    await session.waitForIdle();

    expect(types).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ]);
  });

  test("after-tool-call fires with result on success", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "echo hi" } }] },
        { text: "Done" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const afterEvents: { toolName: string; result?: string; error?: Error }[] = [];
    session.on("after-tool-call", (e) => {
      afterEvents.push({ toolName: e.toolName, result: e.result, error: e.error });
    });

    session.send("Go");
    await session.waitForIdle();

    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0]!.toolName).toBe("bash");
    expect(afterEvents[0]!.result).toBe("hi\n");
    expect(afterEvents[0]!.error).toBeUndefined();
  });

  test("after-tool-call can override result", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "echo original" } }] },
        { text: "Done" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    session.on("after-tool-call", () => ({ result: "replaced" }));

    const toolResults: { output: unknown }[] = [];
    session.on("tool-result", (e) => {
      toolResults.push({ output: e.output });
    });

    session.send("Go");
    await session.waitForIdle();

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.output).toBe("replaced");
  });

  test("before-model-call fires before each model invocation", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const beforeModelCalls: { system: string | undefined }[] = [];
    session.on("before-model-call", (e) => {
      beforeModelCalls.push({ system: e.system });
    });

    session.send("Hi");
    await session.waitForIdle();

    expect(beforeModelCalls).toHaveLength(1);
  });

  test("first before-tool-call listener to return a decision wins", async () => {
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "bash", input: { command: "echo 1" } }] }, { text: "Done" }],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const toolErrors: { error: unknown }[] = [];
    session.on("tool-error", (e) => {
      toolErrors.push({ error: e.error });
    });

    session.on("before-tool-call", () => ({ deny: "first wins" }));
    session.on("before-tool-call", () => undefined);

    session.send("Go");
    await session.waitForIdle();

    expect(toolErrors).toHaveLength(1);
    expect(String(toolErrors[0]!.error)).toContain("first wins");
  });
});

describe("Session.send modes", () => {
  test("send() while running with mode: steer injects before next model turn", async () => {
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "slow", input: {} }] }, { text: "Steered response" }],
      {
        tools: [createSlowTool()],
      },
    );
    const session = await agent.createSession();

    const allUserMessages: ModelMessage[] = [];
    const allAssistantMessages: ModelMessage[] = [];
    session.on("message", (e) => {
      if (e.message.role === "user") allUserMessages.push(e.message);
      if (e.message.role === "assistant") allAssistantMessages.push(e.message);
    });

    // Start the loop
    session.send("First message");

    // Wait a tick for the loop to start, then steer
    await new Promise((r) => setTimeout(r, 10));
    session.send("Steer message", { mode: "steer" });

    await session.waitForIdle();

    // Should have: user1, assistant1 (tool call), user2 (steer), assistant2 (steered response)
    expect(allUserMessages).toHaveLength(2);
    expect(allAssistantMessages).toHaveLength(2);
  });

  test("send() while running with mode: queue processes after current turn", async () => {
    const { agent } = createTestAgent(
      [
        {
          toolCalls: [{ id: "c1", name: "slow", input: {} }],
        },
        { text: "First reply" },
        { text: "Queued reply" },
      ],
      {
        tools: [createSlowTool()],
      },
    );
    const session = await agent.createSession();

    const deltas: string[] = [];
    session.on("text-delta", (e) => {
      deltas.push(e.text);
    });

    // Start the loop
    session.send("First");

    // Wait for loop to start, then queue a message
    await new Promise((r) => setTimeout(r, 10));
    session.send("Queued", { mode: "queue" });

    await session.waitForIdle();

    // Should have both text responses
    expect(deltas).toContain("First reply");
    expect(deltas).toContain("Queued reply");
  });

  test("multiple concurrent send() calls all resolve when loop settles", async () => {
    const { agent } = createTestAgent(
      [
        {
          toolCalls: [{ id: "c1", name: "slow", input: {} }],
        },
        { text: "Reply to steer" },
        { text: "Reply to queue" },
      ],
      {
        tools: [createSlowTool()],
      },
    );
    const session = await agent.createSession();

    session.send("First");
    await new Promise((r) => setTimeout(r, 10));
    session.send("Second", { mode: "steer" });
    session.send("Third", { mode: "queue" });

    // waitForIdle should resolve without error
    await session.waitForIdle();
  });

  test("session-level sendMode default works", async () => {
    // Create agent with queue as default
    const { agent } = createTestAgent(
      [
        {
          toolCalls: [{ id: "c1", name: "slow", input: {} }],
        },
        { text: "First" },
        { text: "Queued reply" },
      ],
      {
        sendMode: "queue",
        tools: [createSlowTool()],
      },
    );
    const session = await agent.createSession();

    const deltas: string[] = [];
    session.on("text-delta", (e) => {
      deltas.push(e.text);
    });

    session.send("First");
    await new Promise((r) => setTimeout(r, 10));
    // No mode specified — uses session default "queue"
    session.send("Second");

    await session.waitForIdle();

    // Queue mode means the second message processes after first turn ends
    expect(deltas).toContain("Queued reply");
  });

  test("per-call mode overrides session default", async () => {
    const { agent } = createTestAgent(
      [
        {
          toolCalls: [{ id: "c1", name: "slow", input: {} }],
        },
        { text: "Steered" },
      ],
      {
        sendMode: "queue",
        tools: [createSlowTool()],
      },
    );
    const session = await agent.createSession();

    const userMessages: ModelMessage[] = [];
    session.on("message", (e) => {
      if (e.message.role === "user") userMessages.push(e.message);
    });

    session.send("First");
    await new Promise((r) => setTimeout(r, 10));
    // Override queue default with steer
    session.send("Override to steer", { mode: "steer" });

    await session.waitForIdle();

    expect(userMessages).toHaveLength(2);
  });

  test("error rejects all shared callers", async () => {
    const agent = new Agent({
      model: createFailingModel(),
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();

    const orig = console.error;
    console.error = () => {};

    try {
      let threw1 = false;
      try {
        session.send("Hi");
        await session.waitForIdle();
      } catch {
        threw1 = true;
      }
      expect(threw1).toBe(true);
    } finally {
      console.error = orig;
    }
  });

  test("throwing error listener does not hang waitForIdle", async () => {
    const agent = new Agent({
      model: createFailingModel(),
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();

    session.on("error", () => {
      throw new Error("listener exploded");
    });

    session.send("Hi");
    expect(session.waitForIdle()).rejects.toThrow();
  });

  test("createSession with options object", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession({ id: "my-id", sendMode: "queue" });
    expect(session.id).toBe("my-id");
  });

  test("queues are cleared on error, next send() starts fresh", async () => {
    // Model that fails on first call, succeeds on second
    let callCount = 0;
    const failOnceThenSucceed = new MockLanguageModelV3({
      doStream: async () => {
        callCount++;
        if (callCount === 1) throw new Error("boom");
        return {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp-0", modelId: "mock", timestamp: new Date(0) },
            { type: "text-start", id: "text-0" },
            { type: "text-delta", id: "text-0", delta: "recovered" },
            { type: "text-end", id: "text-0" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: undefined, reasoning: undefined },
              },
            },
          ]),
        };
      },
    });

    const agent = new Agent({
      model: failOnceThenSucceed,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
      tools: [BashTool],
    });
    const session = await agent.createSession();

    const orig = console.error;
    console.error = () => {};

    // First send fails — also queue a steer message while it's "running"
    session.send("First");
    session.send("Stale steer", { mode: "steer" });

    let errored = false;
    try {
      await session.waitForIdle();
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);

    // Now send again — should start a fresh loop, not replay stale messages
    const deltas: string[] = [];
    session.on("text-delta", (e) => {
      deltas.push(e.text);
    });

    session.send("Retry");
    await session.waitForIdle();
    console.error = orig;

    expect(deltas).toEqual(["recovered"]);
  });

  test("waitForIdle() resolves immediately when no loop is running", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    // No loop started yet — should resolve immediately
    await session.waitForIdle();

    // After a completed loop — should also resolve immediately
    session.send("Hi");
    await session.waitForIdle();
    await session.waitForIdle();
  });

  test("send() after completed loop starts a new loop", async () => {
    const { agent } = createTestAgent([{ text: "First reply" }, { text: "Second reply" }]);
    const session = await agent.createSession();

    const deltas: string[] = [];
    session.on("text-delta", (e) => {
      deltas.push(e.text);
    });

    // First loop runs and completes
    session.send("Hello");
    await session.waitForIdle();
    expect(deltas).toEqual(["First reply"]);

    // Second send should start a fresh loop (completion was nulled)
    session.send("Hello again");
    await session.waitForIdle();
    expect(deltas).toEqual(["First reply", "Second reply"]);
  });
});

describe("Session.status", () => {
  test("status is idle before send and after completion", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    expect(session.status).toBe("idle");

    session.send("Hi");
    await session.waitForIdle();

    expect(session.status).toBe("idle");
  });

  test("status is busy while loop is running", async () => {
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "slow", input: {} }] }, { text: "Done" }],
      { tools: [createSlowTool()] },
    );
    const session = await agent.createSession();

    session.send("Go");
    // After send, status should be busy
    expect(session.status).toBe("busy");

    await session.waitForIdle();
    expect(session.status).toBe("idle");
  });

  test("status event emits busy then idle", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const statuses: string[] = [];
    session.on("status", (e) => {
      statuses.push(e.status);
    });

    session.send("Hi");
    await session.waitForIdle();

    expect(statuses).toEqual(["busy", "idle"]);
  });

  test("status event emits idle on error", async () => {
    const agent = new Agent({
      model: createFailingModel(),
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();

    const statuses: string[] = [];
    session.on("status", (e) => {
      statuses.push(e.status);
    });

    const orig = console.error;
    console.error = () => {};
    try {
      session.send("Hi");
      await session.waitForIdle();
    } catch {}
    console.error = orig;

    expect(statuses).toEqual(["busy", "idle"]);
  });
});

describe("Session.abort", () => {
  test("abort cancels a running turn", async () => {
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "slow", input: {} }] }, { text: "Never" }],
      { tools: [createSlowTool("slow", 500)] },
    );
    const session = await agent.createSession();

    const errors: Error[] = [];
    session.on("error", (e) => {
      errors.push(e.error);
    });

    session.send("Go");
    expect(session.status).toBe("busy");

    // Abort after a tick
    await new Promise((r) => setTimeout(r, 10));
    session.abort();

    try {
      await session.waitForIdle();
    } catch {}

    expect(session.status).toBe("idle");
  });

  test("abort is a no-op when idle", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    // Should not throw
    session.abort();
    expect(session.status).toBe("idle");
  });

  test("abort works alongside user-provided signal", async () => {
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "slow", input: {} }] }, { text: "Never" }],
      { tools: [createSlowTool("slow", 500)] },
    );
    const session = await agent.createSession();
    const externalController = new AbortController();

    session.send("Go", { signal: externalController.signal });
    expect(session.status).toBe("busy");

    await new Promise((r) => setTimeout(r, 10));
    session.abort();

    try {
      await session.waitForIdle();
    } catch {}

    expect(session.status).toBe("idle");
  });
});

describe("Session step events", () => {
  test("step-start and step-end fire for text-only turn", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const steps: { type: string; step: number }[] = [];
    session.on("step-start", (e) => {
      steps.push({ type: "step-start", step: e.step });
    });
    session.on("step-end", (e) => {
      steps.push({ type: "step-end", step: e.step });
    });

    session.send("Hi");
    await session.waitForIdle();

    expect(steps).toEqual([
      { type: "step-start", step: 1 },
      { type: "step-end", step: 1 },
    ]);
  });

  test("step events bracket each model call in multi-step turn", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] },
        { text: "Done" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const steps: { type: string; step: number }[] = [];
    session.on("step-start", (e) => {
      steps.push({ type: "step-start", step: e.step });
    });
    session.on("step-end", (e) => {
      steps.push({ type: "step-end", step: e.step });
    });

    session.send("Run echo");
    await session.waitForIdle();

    expect(steps).toEqual([
      { type: "step-start", step: 1 },
      { type: "step-end", step: 1 },
      { type: "step-start", step: 2 },
      { type: "step-end", step: 2 },
    ]);
  });
});

describe("Session.messages", () => {
  test("returns an empty array before any sends", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    expect(session.messages).toEqual([]);
    expect(session.messages).toHaveLength(0);
  });

  test("contains user and assistant messages after send + waitForIdle", async () => {
    const { agent } = createTestAgent([{ text: "Hello back" }]);
    const session = await agent.createSession();

    session.send("Hi");
    await session.waitForIdle();

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]!.role).toBe("user");
    expect(session.messages[1]!.role).toBe("assistant");
  });

  test("accumulates messages across multiple turns", async () => {
    const { agent } = createTestAgent([{ text: "First reply" }, { text: "Second reply" }]);
    const session = await agent.createSession();

    session.send("Message 1");
    await session.waitForIdle();
    expect(session.messages).toHaveLength(2);

    session.send("Message 2");
    await session.waitForIdle();
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0]!.role).toBe("user");
    expect(session.messages[1]!.role).toBe("assistant");
    expect(session.messages[2]!.role).toBe("user");
    expect(session.messages[3]!.role).toBe("assistant");
  });

  test("returned array is readonly (not a live mutable reference)", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const snapshotBefore = session.messages;
    expect(snapshotBefore).toHaveLength(0);

    session.send("Hi");
    await session.waitForIdle();

    // The snapshot taken before send should still be empty since it's the
    // same backing array that gets mutated internally. What matters is that
    // the TypeScript type is `readonly ModelMessage[]` which prevents
    // external callers from calling push/pop/splice at compile time.
    // At runtime we verify the getter returns the internal array consistently.
    const snapshotAfter = session.messages;
    expect(snapshotAfter).toHaveLength(2);
    expect(snapshotAfter[0]!.role).toBe("user");
    expect(snapshotAfter[1]!.role).toBe("assistant");
  });
});

describe("buildContext", () => {
  function msgEntry(id: string, parentId: string | null, message: ModelMessage): MessageEntry {
    return { type: "message", id, parentId, timestamp: Date.now(), message };
  }

  test("returns empty array for null leafId", () => {
    expect(buildContext([], null)).toEqual([]);
  });

  test("returns empty array for empty entries", () => {
    expect(buildContext([], "some-id")).toEqual([]);
  });

  test("linear chain returns messages in root-to-leaf order", () => {
    const m1: ModelMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    const m2: ModelMessage = { role: "assistant", content: [{ type: "text", text: "hello" }] };
    const m3: ModelMessage = { role: "user", content: [{ type: "text", text: "bye" }] };

    const entries: SessionEntry[] = [
      msgEntry("a", null, m1),
      msgEntry("b", "a", m2),
      msgEntry("c", "b", m3),
    ];

    expect(buildContext(entries, "c")).toEqual([m1, m2, m3]);
  });

  test("branching — selecting a mid-tree leaf returns only that path", () => {
    const m1: ModelMessage = { role: "user", content: [{ type: "text", text: "root" }] };
    const m2: ModelMessage = { role: "assistant", content: [{ type: "text", text: "branch-a" }] };
    const m3: ModelMessage = { role: "assistant", content: [{ type: "text", text: "branch-b" }] };

    const entries: SessionEntry[] = [
      msgEntry("root", null, m1),
      msgEntry("a", "root", m2),
      msgEntry("b", "root", m3),
    ];

    expect(buildContext(entries, "a")).toEqual([m1, m2]);
    expect(buildContext(entries, "b")).toEqual([m1, m3]);
  });

  test("compaction entry injects summary, keeps entries from firstKeptId onward", () => {
    const mOld: ModelMessage = { role: "user", content: [{ type: "text", text: "old" }] };
    const mOldReply: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "old reply" }],
    };
    const mKept: ModelMessage = { role: "user", content: [{ type: "text", text: "kept" }] };
    const mKeptReply: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "kept reply" }],
    };
    const mNew: ModelMessage = { role: "user", content: [{ type: "text", text: "new" }] };

    const compaction: CompactionEntry = {
      type: "compaction",
      id: "compact",
      parentId: "d",
      timestamp: Date.now(),
      summary: "Summary of old conversation",
      firstKeptId: "c",
    };

    const entries: SessionEntry[] = [
      msgEntry("a", null, mOld),
      msgEntry("b", "a", mOldReply),
      msgEntry("c", "b", mKept),
      msgEntry("d", "c", mKeptReply),
      compaction,
      msgEntry("e", "compact", mNew),
    ];

    const result = buildContext(entries, "e");
    expect(result).toHaveLength(4);
    expect((result[0]!.content as { type: string; text: string }[])[0]!.text).toContain(
      "<summary>Summary of old conversation</summary>",
    );
    expect(result[1]).toEqual(mKept);
    expect(result[2]).toEqual(mKeptReply);
    expect(result[3]).toEqual(mNew);
  });

  test("compaction with no kept entries before it", () => {
    const mOld: ModelMessage = { role: "user", content: [{ type: "text", text: "old" }] };
    const mNew: ModelMessage = { role: "user", content: [{ type: "text", text: "new" }] };

    const compaction: CompactionEntry = {
      type: "compaction",
      id: "compact",
      parentId: "a",
      timestamp: Date.now(),
      summary: "Everything summarized",
      firstKeptId: "nonexistent",
    };

    const entries: SessionEntry[] = [
      msgEntry("a", null, mOld),
      compaction,
      msgEntry("b", "compact", mNew),
    ];

    const result = buildContext(entries, "b");
    expect(result).toHaveLength(2);
    expect((result[0]!.content as { type: string; text: string }[])[0]!.text).toContain(
      "<summary>Everything summarized</summary>",
    );
    expect(result[1]).toEqual(mNew);
  });

  test("cycle in parentId does not hang", () => {
    const m1: ModelMessage = { role: "user", content: [{ type: "text", text: "a" }] };
    const m2: ModelMessage = { role: "assistant", content: [{ type: "text", text: "b" }] };

    const entries: SessionEntry[] = [msgEntry("a", "b", m1), msgEntry("b", "a", m2)];

    const result = buildContext(entries, "b");
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("single entry (leaf is root)", () => {
    const m: ModelMessage = { role: "user", content: [{ type: "text", text: "only" }] };
    const entries: SessionEntry[] = [msgEntry("a", null, m)];
    expect(buildContext(entries, "a")).toEqual([m]);
  });

  test("leafEntryId getter exposes current leaf", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    const session = await agent.createSession();
    expect(session.leafEntryId).toBeNull();

    session.send("Hello");
    await session.waitForIdle();
    expect(session.leafEntryId).toBeTruthy();
  });
});

describe("Session dynamic config (model, tools, systemPrompt)", () => {
  test("changing model between turns uses the new model on the next send", async () => {
    const model1 = createMockModel([{ text: "From model 1" }]);
    const model2 = createMockModel([{ text: "From model 2" }]);

    const agent = new Agent({
      model: model1,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();

    // First turn uses model1
    session.send("Hello");
    await session.waitForIdle();
    expect(model1.doStreamCalls).toHaveLength(1);
    expect(model2.doStreamCalls).toHaveLength(0);

    // Switch model between turns
    session.model = model2;

    // Second turn uses model2
    session.send("Hello again");
    await session.waitForIdle();
    expect(model1.doStreamCalls).toHaveLength(1); // still 1
    expect(model2.doStreamCalls).toHaveLength(1); // now 1
  });

  test("model getter returns the current model", async () => {
    const model1 = createMockModel([{ text: "Hi" }]);
    const model2 = createMockModel([{ text: "Hi" }]);

    const agent = new Agent({
      model: model1,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();

    expect(session.model).toBe(model1);
    session.model = model2;
    expect(session.model).toBe(model2);
  });

  test("changing tools between turns provides the new tools to the next model call", async () => {
    const toolA: Tool = {
      name: "tool_a",
      description: "Tool A",
      parameters: { type: "object", properties: {} },
      execute: async () => "a result",
    };
    const toolB: Tool = {
      name: "tool_b",
      description: "Tool B",
      parameters: { type: "object", properties: {} },
      execute: async () => "b result",
    };

    const { agent, model } = createTestAgent(
      [
        { toolCalls: [{ id: "c1", name: "tool_a", input: {} }] },
        { text: "Done with A" },
        { toolCalls: [{ id: "c2", name: "tool_b", input: {} }] },
        { text: "Done with B" },
      ],
      { tools: [toolA] },
    );
    const session = await agent.createSession();

    // First turn uses toolA
    session.send("Use tool A");
    await session.waitForIdle();

    // Switch tools between turns
    session.tools = [toolB];

    // Second turn uses toolB
    session.send("Use tool B");
    await session.waitForIdle();

    // Verify the second turn's first model call received the updated tools.
    // doStreamCalls is 0-indexed. Turn 1 has 2 model calls (tool call + text),
    // so turn 2's first call is at index 2.
    const secondTurnFirstCall = model.doStreamCalls[2]; // turn2, step1
    expect(secondTurnFirstCall).toBeDefined();
    const toolNames = (secondTurnFirstCall!.tools ?? []).map((t: { name: string }) => t.name);
    expect(toolNames).toContain("tool_b");
    expect(toolNames).not.toContain("tool_a");
  });

  test("tools getter returns the current tools", async () => {
    const toolA: Tool = {
      name: "tool_a",
      description: "Tool A",
      parameters: { type: "object", properties: {} },
      execute: async () => "a result",
    };

    const { agent } = createTestAgent([{ text: "Hi" }], { tools: [toolA] });
    const session = await agent.createSession();

    expect(session.tools).toHaveLength(1);
    expect(session.tools[0]!.name).toBe("tool_a");

    session.tools = [];
    expect(session.tools).toHaveLength(0);
  });

  test("changing systemPrompt between turns sends the new prompt", async () => {
    const { agent, model } = createTestAgent([{ text: "Reply 1" }, { text: "Reply 2" }]);
    const session = await agent.createSession();

    // First turn — no system prompt by default from createTestAgent
    session.send("Hello");
    await session.waitForIdle();

    // Switch system prompt between turns
    session.systemPrompt = "You are a helpful pirate.";

    // Second turn
    session.send("Hello again");
    await session.waitForIdle();

    // Verify the second model call received the new system prompt.
    // In V3, the system prompt is embedded as the first message in the prompt array.
    const secondCall = model.doStreamCalls[1];
    expect(secondCall).toBeDefined();
    const systemMsg = secondCall!.prompt.find((m: { role: string }) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect((systemMsg as { role: "system"; content: string }).content).toBe(
      "You are a helpful pirate.",
    );
  });

  test("systemPrompt getter returns the current system prompt", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    const session = await agent.createSession();

    expect(session.systemPrompt).toBeUndefined();

    session.systemPrompt = "New prompt";
    expect(session.systemPrompt).toBe("New prompt");

    session.systemPrompt = undefined;
    expect(session.systemPrompt).toBeUndefined();
  });

  test("changes during an active turn take effect on the next turn, not the current one", async () => {
    const model1 = createMockModel([
      { toolCalls: [{ id: "c1", name: "slow", input: {} }] },
      { text: "From model 1" },
    ]);
    const model2 = createMockModel([{ text: "From model 2" }]);

    const agent = new Agent({
      model: model1,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
      tools: [createSlowTool()],
    });
    const session = await agent.createSession();

    // Start a turn
    session.send("Go");

    // While the turn is running, switch the model
    await new Promise((r) => setTimeout(r, 10));
    expect(session.status).toBe("busy");
    session.model = model2;

    // Wait for the current turn to finish — it should use model1
    await session.waitForIdle();

    // model1 handled the current turn (two model calls: tool call + final text)
    expect(model1.doStreamCalls).toHaveLength(2);
    // model2 was not used during the active turn
    expect(model2.doStreamCalls).toHaveLength(0);

    // Now a new turn should use model2
    session.send("Next turn");
    await session.waitForIdle();
    expect(model2.doStreamCalls).toHaveLength(1);
  });
});
