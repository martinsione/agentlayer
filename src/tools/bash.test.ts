import { describe, expect, test } from "bun:test";
import { RuntimeAbortError, RuntimeTimeoutError } from "../errors";
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
    await expect(BashTool.execute({ command: "exit 42" }, ctx)).rejects.toThrow(
      "Command exited with code 42",
    );
  });

  test("throws on timeout", async () => {
    await expect(BashTool.execute({ command: "sleep 10", timeout: 1 }, ctx)).rejects.toThrow(
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

// ---------------------------------------------------------------------------
// Tests for DOMException-style errors from custom Runtime implementations
// (e.g. VercelSandboxRuntime, JustBashRuntime use AbortSignal.timeout())
// ---------------------------------------------------------------------------
describe("BashTool with DOMException-style errors", () => {
  /** Create a Runtime whose exec() feeds partial output then throws. */
  function createThrowingRuntime(errorToThrow: Error): Runtime {
    return {
      cwd: "/tmp",
      async exec(_cmd: string, opts?: ExecOptions) {
        if (opts?.onData) opts.onData(Buffer.from("partial output"));
        throw errorToThrow;
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
  }

  test("handles standard AbortError (DOMException)", async () => {
    const runtime = createThrowingRuntime(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    await expect(BashTool.execute({ command: "test" }, { runtime })).rejects.toThrow(
      "Command aborted",
    );
  });

  test("handles standard TimeoutError (DOMException)", async () => {
    const runtime = createThrowingRuntime(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    await expect(BashTool.execute({ command: "test", timeout: 5 }, { runtime })).rejects.toThrow(
      "Command timed out after 5 seconds",
    );
  });

  test("TimeoutError without user-supplied timeout shows 'unknown'", async () => {
    const runtime = createThrowingRuntime(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    await expect(BashTool.execute({ command: "test" }, { runtime })).rejects.toThrow(
      "Command timed out after unknown seconds",
    );
  });

  test("includes partial output with DOMException AbortError", async () => {
    const runtime = createThrowingRuntime(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    try {
      await BashTool.execute({ command: "test" }, { runtime });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("partial output");
      expect(err.message).toContain("Command aborted");
    }
  });

  test("includes partial output with DOMException TimeoutError", async () => {
    const runtime = createThrowingRuntime(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    try {
      await BashTool.execute({ command: "test", timeout: 3 }, { runtime });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("partial output");
      expect(err.message).toContain("Command timed out after 3 seconds");
    }
  });
});

// ---------------------------------------------------------------------------
// Typed runtime errors (RuntimeAbortError / RuntimeTimeoutError)
// ---------------------------------------------------------------------------
describe("BashTool with typed runtime errors", () => {
  function createThrowingRuntime(errorToThrow: Error): Runtime {
    return {
      cwd: "/tmp",
      async exec(_cmd: string, opts?: ExecOptions) {
        if (opts?.onData) opts.onData(Buffer.from("partial output"));
        throw errorToThrow;
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
  }

  test("RuntimeAbortError produces 'Command aborted'", async () => {
    const runtime = createThrowingRuntime(new RuntimeAbortError());
    await expect(BashTool.execute({ command: "test" }, { runtime })).rejects.toThrow(
      "Command aborted",
    );
  });

  test("RuntimeTimeoutError uses timeoutSecs field", async () => {
    const runtime = createThrowingRuntime(new RuntimeTimeoutError(42));
    await expect(BashTool.execute({ command: "test", timeout: 99 }, { runtime })).rejects.toThrow(
      "Command timed out after 42 seconds",
    );
  });

  test("RuntimeTimeoutError includes partial output", async () => {
    const runtime = createThrowingRuntime(new RuntimeTimeoutError(10));
    try {
      await BashTool.execute({ command: "test" }, { runtime });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("partial output");
      expect(err.message).toContain("Command timed out after 10 seconds");
    }
  });
});
