import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime } from "../runtime/node";
import { createEditTool, EditTool } from "./edit";

let tmpDir: string;
let tool: ReturnType<typeof createEditTool>;
let ctx: { runtime: NodeRuntime };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agentlayer-edit-test-"));
  tool = createEditTool(tmpDir);
  ctx = { runtime: new NodeRuntime({ cwd: tmpDir }) };
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("EditTool", () => {
  test("exact string replacement", async () => {
    const file = join(tmpDir, "exact.txt");
    await writeFile(file, "hello world");
    const result = (await tool.execute(
      { path: file, old_string: "hello", new_string: "goodbye" },
      ctx,
    )) as string;
    expect(result).toContain("Edited");
    const content = await ctx.runtime.readFile(file);
    expect(content).toBe("goodbye world");
  });

  test("replaces only first occurrence by default", async () => {
    const file = join(tmpDir, "first-only.txt");
    await writeFile(file, "aaa bbb aaa");
    await tool.execute({ path: file, old_string: "aaa", new_string: "ccc" }, ctx);
    const content = await ctx.runtime.readFile(file);
    expect(content).toBe("ccc bbb aaa");
  });

  test("replace_all replaces all occurrences", async () => {
    const file = join(tmpDir, "replace-all.txt");
    await writeFile(file, "aaa bbb aaa");
    const result = (await tool.execute(
      { path: file, old_string: "aaa", new_string: "ccc", replace_all: true },
      ctx,
    )) as string;
    expect(result).toContain("2 replacements");
    const content = await ctx.runtime.readFile(file);
    expect(content).toBe("ccc bbb ccc");
  });

  test("fuzzy match with whitespace trimming", async () => {
    const file = join(tmpDir, "fuzzy-trim.ts");
    await writeFile(file, "  function hello() {\n    return 1;\n  }");
    // LLM sends without leading spaces
    await tool.execute(
      {
        path: file,
        old_string: "function hello() {\n  return 1;\n}",
        new_string: "function hello() {\n    return 2;\n  }",
      },
      ctx,
    );
    const content = await ctx.runtime.readFile(file);
    expect(content).toContain("return 2");
  });

  test("fuzzy match with indentation differences", async () => {
    const file = join(tmpDir, "fuzzy-indent.ts");
    await writeFile(file, "    if (true) {\n        console.log('yes');\n    }");
    // LLM sends with different indentation
    await tool.execute(
      {
        path: file,
        old_string: "if (true) {\n    console.log('yes');\n}",
        new_string: "    if (false) {\n        console.log('no');\n    }",
      },
      ctx,
    );
    const content = await ctx.runtime.readFile(file);
    expect(content).toContain("console.log('no')");
  });

  test("throws when old_string not found", async () => {
    const file = join(tmpDir, "notfound.txt");
    await writeFile(file, "hello world");
    await expect(
      tool.execute({ path: file, old_string: "nonexistent", new_string: "new" }, ctx),
    ).rejects.toThrow("Could not find");
  });

  test("identical old and new returns no-op message", async () => {
    const file = join(tmpDir, "noop.txt");
    await writeFile(file, "hello world");
    const result = (await tool.execute(
      { path: file, old_string: "hello", new_string: "hello" },
      ctx,
    )) as string;
    expect(result).toContain("No changes needed");
  });

  test("multiline replacement", async () => {
    const file = join(tmpDir, "multiline.ts");
    await writeFile(file, "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}");
    await tool.execute(
      {
        path: file,
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function foo() {\n  return 42;\n}",
      },
      ctx,
    );
    const content = await ctx.runtime.readFile(file);
    expect(content).toContain("return 42");
    expect(content).toContain("return 2"); // bar untouched
  });

  test("works with relative paths", async () => {
    await writeFile(join(tmpDir, "relative.txt"), "old text here");
    const result = (await tool.execute(
      { path: "relative.txt", old_string: "old text", new_string: "new text" },
      ctx,
    )) as string;
    expect(result).toContain("Edited");
    const content = await ctx.runtime.readFile(join(tmpDir, "relative.txt"));
    expect(content).toBe("new text here");
  });

  test("default EditTool resolves paths against ctx.runtime.cwd", async () => {
    const file = join(tmpDir, "runtime-cwd.txt");
    await writeFile(file, "before edit");
    const runtimeCtx = { runtime: new NodeRuntime({ cwd: tmpDir }) };
    const result = (await EditTool.execute(
      { path: "runtime-cwd.txt", old_string: "before", new_string: "after" },
      runtimeCtx,
    )) as string;
    expect(result).toContain("Edited");
    const content = await runtimeCtx.runtime.readFile(file);
    expect(content).toBe("after edit");
  });

  test("throws on non-existent file", async () => {
    await expect(
      tool.execute({ path: "does-not-exist.txt", old_string: "a", new_string: "b" }, ctx),
    ).rejects.toThrow();
  });

  test("throws when old_string is empty", async () => {
    const file = join(tmpDir, "empty-old.txt");
    await writeFile(file, "hello world");
    await expect(
      tool.execute({ path: file, old_string: "", new_string: "prepend" }, ctx),
    ).rejects.toThrow("old_string must not be empty");
  });

  test("throws when old_string is empty with replace_all", async () => {
    const file = join(tmpDir, "empty-old-all.txt");
    await writeFile(file, "hello world");
    await expect(
      tool.execute({ path: file, old_string: "", new_string: "X", replace_all: true }, ctx),
    ).rejects.toThrow("old_string must not be empty");
  });

  test("throws when replace_all finds no matches", async () => {
    const file = join(tmpDir, "replace-all-no-match.txt");
    await writeFile(file, "hello world");
    await expect(
      tool.execute(
        { path: file, old_string: "nonexistent", new_string: "new", replace_all: true },
        ctx,
      ),
    ).rejects.toThrow("Could not find");
  });
});
