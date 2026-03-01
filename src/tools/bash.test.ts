import { describe, expect, test } from "bun:test";
import { BashTool } from "./bash";

// Note: the bash tool spawns processes directly (does not use Runtime)
const ctx = { runtime: {} as any };

describe("BashTool", () => {
  test("returns stdout for successful command", async () => {
    const result = await BashTool.execute({ command: "echo hello" }, ctx);
    expect(result.trim()).toBe("hello");
  });

  test('returns "(no output)" when command produces nothing', async () => {
    const result = await BashTool.execute({ command: "true" }, ctx);
    expect(result).toBe("(no output)");
  });

  test("includes stderr in output", async () => {
    const result = await BashTool.execute({ command: "echo err >&2" }, ctx);
    expect(result).toContain("err");
  });

  test("throws on non-zero exit code", async () => {
    expect(BashTool.execute({ command: "exit 42" }, ctx)).rejects.toThrow(
      "Command exited with code 42",
    );
  });

  test("throws on timeout", async () => {
    expect(BashTool.execute({ command: "sleep 10", timeout: 1 }, ctx)).rejects.toThrow(
      "Command timed out after 1 seconds",
    );
  });
});
