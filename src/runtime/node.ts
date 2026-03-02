import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RuntimeAbortError, RuntimeTimeoutError } from "../errors";
import type { Runtime, ExecResult, ExecOptions } from "../types";

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Shell utilities
// ---------------------------------------------------------------------------

let cachedShellConfig: { shell: string; args: string[] } | null = null;

function findBashOnPath(): string | null {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && existsSync(firstMatch)) return firstMatch;
      }
    } catch {}
    return null;
  }
  try {
    const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {}
  return null;
}

function getShellConfig(): { shell: string; args: string[] } {
  if (cachedShellConfig) return cachedShellConfig;

  if (process.platform === "win32") {
    const paths: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);

    for (const p of paths) {
      if (existsSync(p)) {
        cachedShellConfig = { shell: p, args: ["-c"] };
        return cachedShellConfig;
      }
    }

    const bashOnPath = findBashOnPath();
    if (bashOnPath) {
      cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
      return cachedShellConfig;
    }
    throw new Error("No bash shell found. Install Git for Windows or add bash to PATH.");
  }

  // Unix: try /bin/bash, then bash on PATH, then fallback to sh
  if (existsSync("/bin/bash")) {
    cachedShellConfig = { shell: "/bin/bash", args: ["-c"] };
    return cachedShellConfig;
  }
  const bashOnPath = findBashOnPath();
  if (bashOnPath) {
    cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
    return cachedShellConfig;
  }
  cachedShellConfig = { shell: "sh", args: ["-c"] };
  return cachedShellConfig;
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// NodeRuntime
// ---------------------------------------------------------------------------

export class NodeRuntime implements Runtime {
  readonly cwd: string;

  constructor(opts?: { cwd?: string }) {
    this.cwd = opts?.cwd ?? process.cwd();
  }

  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const { shell, args } = getShellConfig();
      const cwd = opts?.cwd ?? this.cwd;

      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}`));
        return;
      }

      const child = spawn(shell, [...args, command], {
        cwd,
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;

      const onData = opts?.onData;

      child.stdout.on("data", (data: Buffer) => {
        if (onData) onData(data);
        if (stdoutLen >= MAX_OUTPUT_BYTES) return;
        const remaining = MAX_OUTPUT_BYTES - stdoutLen;
        const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
        if (stdoutLen >= MAX_OUTPUT_BYTES) child.stdout.destroy();
      });

      child.stderr.on("data", (data: Buffer) => {
        if (onData) onData(data);
        if (stderrLen >= MAX_OUTPUT_BYTES) return;
        const remaining = MAX_OUTPUT_BYTES - stderrLen;
        const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
        if (stderrLen >= MAX_OUTPUT_BYTES) child.stderr.destroy();
      });

      // Timeout handling
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeout !== undefined && opts.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) killProcessTree(child.pid);
        }, opts.timeout * 1000);
      }

      // Abort signal handling
      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      if (opts?.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);

        if (opts?.signal?.aborted) {
          reject(new RuntimeAbortError());
          return;
        }
        if (timedOut) {
          reject(new RuntimeTimeoutError(opts!.timeout!));
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }
}
