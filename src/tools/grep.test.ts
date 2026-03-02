import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "../runtime/node";
import { createGrepTool } from "./grep";

let tmpDir: string;
let tool: ReturnType<typeof createGrepTool>;
let ctx: { runtime: NodeRuntime };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agentlayer-grep-test-"));
  tool = createGrepTool(tmpDir);
  ctx = { runtime: new NodeRuntime({ cwd: tmpDir }) };

  // Set up test files
  await mkdir(join(tmpDir, "src"), { recursive: true });
  await writeFile(
    join(tmpDir, "src/app.ts"),
    'const greeting = "hello world";\nconsole.log(greeting);\n',
  );
  await writeFile(join(tmpDir, "src/utils.ts"), 'export function hello() { return "hi"; }\n');
  await writeFile(join(tmpDir, "src/data.json"), '{"name": "test"}\n');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GrepTool", () => {
  test("finds pattern in files", async () => {
    const result = (await tool.execute({ pattern: "hello" }, ctx)) as string;
    expect(result).toContain("app.ts");
    expect(result).toContain("utils.ts");
    expect(result).toContain("hello");
  });

  test("searches in specific path", async () => {
    const result = (await tool.execute({ pattern: "greeting", path: "src/app.ts" }, ctx)) as string;
    expect(result).toContain("greeting");
    expect(result).not.toContain("utils.ts");
  });

  test("filters by glob pattern", async () => {
    const result = (await tool.execute({ pattern: "hello", glob: "*.ts" }, ctx)) as string;
    expect(result).toContain("hello");
    // Should only match .ts files
    expect(result).not.toContain("data.json");
  });

  test("returns message when no matches found", async () => {
    const result = (await tool.execute({ pattern: "nonexistent_string_xyz" }, ctx)) as string;
    expect(result).toBe("No matches found.");
  });

  test("handles single quotes in pattern without shell injection", async () => {
    // A pattern containing single quotes should be safely escaped, not cause injection
    const result = (await tool.execute({ pattern: "it's" }, ctx)) as string;
    // Should simply find no matches (our test files don't contain "it's")
    expect(result).toBe("No matches found.");
  });

  test("handles single quotes in glob without shell injection", async () => {
    const result = (await tool.execute({ pattern: "hello", glob: "*.t's" }, ctx)) as string;
    expect(result).toBe("No matches found.");
  });
});
