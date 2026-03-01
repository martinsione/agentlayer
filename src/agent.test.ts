import { describe, expect, test } from "bun:test";
import { InMemorySessionStore } from "./store/memory";
import { createTestAgent } from "./test/helpers";

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
    const session = await agent.createSession("my-id");
    expect(session.id).toBe("my-id");
  });

  test("resumeSession throws if session doesn't exist", async () => {
    const { agent } = createTestAgent([{ text: "Hi" }]);
    expect(agent.resumeSession("nonexistent")).rejects.toThrow("Session not found: nonexistent");
  });

  test("resumeSession loads messages from store", async () => {
    const store = new InMemorySessionStore();
    const { agent, model } = createTestAgent([{ text: "Hello back" }, { text: "Still here" }], {
      store,
    });

    const session = await agent.createSession("sess-1");
    await session.send("Hi");

    const resumed = await agent.resumeSession("sess-1");
    expect(resumed.id).toBe("sess-1");

    await resumed.send("Hello again");

    const prompt = model.doStreamCalls[1]!.prompt;
    expect(prompt).toHaveLength(3);
    expect(prompt[0]!.role).toBe("user");
    expect(prompt[1]!.role).toBe("assistant");
    expect(prompt[2]!.role).toBe("user");
  });
});
