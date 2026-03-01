import { describe, expect, test } from "bun:test";
import { makeEntry } from "../test/helpers";
import { InMemorySessionStore } from "./memory";

describe("InMemorySessionStore", () => {
  test("load returns empty array for unknown session", async () => {
    const store = new InMemorySessionStore();
    const entries = await store.load("nonexistent");
    expect(entries).toEqual([]);
  });

  test("append + load round-trip", async () => {
    const store = new InMemorySessionStore();
    const entry = makeEntry();
    await store.append("s1", entry);
    const loaded = await store.load("s1");
    expect(loaded).toEqual([entry]);
  });

  test("exists returns false for unknown, true after append", async () => {
    const store = new InMemorySessionStore();
    expect(await store.exists("s1")).toBe(false);
    await store.append("s1", makeEntry());
    expect(await store.exists("s1")).toBe(true);
  });

  test("list returns empty array initially", async () => {
    const store = new InMemorySessionStore();
    expect(await store.list()).toEqual([]);
  });

  test("list returns session IDs after appending", async () => {
    const store = new InMemorySessionStore();
    await store.append("s1", makeEntry());
    await store.append("s2", makeEntry());
    const ids = await store.list();
    expect(ids.sort()).toEqual(["s1", "s2"]);
  });

  test("list does not duplicate IDs for multiple entries in the same session", async () => {
    const store = new InMemorySessionStore();
    const e1 = makeEntry();
    const e2 = makeEntry({ parentId: e1.id });
    await store.append("s1", e1);
    await store.append("s1", e2);
    expect(await store.list()).toEqual(["s1"]);
  });

  test("load returns a copy — mutations do not affect the store", async () => {
    const store = new InMemorySessionStore();
    const entry = makeEntry();
    await store.append("s1", entry);

    const first = await store.load("s1");
    first.push(makeEntry());

    const second = await store.load("s1");
    expect(second).toHaveLength(1);
    expect(second).toEqual([entry]);
  });
});
