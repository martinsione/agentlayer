import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "../runtime/node";
import { createWriteTool } from "./write";

let tmpDir: string;
let tool: ReturnType<typeof createWriteTool>;
let ctx: { runtime: NodeRuntime };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agentlayer-write-test-"));
  tool = createWriteTool(tmpDir);
  ctx = { runtime: new NodeRuntime({ cwd: tmpDir }) };
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("WriteTool", () => {
  test("writes content to a file", async () => {
    const result = (await tool.execute({ path: "out.txt", content: "hello" }, ctx)) as string;
    expect(result).toContain("Wrote 5 bytes to");
    expect(result).toContain("out.txt");

    const written = await readFile(join(tmpDir, "out.txt"), "utf-8");
    expect(written).toBe("hello");
  });

  test("creates parent directories as needed", async () => {
    const result = (await tool.execute(
      { path: "nested/dir/file.txt", content: "nested content" },
      ctx,
    )) as string;
    expect(result).toContain("Wrote");
    expect(result).toContain("nested/dir/file.txt");

    const written = await readFile(join(tmpDir, "nested/dir/file.txt"), "utf-8");
    expect(written).toBe("nested content");
  });

  test("reports correct byte count for multi-byte content", async () => {
    const content = "Hello, \u{1F600}!"; // emoji is 4 bytes
    const result = (await tool.execute({ path: "emoji.txt", content }, ctx)) as string;
    const expectedBytes = Buffer.byteLength(content, "utf-8");
    expect(result).toContain(`Wrote ${expectedBytes} bytes to`);
  });

  test("writes with absolute path", async () => {
    const absPath = join(tmpDir, "absolute.txt");
    const result = (await tool.execute({ path: absPath, content: "abs" }, ctx)) as string;
    expect(result).toContain(absPath);

    const written = await readFile(absPath, "utf-8");
    expect(written).toBe("abs");
  });
});
