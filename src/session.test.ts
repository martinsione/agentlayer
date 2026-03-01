import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { Agent } from "./agent";
import { JustBashRuntime } from "./runtime/just-bash";
import { InMemorySessionStore } from "./store/memory";
import { createFailingModel, createTestAgent } from "./test/helpers";
import { BashTool } from "./tools/bash";

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

    await session.send("Hi");

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

    await session.send("Message 1");
    await session.send("Message 2");

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

    await session.send("Run echo");

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

    await session.send("Do something dangerous");

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
      await session.send("Hi");
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

    await session.send("Run something");

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

    await session.send("First");
    session.off("text_delta", listener);
    await session.send("Second");

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

    await session.send("Go");

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.isError).toBe(true);
    expect(toolResults[0]!.result).toBe("first wins");
  });
});
