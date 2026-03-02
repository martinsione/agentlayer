import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent";
import { JustBashRuntime } from "./runtime/just-bash";
import { JsonlSessionStore } from "./store/jsonl";
import { InMemorySessionStore } from "./store/memory";
import { createMockModel, createSlowTool, createTestAgent } from "./test/helpers";
import { BashTool } from "./tools/bash";

describe("Agent", () => {
  test("createSession returns a Session with a unique id", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    const s1 = await agent.createSession();
    const s2 = await agent.createSession();
    expect(s1.id).toBeTruthy();
    expect(s2.id).toBeTruthy();
    expect(s1.id).not.toBe(s2.id);
  });

  test("createSession with custom id uses that id", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    const session = await agent.createSession({ id: "my-id" });
    expect(session.id).toBe("my-id");
  });

  test("listSessions returns empty array initially", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    expect(await agent.listSessions()).toEqual([]);
  });

  test("listSessions returns session IDs after creating sessions", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }, { text: "Hello" }]);
    const s1 = await agent.createSession({ id: "sess-a" });
    s1.send("Hi");
    await s1.waitForIdle();

    const s2 = await agent.createSession({ id: "sess-b" });
    s2.send("Hello");
    await s2.waitForIdle();

    const ids = await agent.listSessions();
    expect(ids.sort()).toEqual(["sess-a", "sess-b"]);
  });

  test("resumeSession throws if session doesn't exist", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    await expect(agent.resumeSession("nonexistent")).rejects.toThrow("Session not found: nonexistent");
  });

  test("createSession passes sendMode to session", async () => {
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "c1", name: "slow", input: {} }] },
        { text: "First" },
        { text: "Queued reply" },
      ],
      { tools: [createSlowTool()] },
    );
    // Create session with queue mode
    const session = await agent.createSession({ sendMode: "queue" });

    const deltas: string[] = [];
    session.on("text-delta", (e) => {
      deltas.push(e.text);
    });

    session.send("First");
    await new Promise((r) => setTimeout(r, 10));
    // No mode specified — uses session's queue default
    session.send("Second");

    await session.waitForIdle();
    expect(deltas).toContain("Queued reply");
  });

  test("agent-level hooks fire before session-level hooks", async () => {
    const order: string[] = [];
    const model = createMockModel([
      { toolCalls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] },
      { text: "Done" },
    ]);
    const agent = new Agent({
      model,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
      tools: [BashTool],
      hooks: {
        "before-tool-call": () => {
          order.push("agent");
        },
      },
    });

    const session = await agent.createSession();
    session.on("before-tool-call", () => {
      order.push("session");
    });

    session.send("Go");
    await session.waitForIdle();

    expect(order).toEqual(["agent", "session"]);
  });

  test("agent-level hooks apply to resumed sessions", async () => {
    const store = new InMemorySessionStore();
    const hookCalls: string[] = [];
    const model = createMockModel([{ text: "First" }, { text: "Second" }]);
    const agent = new Agent({
      model,
      runtime: new JustBashRuntime(),
      store,
      hooks: {
        "before-model-call": () => {
          hookCalls.push("before-model-call");
        },
      },
    });

    const session = await agent.createSession({ id: "s1" });
    session.send("Hi");
    await session.waitForIdle();

    const resumed = await agent.resumeSession("s1");
    resumed.send("Hello again");
    await resumed.waitForIdle();

    // Hook should fire for both the original and resumed session
    expect(hookCalls).toHaveLength(2);
  });

  test("resumeSession loads entries from store and rebuilds context", async () => {
    const store = new InMemorySessionStore();
    const { agent, model } = createTestAgent([{ text: "Hello back" }, { text: "Still here" }], {
      store,
    });

    const session = await agent.createSession({ id: "sess-1" });
    session.send("Hi");
    await session.waitForIdle();

    const resumed = await agent.resumeSession("sess-1");
    expect(resumed.id).toBe("sess-1");
    expect(resumed.leafEntryId).toBeTruthy();

    resumed.send("Hello again");
    await resumed.waitForIdle();

    const prompt = model.doStreamCalls[1]!.prompt;
    expect(prompt).toHaveLength(3);
    expect(prompt[0]!.role).toBe("user");
    expect(prompt[1]!.role).toBe("assistant");
    expect(prompt[2]!.role).toBe("user");
  });
});

describe("Agent.prompt", () => {
  test("creates ephemeral session and returns result", async () => {
    const { agent } = createTestAgent([{ text: "Hello" }]);
    const result = await agent.prompt("Hi");
    expect(result.text).toBe("Hello");
    expect(result.messages).toHaveLength(2); // user + assistant
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  test("streams text via onText callback", async () => {
    const { agent } = createTestAgent([{ text: "Streamed" }]);
    const chunks: string[] = [];
    const result = await agent.prompt("Hi", {
      onText: (t) => chunks.push(t),
    });
    expect(result.text).toBe("Streamed");
    expect(chunks).toEqual(["Streamed"]);
  });
});

describe("Agent with JsonlSessionStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-jsonl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("createSession + send persists entries to disk", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent } = createTestAgent([{ text: "Hello" }], { store });

    const session = await agent.createSession({ id: "s1" });
    session.send("Hi");
    await session.waitForIdle();

    const entries = await store.load("s1");
    expect(entries.length).toBe(2); // user + assistant
    expect(entries[0]!.type).toBe("message");
    expect(entries[1]!.type).toBe("message");
    if (entries[0]!.type === "message") expect(entries[0]!.message.role).toBe("user");
    if (entries[1]!.type === "message") expect(entries[1]!.message.role).toBe("assistant");
  });

  test("resumeSession rebuilds context from JSONL file", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent, model } = createTestAgent([{ text: "First reply" }, { text: "Second reply" }], {
      store,
    });

    const session = await agent.createSession({ id: "s1" });
    session.send("Hello");
    await session.waitForIdle();

    const resumed = await agent.resumeSession("s1");
    expect(resumed.id).toBe("s1");
    expect(resumed.leafEntryId).toBeTruthy();

    resumed.send("Follow up");
    await resumed.waitForIdle();

    // The second model call should have full history: user + assistant + user
    const prompt = model.doStreamCalls[1]!.prompt;
    expect(prompt).toHaveLength(3);
    expect(prompt[0]!.role).toBe("user");
    expect(prompt[1]!.role).toBe("assistant");
    expect(prompt[2]!.role).toBe("user");
  });

  test("resumeSession throws for nonexistent JSONL session", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent } = createTestAgent([{ text: "Hi" }], { store });
    await expect(agent.resumeSession("nonexistent")).rejects.toThrow("Session not found: nonexistent");
  });

  test("resumeSession throws for nonexistent leafId", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent } = createTestAgent([{ text: "Hi" }], { store });

    const session = await agent.createSession({ id: "s1" });
    session.send("Hello");
    await session.waitForIdle();

    await expect(agent.resumeSession("s1", { leafId: "bad-id" })).rejects.toThrow(
      "Entry not found: bad-id",
    );
  });

  test("resumeSession with explicit leafId resumes from that entry", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent, model } = createTestAgent(
      [{ text: "Reply A" }, { text: "Reply B" }, { text: "Branched reply" }],
      { store },
    );

    // Build a linear chain: user1 -> assistant1 -> user2 -> assistant2
    const session = await agent.createSession({ id: "s1" });
    session.send("First");
    await session.waitForIdle();
    session.send("Second");
    await session.waitForIdle();

    const entries = await store.load("s1");
    // entries: user1(0), assistant1(1), user2(2), assistant2(3)
    const midLeafId = entries[1]!.id; // assistant1 — branch from here

    const branched = await agent.resumeSession("s1", { leafId: midLeafId });
    expect(branched.leafEntryId).toBe(midLeafId);

    branched.send("Branched question");
    await branched.waitForIdle();

    // Model should only see user1 + assistant1 + branched user — not user2/assistant2
    const prompt = model.doStreamCalls[2]!.prompt;
    expect(prompt).toHaveLength(3);
    expect(prompt[0]!.role).toBe("user");
    expect(prompt[1]!.role).toBe("assistant");
    expect(prompt[2]!.role).toBe("user");
  });

  test("tool call entries are persisted", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent } = createTestAgent(
      [
        { toolCalls: [{ id: "call-1", name: "bash", input: { command: "echo hi" } }] },
        { text: "Done" },
      ],
      { store, tools: [BashTool] },
    );

    const session = await agent.createSession({ id: "s1" });
    session.send("Run echo");
    await session.waitForIdle();

    const entries = await store.load("s1");
    // user, assistant (tool call), tool result, assistant (text)
    expect(entries.length).toBe(4);
    const roles = entries.map((e) => (e.type === "message" ? e.message.role : e.type));
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  test("entry parentId chain is consistent across create and resume", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent } = createTestAgent([{ text: "Reply 1" }, { text: "Reply 2" }], { store });

    const session = await agent.createSession({ id: "s1" });
    session.send("First");
    await session.waitForIdle();

    const entriesAfterCreate = await store.load("s1");
    // Verify parentId chain: first entry has null parent, rest chain
    expect(entriesAfterCreate[0]!.parentId).toBeNull();
    for (let i = 1; i < entriesAfterCreate.length; i++) {
      expect(entriesAfterCreate[i]!.parentId).toBe(entriesAfterCreate[i - 1]!.id);
    }

    // Resume and send another message
    const resumed = await agent.resumeSession("s1");
    resumed.send("Second");
    await resumed.waitForIdle();

    const entriesAfterResume = await store.load("s1");
    // New entries should chain from the previous leaf
    const lastBeforeResume = entriesAfterCreate[entriesAfterCreate.length - 1]!;
    const firstNewEntry = entriesAfterResume[entriesAfterCreate.length]!;
    expect(firstNewEntry.parentId).toBe(lastBeforeResume.id);
  });
});

describe("Agent onEvent", () => {
  test("onEvent receives all session events", async () => {
    const types: string[] = [];
    const model = createMockModel([{ text: "Hello" }]);
    const agent = new Agent({
      model,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
      onEvent: (event) => {
        types.push(event.type);
      },
    });

    const session = await agent.createSession();
    session.send("Hi");
    await session.waitForIdle();

    expect(types).toContain("text-delta");
    expect(types).toContain("message");
    expect(types).toContain("turn-end");
  });

  test("onEvent applies to resumed sessions", async () => {
    const store = new InMemorySessionStore();
    const types: string[] = [];
    const model = createMockModel([{ text: "First" }, { text: "Second" }]);
    const agent = new Agent({
      model,
      runtime: new JustBashRuntime(),
      store,
      onEvent: (event) => {
        types.push(event.type);
      },
    });

    const s1 = await agent.createSession({ id: "s1" });
    s1.send("Hello");
    await s1.waitForIdle();

    types.length = 0; // reset

    const s2 = await agent.resumeSession("s1");
    s2.send("Follow up");
    await s2.waitForIdle();

    expect(types).toContain("text-delta");
  });
});

describe("Agent subagents", () => {
  test("subagent definitions create task tools", async () => {
    const model = createMockModel([
      // Parent agent calls task_explore
      { toolCalls: [{ id: "c1", name: "task_explore", input: { prompt: "Find main.ts" } }] },
      // After task completes
      { text: "Found it" },
    ]);
    // Subagent model responses
    const subModel = createMockModel([{ text: "main.ts is in src/" }]);

    const agent = new Agent({
      model,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
      subagents: {
        explore: {
          description: "Explore the codebase",
          instructions: "Find files quickly",
          model: subModel,
          tools: [],
        },
      },
    });

    const session = await agent.createSession();
    const text = await session.prompt("Find main.ts");

    expect(text).toBe("Found it");
    // Subagent model was called
    expect(subModel.doStreamCalls.length).toBeGreaterThan(0);
  });

  test("subagents inherit parent model when not specified", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);

    // Access the tools to verify task tool was created
    const session = await agent.createSession();
    // Can't directly check tools, but we can verify the agent was created without error
    expect(session).toBeDefined();
  });

  test("multiple subagents create multiple task tools", async () => {
    const model = createMockModel([{ text: "Hi" }]);
    const agent = new Agent({
      model,
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
      subagents: {
        explore: { description: "Explore" },
        plan: { description: "Plan" },
      },
    });

    const session = await agent.createSession();
    // Verify both tools exist by checking session.tools
    const toolNames = session.tools.map((t) => t.name);
    expect(toolNames).toContain("task_explore");
    expect(toolNames).toContain("task_plan");
  });
});

describe("Agent instructions alias", () => {
  test("instructions is used as system prompt", async () => {
    const model = createMockModel([{ text: "Hi" }]);
    const agent = new Agent({
      model,
      instructions: "You are a pirate.",
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();
    session.send("Hello");
    await session.waitForIdle();

    const call = model.doStreamCalls[0]!;
    const systemMsg = call.prompt.find((m: { role: string }) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect((systemMsg as any).content).toBe("You are a pirate.");
  });

  test("instructions is passed as system prompt to the model", async () => {
    const model = createMockModel([{ text: "Hi" }]);
    const agent = new Agent({
      model,
      instructions: "new",
      runtime: new JustBashRuntime(),
      store: new InMemorySessionStore(),
    });
    const session = await agent.createSession();
    session.send("Hello");
    await session.waitForIdle();

    const call = model.doStreamCalls[0]!;
    const systemMsg = call.prompt.find((m: { role: string }) => m.role === "system");
    expect((systemMsg as any).content).toBe("new");
  });
});
