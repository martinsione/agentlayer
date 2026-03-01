import { describe, expect, test } from "bun:test";
import { JustBashRuntime } from "../runtime/just-bash";
import { BashTool } from "./bash";

const runtime = new JustBashRuntime();

describe("BashTool", () => {
  test("returns stdout for successful command", async () => {
    const result = await BashTool.execute({ command: "echo hello" }, { runtime });
    expect(result).toBe("hello\n");
  });

  test('returns "(no output)" when command produces nothing', async () => {
    const result = await BashTool.execute({ command: "true" }, { runtime });
    expect(result).toBe("(no output)");
  });

  test("formats stderr with prefix", async () => {
    const result = await BashTool.execute({ command: "echo err >&2" }, { runtime });
    expect(result).toContain("[stderr]");
    expect(result).toContain("err");
  });

  test("appends exit code for non-zero exits", async () => {
    const result = await BashTool.execute({ command: "exit 42" }, { runtime });
    expect(result).toContain("[exit code: 42]");
  });
});
