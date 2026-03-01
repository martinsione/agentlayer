/**
 * Bash tool — execute shell commands with output truncation, timeout, and abort support.
 *
 * Spawns processes directly via child_process (does not go through Runtime).
 * Ported from pi-mono (packages/coding-agent/src/core/tools/bash.ts).
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import type { Tool, ToolContext } from "../types";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate";

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
// Types
// ---------------------------------------------------------------------------

const bashSchema = z.object({
  command: z.string().describe("Bash command to execute"),
  timeout: z.number().optional().describe("Timeout in seconds"),
});

export type BashToolInput = z.infer<typeof bashSchema>;

/** Pluggable operations — override to delegate execution to remote systems (e.g. SSH). */
export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
  /** Custom operations for command execution. Default: local shell. */
  operations?: BashOperations;
  /** Command prefix prepended to every command (e.g. "shopt -s expand_aliases"). */
  commandPrefix?: string;
  /** Hook to adjust command, cwd, or env before execution. */
  spawnHook?: BashSpawnHook;
}

// ---------------------------------------------------------------------------
// Default operations — local shell via child_process.spawn
// ---------------------------------------------------------------------------

const defaultBashOperations: BashOperations = {
  exec: (command, cwd, { onData, signal, timeout, env }) => {
    return new Promise((resolve, reject) => {
      const { shell, args } = getShellConfig();

      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}`));
        return;
      }

      const child = spawn(shell, [...args, command], {
        cwd,
        detached: true,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid) killProcessTree(child.pid);
        }, timeout * 1000);
      }

      if (child.stdout) child.stdout.on("data", onData);
      if (child.stderr) child.stderr.on("data", onData);

      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }
        resolve({ exitCode: code });
      });
    });
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function resolveSpawnContext(
  command: string,
  cwd: string,
  spawnHook?: BashSpawnHook,
): BashSpawnContext {
  const baseContext: BashSpawnContext = { command, cwd, env: { ...process.env } };
  return spawnHook ? spawnHook(baseContext) : baseContext;
}

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `agentlayer-bash-${id}.log`);
}

/**
 * Create a bash tool bound to a specific working directory.
 *
 * The tool spawns processes directly (does not use `ctx.runtime`).
 * Output is tail-truncated; if truncated, full output is saved to a temp file.
 */
export function createBashTool(cwd: string, options?: BashToolOptions): Tool {
  const ops = options?.operations ?? defaultBashOperations;
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;

  return {
    name: "bash",
    description: `Execute a bash command in the working directory. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: z.toJSONSchema(bashSchema, { target: "draft-7" }) as Record<string, unknown>,
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const { command, timeout } = bashSchema.parse(input);
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
      const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

      return new Promise((resolve, reject) => {
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          // Start writing to temp file once we exceed the threshold
          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFilePath();
            tempFileStream = createWriteStream(tempFilePath);
            for (const chunk of chunks) tempFileStream.write(chunk);
          }
          if (tempFileStream) tempFileStream.write(data);

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
        };

        ops
          .exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal: ctx.signal,
            timeout,
            env: spawnContext.env,
          })
          .then(({ exitCode }) => {
            if (tempFileStream) tempFileStream.end();

            const fullBuffer = Buffer.concat(chunks);
            const fullOutput = fullBuffer.toString("utf-8");
            const truncation = truncateTail(fullOutput);
            let outputText = truncation.content || "(no output)";

            if (truncation.truncated) {
              const startLine = truncation.totalLines - truncation.outputLines + 1;
              const endLine = truncation.totalLines;

              if (truncation.lastLinePartial) {
                const lastLineSize = formatSize(
                  Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"),
                );
                outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
              } else if (truncation.truncatedBy === "lines") {
                outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
              } else {
                outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
              }
            }

            if (exitCode !== 0 && exitCode !== null) {
              outputText += `\n\nCommand exited with code ${exitCode}`;
              reject(new Error(outputText));
            } else {
              resolve(outputText);
            }
          })
          .catch((err: Error) => {
            if (tempFileStream) tempFileStream.end();

            const fullBuffer = Buffer.concat(chunks);
            let output = fullBuffer.toString("utf-8");

            if (err.message === "aborted") {
              if (output) output += "\n\n";
              output += "Command aborted";
              reject(new Error(output));
            } else if (err.message.startsWith("timeout:")) {
              const timeoutSecs = err.message.split(":")[1];
              if (output) output += "\n\n";
              output += `Command timed out after ${timeoutSecs} seconds`;
              reject(new Error(output));
            } else {
              reject(err);
            }
          });
      });
    },
  };
}

/** Default bash tool using process.cwd(). */
export const BashTool = createBashTool(process.cwd());
