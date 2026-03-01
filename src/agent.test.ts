import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "./store/jsonl";
import { InMemorySessionStore } from "./store/memory";
import { createSlowTool, createTestAgent } from "./test/helpers";
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

  test("resumeSession throws if session doesn't exist", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    expect(agent.resumeSession("nonexistent")).rejects.toThrow("Session not found: nonexistent");
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
    session.on("text_delta", (e) => {
      deltas.push(e.delta);
    });

    session.send("First");
    await new Promise((r) => setTimeout(r, 10));
    // No mode specified — uses session's queue default
    session.send("Second");

    await session.waitForIdle();
    expect(deltas).toContain("Queued reply");
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
    expect(agent.resumeSession("nonexistent")).rejects.toThrow("Session not found: nonexistent");
  });

  test("resumeSession throws for nonexistent leafId", async () => {
    const store = new JsonlSessionStore(dir);
    const { agent } = createTestAgent([{ text: "Hi" }], { store });

    const session = await agent.createSession({ id: "s1" });
    session.send("Hello");
    await session.waitForIdle();

    expect(agent.resumeSession("s1", { leafId: "bad-id" })).rejects.toThrow(
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
