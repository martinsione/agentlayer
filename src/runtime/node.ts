import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Runtime, ExecResult } from "../types";

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

export class NodeRuntime implements Runtime {
  readonly cwd: string;

  constructor(opts?: { cwd?: string }) {
    this.cwd = opts?.cwd ?? process.cwd();
  }

  exec(
    command: string,
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd: opts?.cwd ?? this.cwd,
        signal: opts?.signal,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;

      child.stdout.on("data", (data: Buffer) => {
        if (stdoutLen >= MAX_OUTPUT_BYTES) return;
        const remaining = MAX_OUTPUT_BYTES - stdoutLen;
        const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
        if (stdoutLen >= MAX_OUTPUT_BYTES) child.stdout.destroy();
      });
      child.stderr.on("data", (data: Buffer) => {
        if (stderrLen >= MAX_OUTPUT_BYTES) return;
        const remaining = MAX_OUTPUT_BYTES - stderrLen;
        const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
        if (stderrLen >= MAX_OUTPUT_BYTES) child.stderr.destroy();
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeout) {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Command timed out after ${opts.timeout}ms`));
        }, opts.timeout);
      }

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
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
