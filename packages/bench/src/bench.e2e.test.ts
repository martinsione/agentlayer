import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

const packageRoot = resolve(import.meta.dir, "..");

describe("bench e2e", () => {
  it("runs end-to-end with Codex JSON protocol output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "codex-bench-success-"));
    const mockCodexPath = join(tempDir, "codex-mock-success.sh");

    await writeFile(
      mockCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        'echo \'{"type":"thread.started","thread_id":"thread-e2e-success"}\'',
        'echo \'{"type":"item.completed","item":{"id":"agent-1","type":"agent_message","text":"bench ok"}}\'',
        'echo \'{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":1,"output_tokens":2}}\'',
      ].join("\n"),
    );
    await chmod(mockCodexPath, 0o755);

    try {
      const result = await runBenchProcess(["--timeout-ms", "4000", "Return bench ok"], {
        CODEX_PATH_OVERRIDE: mockCodexPath,
        CODEX_APPROVAL_POLICY: "never",
        CODEX_SANDBOX_MODE: "read-only",
      });

      expect(result.code).toBe(0);
      expect(result.durationMs).toBeLessThan(4000);

      const payload = JSON.parse(result.stdout) as {
        provider: string;
        text: string;
        timeoutMs: number;
      };

      expect(payload.provider).toBe("codex");
      expect(payload.text).toBe("bench ok");
      expect(payload.timeoutMs).toBe(4000);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces streamed tool events when --stream-events is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "codex-bench-stream-events-"));
    const mockCodexPath = join(tempDir, "codex-mock-stream-events.sh");

    await writeFile(
      mockCodexPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        'echo \'{"type":"thread.started","thread_id":"thread-e2e-stream"}\'',
        'echo \'{"type":"item.started","item":{"id":"cmd_1","type":"command_execution","command":"ls"}}\'',
        'echo \'{"type":"item.completed","item":{"id":"cmd_1","type":"command_execution","command":"ls","aggregated_output":"README.md","exit_code":0,"status":"completed"}}\'',
        'echo \'{"type":"item.completed","item":{"id":"agent_1","type":"agent_message","text":"stream bench ok"}}\'',
        'echo \'{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":1,"output_tokens":2}}\'',
      ].join("\n"),
    );
    await chmod(mockCodexPath, 0o755);

    try {
      const result = await runBenchProcess(
        [
          "--provider",
          "codex",
          "--timeout-ms",
          "4000",
          "--stream-events",
          "Return stream bench ok",
        ],
        {
          CODEX_PATH_OVERRIDE: mockCodexPath,
          CODEX_APPROVAL_POLICY: "never",
          CODEX_SANDBOX_MODE: "read-only",
        },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        text: string;
        streamEventsEnabled: boolean;
        streamEvents: Array<{ type: string }>;
      };

      expect(payload.text).toBe("stream bench ok");
      expect(payload.streamEventsEnabled).toBe(true);
      expect(payload.streamEvents.some((event) => event.type === "tool-call")).toBe(true);
      expect(payload.streamEvents.some((event) => event.type === "tool-result")).toBe(true);
      expect(payload.streamEvents.some((event) => event.type === "tool-error")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails fast when Codex process hangs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "codex-bench-timeout-"));
    const mockCodexPath = join(tempDir, "codex-mock-timeout.sh");

    await writeFile(
      mockCodexPath,
      ["#!/bin/sh", "cat >/dev/null", "while true; do :; done"].join("\n"),
    );
    await chmod(mockCodexPath, 0o755);

    try {
      const result = await runBenchProcess(
        ["--provider", "codex", "--timeout-ms", "150", "This should timeout"],
        {
          CODEX_PATH_OVERRIDE: mockCodexPath,
          CODEX_APPROVAL_POLICY: "never",
          CODEX_SANDBOX_MODE: "read-only",
        },
        3000,
      );

      expect(result.code).toBe(1);
      expect(result.durationMs).toBeLessThan(5000);
      expect(result.stderr).toContain("Bench timed out after 150ms");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  const liveTest = process.env.RUN_CODEX_LIVE_E2E === "1" ? it : it.skip;
  liveTest("can reach real codex sdk in non-interactive mode", async () => {
    const result = await runBenchProcess(
      ["--provider", "codex", "--timeout-ms", "120000", "Reply with: codex-live-ok"],
      {
        CODEX_APPROVAL_POLICY: "never",
        CODEX_SANDBOX_MODE: "read-only",
      },
      130_000,
    );

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { text?: string };
    expect((payload.text ?? "").length).toBeGreaterThan(0);
  });
});

async function runBenchProcess(
  args: string[],
  env: Record<string, string | undefined>,
  hardTimeoutMs = 20_000,
): Promise<ProcessResult> {
  const startedAt = Date.now();

  return await new Promise((resolvePromise, rejectPromise) => {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value != null) {
        childEnv[key] = value;
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (value == null) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }

    const child = spawn("bun", ["src/bench.ts", ...args], {
      cwd: packageRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const hardTimeout = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      rejectPromise(new Error(`bench child process exceeded hard timeout (${hardTimeoutMs}ms)`));
    }, hardTimeoutMs);

    child.on("error", (error) => {
      clearTimeout(hardTimeout);
      rejectPromise(error);
    });

    child.on("close", (code) => {
      clearTimeout(hardTimeout);
      resolvePromise({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
