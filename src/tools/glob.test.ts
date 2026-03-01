import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "../runtime/node";
import { createGlobTool } from "./glob";

let tmpDir: string;
let tool: ReturnType<typeof createGlobTool>;
let ctx: { runtime: NodeRuntime };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agentlayer-glob-test-"));
  tool = createGlobTool(tmpDir);
  ctx = { runtime: new NodeRuntime({ cwd: tmpDir }) };

  // Set up test file structure
  await mkdir(join(tmpDir, "src"), { recursive: true });
  await mkdir(join(tmpDir, "src/utils"), { recursive: true });
  await writeFile(join(tmpDir, "src/index.ts"), "export {};");
  await writeFile(join(tmpDir, "src/utils/helper.ts"), "export {};");
  await writeFile(join(tmpDir, "src/utils/helper.js"), "module.exports = {};");
  await writeFile(join(tmpDir, "README.md"), "# Test");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GlobTool", () => {
  test("finds files with simple pattern", async () => {
    const result = (await tool.execute({ pattern: "**/*.ts" }, ctx)) as string;
    expect(result).toContain("index.ts");
    expect(result).toContain("helper.ts");
    expect(result).not.toContain("helper.js");
  });

  test("finds files in specific directory via cwd param", async () => {
    const result = (await tool.execute({ pattern: "*.ts", cwd: "src/utils" }, ctx)) as string;
    expect(result).toContain("helper.ts");
    expect(result).not.toContain("index.ts");
  });

  test("returns message when no files match", async () => {
    const result = (await tool.execute({ pattern: "**/*.xyz" }, ctx)) as string;
    expect(result).toBe("No files matched the pattern.");
  });

  test("finds markdown files", async () => {
    const result = (await tool.execute({ pattern: "*.md" }, ctx)) as string;
    expect(result).toContain("README.md");
  });
});
