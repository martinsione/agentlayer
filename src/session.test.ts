import { describe, expect, test } from "bun:test";
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
} from "./test/helpers";
import { BashTool } from "./tools/bash";
import type { MessageEntry, CompactionEntry, SessionEntry } from "./types";

describe("Session.send", () => {
  test("text-only response", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const session = await agent.createSession();

    const messages: ModelMessage[] = [];
    const deltas: string[] = [];
    const steps: { usage: { input: number; output: number }; finishReason: string }[] = [];
    let turnEnd: { messages: ModelMessage[]; text: string } | undefined;

    session.on("message", (e) => {
      messages.push(e.message);
    });
    session.on("text_delta", (e) => {
      deltas.push(e.delta);
    });
    session.on("step", (e) => {
      steps.push(e);
    });
    session.on("turn_end", (e) => {
      turnEnd = e;
    });

    session.send("Hi");
    await session.waitForIdle();

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");

    expect(deltas).toEqual(["Hello"]);

    expect(steps).toHaveLength(1);
    expect(steps[0]!.finishReason).toBe("stop");

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

    const toolCalls: { callId: string; name: string; args: Record<string, unknown> }[] = [];
    const toolResults: { callId: string; name: string; result: string; isError: boolean }[] = [];
    let turnEndText = "";

    session.on("tool_call", (e) => {
      toolCalls.push(e);
    });
    session.on("tool_result", (e) => {
      toolResults.push(e);
    });
    session.on("turn_end", (e) => {
      turnEndText = e.text;
    });

    session.send("Run echo");
    await session.waitForIdle();

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({ callId: "call-1", name: "bash", args: { command: "echo hi" } });

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.callId).toBe("call-1");
    expect(toolResults[0]!.result).toBe("hi\n");
    expect(toolResults[0]!.isError).toBe(false);

    expect(turnEndText).toBe("Done");
  });

  test("tool call denied", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "rm -rf /" } }] },
        { text: "OK" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const toolResults: { result: string; isError: boolean }[] = [];
    session.on("tool_call", () => ({ deny: "blocked" }));
    session.on("tool_result", (e) => {
      toolResults.push({ result: e.result, isError: e.isError });
    });

    session.send("Do something dangerous");
    await session.waitForIdle();

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.isError).toBe(true);
    expect(toolResults[0]!.result).toBe("blocked");
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

  test("tool call args override", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "echo original" } }] },
        { text: "Done" },
      ],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const toolResults: { result: string; isError: boolean }[] = [];
    session.on("tool_call", () => ({ args: { command: "echo overridden" } }));
    session.on("tool_result", (e) => {
      toolResults.push({ result: e.result, isError: e.isError });
    });

    session.send("Run something");
    await session.waitForIdle();

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.result).toBe("overridden\n");
    expect(toolResults[0]!.isError).toBe(false);
  });

  test("off removes a listener", async () => {
    const { agent } = createTestAgent([{ text: "A" }, { text: "B" }]);
    const session = await agent.createSession();

    const deltas: string[] = [];
    const listener = (e: { delta: string }) => {
      deltas.push(e.delta);
    };
    session.on("text_delta", listener);

    session.send("First");
    await session.waitForIdle();
    session.off("text_delta", listener);
    session.send("Second");
    await session.waitForIdle();

    expect(deltas).toEqual(["A"]);
  });

  test("first tool_call listener to return a decision wins", async () => {
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "bash", input: { command: "echo 1" } }] }, { text: "Done" }],
      { tools: [BashTool] },
    );
    const session = await agent.createSession();

    const toolResults: { result: string; isError: boolean }[] = [];
    session.on("tool_result", (e) => {
      toolResults.push({ result: e.result, isError: e.isError });
    });

    session.on("tool_call", () => ({ deny: "first wins" }));
    session.on("tool_call", () => undefined);

    session.send("Go");
    await session.waitForIdle();

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.isError).toBe(true);
    expect(toolResults[0]!.result).toBe("first wins");
  });
});

describe("Session.send modes", () => {
  test("send() while running with mode: steer injects before next model turn", async () => {
    // Response 1: tool call (slow tool gives us time to inject steer)
    // Response 2: text after steering injected
    const { agent } = createTestAgent(
      [{ toolCalls: [{ id: "c1", name: "slow", input: {} }] }, { text: "Steered response" }],
      {
        tools: [createSlowTool()],
      },
    );
    const session = await agent.createSession();

    const allMessages: ModelMessage[] = [];
    session.on("message", (e) => {
      allMessages.push(e.message);
    });

    // Start the loop
    session.send("First message");

    // Wait a tick for the loop to start, then steer
    await new Promise((r) => setTimeout(r, 10));
    session.send("Steer message", { mode: "steer" });

    await session.waitForIdle();

    // Should have: user1, assistant1 (tool call), user2 (steer), assistant2 (steered response)
    const userMessages = allMessages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);

    const assistantMessages = allMessages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
  });

  test("send() while running with mode: queue processes after current turn", async () => {
    // Response 1: text (would normally end the turn)
    // Response 2: text (after queued message processed)
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
    session.on("text_delta", (e) => {
      deltas.push(e.delta);
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
    session.on("text_delta", (e) => {
      deltas.push(e.delta);
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
    session.on("text_delta", (e) => {
      deltas.push(e.delta);
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
    session.on("text_delta", (e) => {
      deltas.push(e.delta);
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
    // a(old) -> b(old reply) -> c(kept) -> d(kept reply) -> compaction -> e(new)
    // firstKeptId = "c" means: summarize a+b, keep c+d, then everything after compaction
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
    // summary + kept + kept reply + new
    expect(result).toHaveLength(4);
    expect((result[0]!.content as { type: string; text: string }[])[0]!.text).toContain(
      "<summary>Summary of old conversation</summary>",
    );
    expect(result[1]).toEqual(mKept);
    expect(result[2]).toEqual(mKeptReply);
    expect(result[3]).toEqual(mNew);
  });

  test("compaction with no kept entries before it", () => {
    // All entries before compaction are summarized (firstKeptId doesn't match any)
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
    // summary + new (old is fully summarized)
    expect(result).toHaveLength(2);
    expect((result[0]!.content as { type: string; text: string }[])[0]!.text).toContain(
      "<summary>Everything summarized</summary>",
    );
    expect(result[1]).toEqual(mNew);
  });

  test("cycle in parentId does not hang", () => {
    const m1: ModelMessage = { role: "user", content: [{ type: "text", text: "a" }] };
    const m2: ModelMessage = { role: "assistant", content: [{ type: "text", text: "b" }] };

    // a -> b -> a (cycle)
    const entries: SessionEntry[] = [msgEntry("a", "b", m1), msgEntry("b", "a", m2)];

    const result = buildContext(entries, "b");
    // Should terminate and return whatever partial path it walked
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
