import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "../runtime/node";
import { createReadTool } from "./read";

let tmpDir: string;
let tool: ReturnType<typeof createReadTool>;
let ctx: { runtime: NodeRuntime };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agentlayer-read-test-"));
  tool = createReadTool(tmpDir);
  ctx = { runtime: new NodeRuntime({ cwd: tmpDir }) };
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ReadTool", () => {
  test("reads file contents", async () => {
    await writeFile(join(tmpDir, "hello.txt"), "Hello, world!");
    const result = await tool.execute({ path: "hello.txt" }, ctx);
    expect(result as string).toBe("Hello, world!");
  });

  test("reads file with absolute path", async () => {
    const absPath = join(tmpDir, "abs.txt");
    await writeFile(absPath, "absolute content");
    const result = await tool.execute({ path: absPath }, ctx);
    expect(result as string).toBe("absolute content");
  });

  test("truncates output exceeding 100KB", async () => {
    const largeContent = "x".repeat(150 * 1024);
    await writeFile(join(tmpDir, "large.txt"), largeContent);
    const result = (await tool.execute({ path: "large.txt" }, ctx)) as string;
    expect(result).toContain("[Output truncated:");
    expect(result).toContain("showing first 100KB");
  });

  test("throws on non-existent file", async () => {
    expect(tool.execute({ path: "nonexistent.txt" }, ctx)).rejects.toThrow();
  });
});
