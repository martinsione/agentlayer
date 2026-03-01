import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEntry } from "../test/helpers";
import { JsonlSessionStore } from "./jsonl";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonl-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonlSessionStore", () => {
  test("load returns empty array for unknown session", async () => {
    const store = new JsonlSessionStore(dir);
    const entries = await store.load("nonexistent");
    expect(entries).toEqual([]);
  });

  test("append + load round-trip", async () => {
    const store = new JsonlSessionStore(dir);
    const entry = makeEntry();
    await store.append("s1", entry);
    const loaded = await store.load("s1");
    expect(loaded).toEqual([entry]);
  });

  test("multiple appends produce multiple lines", async () => {
    const store = new JsonlSessionStore(dir);
    const e1 = makeEntry();
    const e2 = makeEntry({ parentId: e1.id });
    await store.append("s1", e1);
    await store.append("s1", e2);
    const loaded = await store.load("s1");
    expect(loaded).toEqual([e1, e2]);
  });

  test("exists returns false for unknown, true after append", async () => {
    const store = new JsonlSessionStore(dir);
    expect(await store.exists("s1")).toBe(false);
    await store.append("s1", makeEntry());
    expect(await store.exists("s1")).toBe(true);
  });

  test("sessions are isolated by id", async () => {
    const store = new JsonlSessionStore(dir);
    const e1 = makeEntry();
    const e2 = makeEntry();
    await store.append("s1", e1);
    await store.append("s2", e2);
    expect(await store.load("s1")).toEqual([e1]);
    expect(await store.load("s2")).toEqual([e2]);
  });

  test("creates directory if it does not exist", async () => {
    const nestedDir = join(dir, "nested", "deep");
    const store = new JsonlSessionStore(nestedDir);
    const entry = makeEntry();
    await store.append("s1", entry);
    const loaded = await store.load("s1");
    expect(loaded).toEqual([entry]);
  });

  test("load skips malformed lines", async () => {
    const store = new JsonlSessionStore(dir);
    const entry = makeEntry();
    await store.append("s1", entry);
    // Manually append a corrupted line
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "s1.jsonl"), "not-json\n");
    await store.append("s1", entry);

    const loaded = await store.load("s1");
    expect(loaded).toEqual([entry, entry]);
  });
});
