import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { InMemorySessionStore } from "./memory";

describe("InMemorySessionStore", () => {
  test("load returns empty array for unknown session", async () => {
    const store = new InMemorySessionStore();
    const messages = await store.load("nonexistent");
    expect(messages).toEqual([]);
  });

  test("append + load round-trip", async () => {
    const store = new InMemorySessionStore();
    const msg: ModelMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
    await store.append("s1", msg);
    const loaded = await store.load("s1");
    expect(loaded).toEqual([msg]);
  });

  test("exists returns false for unknown, true after append", async () => {
    const store = new InMemorySessionStore();
    expect(await store.exists("s1")).toBe(false);
    await store.append("s1", { role: "user", content: [{ type: "text", text: "hi" }] });
    expect(await store.exists("s1")).toBe(true);
  });

  test("load returns a copy — mutations do not affect the store", async () => {
    const store = new InMemorySessionStore();
    const msg: ModelMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
    await store.append("s1", msg);

    const first = await store.load("s1");
    first.push({ role: "assistant", content: [{ type: "text", text: "injected" }] });

    const second = await store.load("s1");
    expect(second).toHaveLength(1);
    expect(second).toEqual([msg]);
  });
});
