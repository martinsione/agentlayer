import { describe, expect, test } from "bun:test";
import { NodeRuntime } from "../runtime/node";
import type { Runtime, ExecOptions } from "../types";
import { BashTool, createBashTool } from "./bash";

const ctx = { runtime: new NodeRuntime() };

function createMockRuntime(onExec?: (opts?: ExecOptions) => void): Runtime {
  return {
    cwd: "/mock/sandbox/dir",
    async exec(_cmd: string, opts?: ExecOptions) {
      onExec?.(opts);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
}

describe("BashTool", () => {
  test("returns stdout for successful command", async () => {
    const result = await BashTool.execute({ command: "echo hello" }, ctx);
    expect((result as string).trim()).toBe("hello");
  });

  test('returns "(no output)" when command produces nothing', async () => {
    const result = await BashTool.execute({ command: "true" }, ctx);
    expect(result as string).toBe("(no output)");
  });

  test("includes stderr in output", async () => {
    const result = await BashTool.execute({ command: "echo err >&2" }, ctx);
    expect(result as string).toContain("err");
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

  test("default BashTool uses ctx.runtime.cwd, not process.cwd()", async () => {
    let capturedCwd: string | undefined;
    const mock = createMockRuntime((opts) => {
      capturedCwd = opts?.cwd;
    });

    await BashTool.execute({ command: "echo hi" }, { runtime: mock });
    expect(capturedCwd).toBe("/mock/sandbox/dir");
  });

  test("createBashTool with explicit cwd overrides runtime.cwd", async () => {
    let capturedCwd: string | undefined;
    const mock = createMockRuntime((opts) => {
      capturedCwd = opts?.cwd;
    });

    const tool = createBashTool("/explicit/dir");
    await tool.execute({ command: "echo hi" }, { runtime: mock });
    expect(capturedCwd).toBe("/explicit/dir");
  });
});
